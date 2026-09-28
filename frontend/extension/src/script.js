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
import { buildAnalyzePayload } from "./lib/payload.js";
import { createDebouncedWriter, trimToByteBudget } from "./lib/persistence.js";
import { buildPlaceholder, installStyles } from "./lib/placeholder.js";
import {
  STORAGE_AREAS,
  loadSettings,
  onSettingsChanged,
  readSync,
  writeLocal,
  writeSync,
} from "./lib/settings.js";

import { addTrustedKey } from "./lib/trust.js";
import {
  HIDING_ACTIONS,
  HIDDEN_KEY_WRITE_DEBOUNCE_MS,
  HIDDEN_KEY_WRITE_MAX_WAIT_MS,
  MAX_CACHE_ENTRIES,
  MAX_CONCURRENT_REQUESTS,
  MAX_HIDDEN_KEYS,
  REQUEST_TIMEOUT_MS,
  RESULT_TTL_MS,
  SCROLL_DEBOUNCE_MS,
  STORAGE_KEYS,
  shouldHidePost,
} from "./lib/defaults.js";

const BRAND = "uBlockAI";

/**
 * @type {Map<string, string>} postKey -> original innerHTML
 *
 * Bounded because each entry is a full post's markup, tens of KB. It was a
 * plain Map that was never pruned, so a long scroll session grew without limit
 * even though the result cache beside it was capped.
 */
const originalContent = new LruCache(MAX_CACHE_ENTRIES);

/** @type {LruCache<object>} */
const resultCache = new LruCache(MAX_CACHE_ENTRIES, {
  ttlMs: RESULT_TTL_MS,
  // Release the stored markup when its score ages out. hiddenKeys is
  // deliberately NOT touched here: a post that is currently hidden must never
  // be revealed just because its cached score expired.
  onEvict: (postKey) => {
    originalContent.delete(postKey);
  },
});

/** @type {Set<string>} post keys with an analysis in flight */
const inFlight = new Set();
/** @type {Set<string>} post keys the user asked to trust */
const trustedKeys = new Set();
/** @type {Set<string>} post keys currently hidden */
const hiddenKeys = new Set();

/** Counters are high-churn and not worth syncing. */
const counters = createDebouncedWriter(
  (value) => writeLocal(value, STORAGE_AREAS.LOCAL),
  HIDDEN_KEY_WRITE_DEBOUNCE_MS,
  HIDDEN_KEY_WRITE_MAX_WAIT_MS,
);

/** Hidden keys are written as a whole set, so they need coalescing too. */
const hiddenKeyWriter = createDebouncedWriter(
  (digests) => writeSync({ [STORAGE_KEYS.removedPostKeys]: digests }),
  HIDDEN_KEY_WRITE_DEBOUNCE_MS,
  HIDDEN_KEY_WRITE_MAX_WAIT_MS,
);

