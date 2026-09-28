/**
 * uBlockAI content script.
 *
 * Scans the page for posts, analyses each one through the backend, and hides
 * the ones that trip a threshold. This file is the orchestrator only: platform
 * knowledge lives in adapters/, and everything reusable lives in lib/.
 */

import { adapterForUrl, collectPosts, queryWithFallback } from "./adapters/index.js";
import { LruCache, compactStorageKey, stableCacheKey } from "./lib/cache.js";
import { runBounded, withTimeout } from "./lib/concurrency.js";
import { queueReport } from "./lib/feedback.js";
import { buildPlaceholder, installStyles } from "./lib/placeholder.js";
import { loadSettings, onSettingsChanged, readSync, writeSync } from "./lib/settings.js";
import {
  HIDING_ACTIONS,
  MAX_CACHE_ENTRIES,
  MAX_CONCURRENT_REQUESTS,
  REQUEST_TIMEOUT_MS,
  SCROLL_DEBOUNCE_MS,
  STORAGE_KEYS,
  shouldHidePost,
} from "./lib/defaults.js";

const BRAND = "uBlockAI";

/** @type {LruCache<object>} */
const resultCache = new LruCache(MAX_CACHE_ENTRIES);
/** @type {Map<string, string>} postKey -> original innerHTML */
const originalContent = new Map();
/** @type {Set<string>} post keys with an analysis in flight */
const inFlight = new Set();
/** @type {Set<string>} post keys the user asked to trust */
const trustedKeys = new Set();
/** @type {Set<string>} post keys currently hidden */
const hiddenKeys = new Set();

let settings = null;
let totalHiddenCount = 0;
let totalAnalyzedCount = 0;
let scrollTimer = null;
let scanScheduled = false;

const adapter = adapterForUrl(location.href);

installStyles();

// --------------------------------------------------------------------------
// Messaging
// --------------------------------------------------------------------------

/**
 * Send a message to the service worker and await its response.
 * @param {object} message
 * @returns {Promise<any>}
 */
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(String(lastError.message || lastError)));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Unknown error"));
        return;
      }
      resolve(response.result);
    });
  });
}

/**
 * Analyse one post, with a hard timeout and a conservative fallback.
 * @param {object} post
 * @returns {Promise<object>} a result record; never rejects
 */
async function analysePost(post) {
  const postKey = stableCacheKey(post);
  if (!postKey) return { postKey: "", error: true };

  const payload = {
    post_key: postKey,
    url: post.imageUrl,
    caption: post.caption || "",
    alt_text: post.imageAlt || "",
    metadata: post.permalink ? { permalink: post.permalink } : {},
    is_video: Boolean(post.isVideo),
  };

  try {
    const result = await sendMessage({
      type: "ANALYZE_POST",
      payload,
      settings: {
        backendUrl: settings.backendUrl,
        apiKey: settings.apiKey,
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
    });

    const aiScore = Number(result?.ai_generated_risk_score ?? 0);
    const newsScore = Number(result?.misinformation_risk_score ?? 0);

    // Scores are cached, not the hide decision. Caching the decision meant a
    // slider change had no effect on posts already in the cache: the entry
    // still said shouldHide true or false, so re-filtering was impossible.
    return {
      postKey,
      aiScore,
      newsScore,
      explanation: String(result?.explanation || ""),
      verdict: result?.verdict || null,
      error: false,
    };
  } catch (error) {
    // Never hide on failure. Hiding a legitimate post because the backend was
    // unreachable is worse than showing misinformation once.
    console.warn(`[${BRAND}] analysis failed for ${postKey}: ${error.message}`);
    return { postKey, aiScore: 0, newsScore: 0, explanation: "", error: true };
  }
}

// --------------------------------------------------------------------------
// Hiding
// --------------------------------------------------------------------------

/**
 * Apply the current thresholds to a cached result and hide if warranted.
 * @param {object} post
 * @param {object} result
 */
function applyResult(post, result) {
  if (!result || result.error) return;

  if (trustedKeys.has(result.postKey)) return;

  const shouldHide = shouldHidePost(
    result.aiScore,
    result.newsScore,
    settings.aiGeneratedThreshold,
    settings.newsThreshold,
  );

  if (shouldHide) {
    hidePost(post, result);
  } else if (result.postKey && !hiddenKeys.has(result.postKey)) {
    markSafe(post);
  }
}

/**
 * Replace a post's content with the placeholder.
 * @param {object} post
 * @param {object} result
 */
function hidePost(post, result) {
  const { element } = post;
  if (!element || !element.isConnected) return;
  if (element.querySelector(".aibot-placeholder")) return;

  const postKey = result.postKey;
  if (!postKey) return;

  if (!originalContent.has(postKey)) {
    originalContent.set(postKey, element.innerHTML);
  }

  const action =
    settings.hidingAction === HIDING_ACTIONS.REMOVE
      ? HIDING_ACTIONS.REMOVE
      : settings.hidingAction || HIDING_ACTIONS.PLACEHOLDER;

  if (action === HIDING_ACTIONS.REMOVE) {
    element.remove();
  } else {
    const placeholder = buildPlaceholder({
      postKey,
      explanation: result.explanation,
      aiScore: result.aiScore,
      newsScore: result.newsScore,
      action,
    });
    if (placeholder) {
      element.replaceChildren(placeholder);
      attachListeners(placeholder, post, result);
    }
  }

  element.setAttribute("data-aibot-processed", "true");
  element.setAttribute("data-aibot-removed", "true");
  element.dataset.postKey = postKey;

  if (!hiddenKeys.has(postKey)) {
    hiddenKeys.add(postKey);
    totalHiddenCount += 1;
    persistHiddenKeys();
  }
}

/**
 * @param {HTMLElement} placeholder
 * @param {object} post
 * @param {object} result
 */
function attachListeners(placeholder, post, result) {
  const showButton = placeholder.querySelector(".aibot-show-btn");
  if (showButton) {
    // Listeners are attached programmatically. Inline onmouseover/onmouseout
    // attributes are blocked by the page's Content Security Policy, so the
    // hover styling never applied.
    showButton.addEventListener("click", (event) => {
      event.stopPropagation();
      revealPost(post, result.postKey);
    });
  }

  const reportButton = placeholder.querySelector(".aibot-report-fp");
  if (reportButton) {
    reportButton.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      queueReport({
        postKey: result.postKey,
        kind: "falsePositive",
        imageUrl: post.imageUrl || "",
        caption: post.caption || "",
      });
      reportButton.textContent = "Reported";
      reportButton.disabled = true;
    });
  }
}