let settings = null;
let totalHiddenCount = 0;
let totalAnalyzedCount = 0;
/** @type {Set<string>} compact digests of posts hidden in a previous session */
let hiddenDigests = new Set();
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

  const payload = buildAnalyzePayload(post, postKey);

  try {
    // The service worker reads the backend URL and API key from its own
    // storage, so the content script never carries the secret.
    const result = await sendMessage({
      type: "ANALYZE_POST",
      payload,
      timeoutMs: REQUEST_TIMEOUT_MS,
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
    markSafe(post, result.postKey);
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
    queueHiddenKeyWrite();
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
function markSafe(post, postKey) {
  if (!post.element?.isConnected) return;
  post.element.setAttribute("data-aibot-processed", "true");
  post.element.setAttribute("data-aibot-safe", "true");
  // The key must be recorded on safe posts too. reapplyAll resolves posts by
  // this attribute, so a post without it is permanently locked at its
  // original verdict and moving a slider cannot affect it.
  if (postKey) post.element.dataset.postKey = postKey;
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

  // Persist the decision. It previously lasted only until reload, and the
  // re-hide-on-scroll path ignored the user's thresholds, so a revealed post
  // was re-hidden anyway after the user raised sensitivity.
  const { keys, added } = addTrustedKey(Array.from(trustedKeys), postKey);
  if (added) {
    trustedKeys.clear();
    for (const key of keys) trustedKeys.add(key);
    void persistTrustedKeys();
  }
}

/** Re-hide anything the user revealed, on the next scroll. */
function rehideRevealed() {
  const revealed = document.querySelectorAll("[data-aibot-temp-visible]");
  for (const element of revealed) {
    const postKey = element.dataset.postKey;
    if (!postKey) continue;
    if (trustedKeys.has(postKey)) {
      element.removeAttribute("data-aibot-temp-visible");
      continue;
    }

    const result = resultCache.get(postKey);
    if (!result) continue;

    // Respect the thresholds the user is actually running. This used to
    // re-hide unconditionally.
    if (
      !shouldHidePost(
        result.aiScore,
        result.newsScore,
        settings.aiGeneratedThreshold,
        settings.newsThreshold,
      )
    ) {
      element.removeAttribute("data-aibot-temp-visible");
      continue;
    }

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
      totalHiddenCount = Math.max(0, totalHiddenCount - 1);
      const original = originalContent.get(postKey);
      if (original && element.isConnected) {
        element.innerHTML = original;
        element.removeAttribute("data-aibot-removed");
        element.setAttribute("data-aibot-safe", "true");
      }
      // Persist, or the post is re-hidden on the next reload.
      queueHiddenKeyWrite();
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

  // Seed the in-memory set from the persisted digests, so a post hidden in a
  // previous session is recognised as already hidden rather than counted as a
  // new removal each reload. The digest is recomputed from the live key, so it
  // stays correct if the key derivation changes.
  for (const post of posts) {
    const postKey = stableCacheKey(post);
    if (hiddenKeys.has(postKey)) continue;
    if (hiddenDigests.has(compactStorageKey(postKey))) {
      hiddenKeys.add(postKey);
    }
  }

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
  // Counters are high-churn local state, not settings. Writing them to sync on
  // every batch spent the sync write budget and was semantically wrong: two
  // profiles would race on a synced counter.
  counters.push({
    [STORAGE_KEYS.analyzedCount]: totalAnalyzedCount,
    [STORAGE_KEYS.hiddenCount]: totalHiddenCount,
  });

  pending.forEach((post, index) => {
    const postKey = stableCacheKey(post);
    inFlight.delete(postKey);
    const outcome = results[index];
    if (outcome?.ok) {
      const value = outcome.value;
      // A failed or timed-out analysis is not a result. Caching it would make
      // the post permanently un-analysable, which is the bug the timeout was
      // added to prevent: every later scan would hit the cached failure and
      // never retry.
      if (!value.error) resultCache.set(postKey, value);
      applyResult(post, value);
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
 * Queue a persist of the hidden post keys.
 *
 * The full set was written on every single hide. Each entry is now a compact
 * digest rather than a CDN URL, the list is bounded by count and by serialized
 * byte size, and writes are coalesced so a long session cannot exhaust
 * storage.sync's 120-writes-per-minute allowance.
 */
function queueHiddenKeyWrite() {
  const bounded = Array.from(hiddenKeys).slice(-MAX_HIDDEN_KEYS);
  const compact = bounded.map(compactStorageKey);
  const { values, dropped } = trimToByteBudget(compact);
  if (dropped > 0) {
    console.warn(
      `[${BRAND}] ${dropped} hidden-post keys exceed the storage budget and ` +
        "will be forgotten on reload",
    );
  }
  hiddenKeyWriter.push(values);
}

/** Persist the user's "show anyway" decisions. */
async function persistTrustedKeys() {
  const result = await writeSync({ [STORAGE_KEYS.trustedKeys]: Array.from(trustedKeys) });
  if (!result.ok) {
    console.warn(`[${BRAND}] could not persist trusted keys: ${result.error}`);
  }
}

/**
 * Load the persisted hidden-key digests.
 *
 * The result is a lookup set, not a post list. It is consulted during the scan
 * once results come back, because restoring the set beforehand matched nothing:
 * the result cache was empty at that point, so every stored digest was
 * discarded and previously hidden posts were re-analysed and re-hidden from
 * scratch.
 *
 * @returns {Promise<Set<string>>}
 */
async function loadHiddenDigests() {
  const data = await readSync([STORAGE_KEYS.removedPostKeys]);
  const stored = data[STORAGE_KEYS.removedPostKeys];
  return new Set(Array.isArray(stored) ? stored : []);
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
//
// The listener is filtered to the keys that actually matter. Previously it
// fired for every write in every namespace, including this script's own counter
// writes, which turned a single hide into a write -> change -> reapplyAll ->
// write cycle.
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

  hiddenDigests = await loadHiddenDigests();
  observe();
  await scan();
  void counters.flush();
}

void start();

export { BRAND, queryWithFallback };