/**
 * @param {object} post
 */
function markSafe(post) {
  if (!post.element?.isConnected) return;
  post.element.setAttribute("data-aibot-processed", "true");
  post.element.setAttribute("data-aibot-safe", "true");
}

/**
 * Restore a hidden post temporarily.
 * @param {object} post
 * @param {string} postKey
 */
function revealPost(post, postKey) {
  const { element } = post;
  const original = originalContent.get(postKey);
  if (!element || !original) return;

  element.innerHTML = original;
  element.removeAttribute("data-aibot-removed");
  element.setAttribute("data-aibot-temp-visible", "true");
}

/** Re-hide anything the user revealed, on the next scroll. */
function rehideRevealed() {
  const revealed = document.querySelectorAll("[data-aibot-temp-visible]");
  for (const element of revealed) {
    const postKey = element.dataset.postKey;
    if (!postKey) continue;
    const result = resultCache.get(postKey);
    if (!result) continue;

    const placeholder = buildPlaceholder({
      postKey,
      explanation: result.explanation,
      aiScore: result.aiScore,
      newsScore: result.newsScore,
      action: settings.hidingAction,
    });
    if (placeholder) {
      element.replaceChildren(placeholder);
      attachListeners(placeholder, { element, imageUrl: null, caption: "" }, result);
    }
    element.setAttribute("data-aibot-removed", "true");
    element.removeAttribute("data-aibot-temp-visible");
  }
}

// --------------------------------------------------------------------------
// Scanning
// --------------------------------------------------------------------------

/**
 * Re-apply the current thresholds to every post already analysed.
 *
 * Moving a slider previously called processPosts(), which skipped posts whose
 * result was already cached, so nothing visibly changed. Caching scores rather
 * than decisions is what makes this possible.
 */
function reapplyAll() {
  for (const element of document.querySelectorAll("[data-aibot-processed]")) {
    const postKey = element.dataset.postKey;
    if (!postKey) continue;
    const result = resultCache.get(postKey);
    if (!result) continue;

    if (trustedKeys.has(postKey)) {
      revealPost({ element }, postKey);
      continue;
    }

    const shouldHide = shouldHidePost(
      result.aiScore,
      result.newsScore,
      settings.aiGeneratedThreshold,
      settings.newsThreshold,
    );

    if (shouldHide && !hiddenKeys.has(postKey)) {
      hidePost({ element, imageUrl: null, caption: "" }, result);
    } else if (!shouldHide && hiddenKeys.has(postKey)) {
      hiddenKeys.delete(postKey);
      const original = originalContent.get(postKey);
      if (original && element.isConnected) {
        element.innerHTML = original;
        element.removeAttribute("data-aibot-removed");
        element.setAttribute("data-aibot-safe", "true");
      }
    }
  }
}

async function scan() {
  if (!settings) return;

  const posts = collectPosts(adapter, document).filter((post) => {
    if (!post.imageUrl && !post.caption) return false;
    const postKey = stableCacheKey(post);
    if (!postKey) return false;
    if (trustedKeys.has(postKey)) return false;
    return !post.element.hasAttribute("data-aibot-processed");
  });

  if (posts.length === 0) return;

  // Everything already known, applied without a network call.
  const pending = [];
  for (const post of posts) {
    const postKey = stableCacheKey(post);
    const cached = resultCache.get(postKey);
    if (cached) {
      applyResult(post, cached);
      continue;
    }
    if (inFlight.has(postKey)) continue;
    inFlight.add(postKey);
    pending.push(post);
  }

  if (pending.length === 0) return;

  // Bounded parallelism: several posts analysed at once, capped so we do not
  // open an unbounded number of expensive backend requests.
  const results = await runBounded(
    pending.map(
      (post) => () =>
        withTimeout(() => analysePost(post), REQUEST_TIMEOUT_MS, "analysis"),
    ),
    MAX_CONCURRENT_REQUESTS,
  );

  totalAnalyzedCount += pending.length;
  void writeSync({
    [STORAGE_KEYS.analyzedCount]: totalAnalyzedCount,
    [STORAGE_KEYS.hiddenCount]: totalHiddenCount,
  });

  pending.forEach((post, index) => {
    const postKey = stableCacheKey(post);
    inFlight.delete(postKey);
    const outcome = results[index];
    if (outcome?.ok) {
      resultCache.set(postKey, outcome.value);
      applyResult(post, outcome.value);
    }
  });
}

/** Coalesce bursts of mutations into a single scan. */
function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  setTimeout(() => {
    scanScheduled = false;
    void scan();
  }, 50);
}

// --------------------------------------------------------------------------
// Persisted hidden keys
// --------------------------------------------------------------------------

/**
 * Persist the set of hidden post keys.
 *
 * The full set of CDN URLs was written on every change. Each URL runs to
 * several hundred characters, so the write quickly exceeded the 8 KB per-item
 * cap, the write failed, and the error was ignored. Only compact digests are
 * stored now, and the result is reported.
 */
async function persistHiddenKeys() {
  const compact = Array.from(hiddenKeys).map(compactStorageKey);
  const result = await writeSync({ [STORAGE_KEYS.removedPostKeys]: compact });
  if (!result.ok) {
    console.warn(
      `[${BRAND}] could not persist hidden post keys: ${result.error}. ` +
        "They will be forgotten on reload.",
    );
  }
}

async function restoreHiddenKeys() {
  const data = await readSync([STORAGE_KEYS.removedPostKeys]);
  const stored = data[STORAGE_KEYS.removedPostKeys];
  if (!Array.isArray(stored)) return;
  const digest = new Set(stored);
  // Rebuild the hidden set from the stored digests so posts re-hidden on reload
  // are not re-analysed.
  for (const postKey of resultCache.keys()) {
    if (digest.has(compactStorageKey(postKey))) hiddenKeys.add(postKey);
  }
}

// --------------------------------------------------------------------------
// Observation
// --------------------------------------------------------------------------

const observer = new MutationObserver((mutations) => {
  let sawPost = false;
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.tagName === "ARTICLE") {
        sawPost = true;
      } else if (node.querySelectorAll) {
        if (node.querySelectorAll(adapter.postSelectors[0]).length > 0) sawPost = true;
      }
    }
  }
  if (sawPost) scheduleScan();
});

function observe() {
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

window.addEventListener("scroll", () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    rehideRevealed();
    void scan();
  }, SCROLL_DEBOUNCE_MS);
});

// A threshold change re-applies to known results rather than re-requesting.
onSettingsChanged((next) => {
  settings = next;
  trustedKeys.clear();
  for (const key of next.trustedKeys) trustedKeys.add(key);
  reapplyAll();
});

async function start() {
  settings = await loadSettings();
  trustedKeys.clear();
  for (const key of settings.trustedKeys) trustedKeys.add(key);

  const counters = await readSync([STORAGE_KEYS.hiddenCount, STORAGE_KEYS.analyzedCount]);
  totalHiddenCount = Number(counters[STORAGE_KEYS.hiddenCount] ?? 0) || 0;
  totalAnalyzedCount = Number(counters[STORAGE_KEYS.analyzedCount] ?? 0) || 0;

  await restoreHiddenKeys();
  observe();
  await scan();
}

void start();

export { BRAND, queryWithFallback };
