/**
 * uBlockAI content script.
 *
 * Scans the page for posts, analyses each one through the backend, and hides
 * the ones that trip a threshold. This file is the orchestrator only: platform
 * knowledge lives in adapters/, and everything reusable lives in lib/.
 */

import { adapterForUrl, collectPosts, queryWithFallback } from "./adapters/index.js";
import { LruCache, compactStorageKey, stableCacheKey } from "./lib/cache.js";
import { coerceCount, recordHide, recordUnhide, restoreCounts } from "./lib/counters.js";
import { runBounded, withTimeout } from "./lib/concurrency.js";
import { REPORT_KINDS, queueReport, readReportedKeys } from "./lib/feedback.js";
import { buildAnalyzePayload } from "./lib/payload.js";
import { createDebouncedWriter, trimToByteBudget } from "./lib/persistence.js";
import { isCurrentPost, registerPost, resolvePostElement } from "./lib/dommap.js";
import { logDebug, logError, setDebug } from "./lib/logging.js";
import { clearFailure, recordFailure, shouldSkip } from "./lib/retry.js";
import { TELEMETRY_METRICS, recordCounts } from "./lib/telemetry.js";
import {
  announce,
  installStyles,
  markPost,
  mountPlaceholder,
  mountReportControl,
} from "./lib/placeholder.js";
import { t } from "./lib/i18n.js";
import {
  STORAGE_AREAS,
  loadSettings,
  onSettingsChanged,
  readLocal,
  readSync,
  writeLocal,
  writeSync,
} from "./lib/settings.js";

import { addTrustedKey } from "./lib/trust.js";
import { prefilterPosts } from "./lib/prefilter.js";
import {
  STAGES,
  applyStage,
  buildProgressPanel,
  fallbackStages,
  initialProgress,
} from "./lib/progress.js";
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
/** @type {Map<string, () => void>} postKey -> cancel function for the live stream */
const activeStreams = new Map();
/** @type {Set<string>} post keys the user asked to trust */
const trustedKeys = new Set();
/** @type {Set<string>} post keys currently hidden */
const hiddenKeys = new Set();
/**
 * @type {Set<string>} `kind:postKey` pairs the user has already reported.
 *
 * Kept in memory and seeded from the persisted queues at startup, so a report
 * survives a reload and the control comes back disabled rather than offering
 * the same post again. lib/feedback.js also dedupes on write; this is what
 * keeps the UI honest between writes.
 */
const reportedKeys = new Set();

/** Counters are high-churn local state kept in storage.local, not sync. */
const counterWriter = createDebouncedWriter(
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
/** @type {Record<string, {attempts: number, nextAt: number}>} retry backoff */
let retryState = {};
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
 * Analyse one post over the streaming port, reporting progress as it arrives.
 *
 * The service worker owns the network and the API key, so progress is relayed
 * over a long-lived Port rather than fetched here: a content script cannot read
 * a cross-origin response body at all.
 *
 * @param {object} post
 * @param {string} postKey
 * @param {(state: object) => void} onProgress
 * @returns {Promise<{result: object|null, error: boolean, cancelled: boolean}>}
 */
function analysePostStreaming(post, postKey, onProgress) {
  const payload = buildAnalyzePayload(post, postKey);

  return new Promise((resolve) => {
    let port;
    let state = initialProgress();
    let settled = false;

    // Whatever the outcome, exactly one terminal message arrives and this
    // disconnect is what stops the worker from holding a paid request open.
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      try {
        port?.disconnect();
      } catch {
        // Already gone.
      }
      resolve(outcome);
    };

    try {
      port = chrome.runtime.connect({ name: "aibot-analysis" });
    } catch (error) {
      // No service worker (extension reloading, for example). Fall back to
      // the one-shot request rather than failing the post silently.
      logError("analyze", "streaming port unavailable", { error: error.message });
      void sendMessage({ type: "ANALYZE_POST", payload, timeoutMs: REQUEST_TIMEOUT_MS })
        .then((result) => resolve({ result, error: false, cancelled: false }))
        .catch(() => resolve({ result: null, error: true, cancelled: false }));
      return;
    }

    onProgress(state);

    port.onMessage.addListener((msg) => {
      if (msg?.type === "progress") {
        state = applyStage(state, msg.event);
        onProgress(state);
        return;
      }
      if (msg?.type === "result") {
        finish({ result: msg.result, error: false, cancelled: false });
        return;
      }
      if (msg?.type === "error") {
        logError("analyze", "analysis failed", { postKey, error: msg.error });
        finish({ result: null, error: true, cancelled: false });
      }
    });

    // The port closed without a terminal message: the worker was torn down or
    // the extension reloaded. Treated as a failure so the post is retried with
    // backoff rather than left unprocessed forever.
    port.onDisconnect.addListener(() => {
      if (!settled) {
        state = applyStage(state, {
          stage: STAGES.ERROR,
          message: "The analysis connection closed unexpectedly.",
        });
        onProgress(state);
        finish({ result: null, error: true, cancelled: false });
      }
    });

    port.postMessage({
      type: "analyze",
      payload,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    // Cancel hook: disconnecting the port is what aborts the fetch in the
    // worker, so a cancelled analysis stops costing money immediately rather
    // than running to completion for a result nobody will read.
    activeStreams.set(postKey, () => {
      state = applyStage(state, { stage: STAGES.ERROR, message: "Analysis stopped." });
      onProgress(state);
      finish({ result: null, error: true, cancelled: true });
    });
  });
}

/**
 * Read the optional per-claim score array off a backend response.
 *
 * A spread of `[result.claim_scores, result.claims]` guards against `null`
 * winning a `??` chain: an explicit `"claim_scores": null` with a populated
 * `claims` would otherwise null out the fallback. Entries are kept as opaque
 * objects and shaped by claim-scores.js, so a schema addition there needs no
 * change here.
 *
 * @param {object} result
 * @returns {object[]}
 */
function normalizeClaimArray(result) {
  for (const key of ["claim_scores", "claims"]) {
    const value = result?.[key];
    if (Array.isArray(value)) return value.slice(0, 10);
  }
  return [];
}

/**
 * Show (or update) the in-place progress panel for a post.
 *
 * The panel replaces the post's content while the analysis runs, then the
 * caller either swaps in the verdict placeholder or restores the original.
 * Re-resolving by post key each time, for the same reason hidePost does: a
 * virtualised feed recycles nodes and the captured element may now hold a
 * different post.
 *
 * @param {object} post
 * @param {string} postKey
 * @param {object} state progress state
 * @param {boolean} [fallback] render the non-streaming wording
 */
function renderProgress(post, postKey, state, fallback = false) {
  const element =
    resolvePostElement(postKey) || (post.element?.isConnected ? post.element : null);
  if (!element || !isCurrentPost(element, postKey)) return;
  if (element.querySelector(".aibot-placeholder")) return;

  if (!originalContent.has(postKey)) {
    originalContent.set(postKey, element.innerHTML);
  }

  const panel = buildProgressPanel(state, {
    postKey,
    stages: fallback ? fallbackStages : undefined,
    onCancel: () => activeStreams.get(postKey)?.(),
  });
  element.replaceChildren(panel);
  markPost(element, { postKey, state: "none" });
}

/**
 * Restore a post's content after an analysis that produced no verdict.
 * @param {object} post
 * @param {string} postKey
 */
function clearProgress(post, postKey) {
  const element =
    resolvePostElement(postKey) || (post.element?.isConnected ? post.element : null);
  if (!element) return;
  if (element.querySelector(".aibot-progress")) {
    const original = originalContent.get(postKey);
    if (original) element.innerHTML = original;
  }
  element.removeAttribute("data-aibot-processed");
  markPost(element, { postKey, state: "none" });
}

/**
 * Analyse one post, with a hard timeout and a conservative fallback.
 * @param {object} post
 * @returns {Promise<object>} a result record; never rejects
 */
async function analysePost(post) {
  const postKey = stableCacheKey(post);
  if (!postKey) return { postKey: "", error: true };

  // The service worker reads the backend URL and API key from its own storage,
  // so the content script never carries the secret. Progress comes back over
  // the same port; if the worker cannot stream, it falls back to the plain
  // JSON request internally and the panel shows the non-streaming wording.
  const outcome = await analysePostStreaming(post, postKey, (state) => {
    const fallback = state.seen.length <= 1 && state.seen[0] === STAGES.RECEIVED;
    renderProgress(post, postKey, state, fallback);
  });

  activeStreams.delete(postKey);

  if (outcome.cancelled) {
    clearProgress(post, postKey);
    return { postKey, aiScore: 0, newsScore: 0, explanation: "", error: true };
  }

  if (outcome.error || !outcome.result) {
    // Never hide on failure. Hiding a legitimate post because the backend was
    // unreachable is worse than showing misinformation once.
    logError("analyze", "request failed", { postKey });
    clearProgress(post, postKey);
    return { postKey, aiScore: 0, newsScore: 0, explanation: "", error: true };
  }

  const result = outcome.result;
  const aiScore = Number(result?.ai_generated_risk_score ?? 0);
  const newsScore = Number(result?.misinformation_risk_score ?? 0);

  // Scores are cached, not the hide decision. Caching the decision meant a
  // slider change had no effect on posts already in the cache: the entry
  // still said shouldHide true or false, so re-filtering was impossible.
  // The verdict, reasoning chain, evidence and uncertainties are passed
  // through untouched for the explanation detail view (#79); they are
  // display-only and never influence the hide decision.
  clearProgress(post, postKey);
  return {
    postKey,
    aiScore,
    newsScore,
    explanation: String(result?.explanation || ""),
    verdict: result?.verdict || null,
    confidence:
      result?.confidence === null || result?.confidence === undefined
        ? null
        : Number(result.confidence),
    reasoning_chain: Array.isArray(result?.reasoning_chain)
      ? result.reasoning_chain.map(String).slice(0, 20)
      : [],
    evidence: Array.isArray(result?.evidence) ? result.evidence.slice(0, 20) : [],
    uncertainties: Array.isArray(result?.uncertainties)
      ? result.uncertainties.map(String).slice(0, 20)
      : [],
    tool_rounds: Number(result?.tool_rounds ?? 0) || 0,
    // Claim-level scores (#86). AgentOutput has no per-claim field today, so
    // this is normally an empty array and the detail view omits the section.
    // It is carried through rather than dropped so the UI lights up the
    // moment the backend starts returning it, with no extension change.
    claim_scores: normalizeClaimArray(result),
    error: false,
  };
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
  const postKey = result.postKey;
  if (!postKey) return;

  // Re-resolve by stable key rather than trusting the reference captured when
  // the analysis started. A virtualised feed reuses connected nodes, so the
  // captured element may now be a different post entirely; hiding that one
  // would be worse than hiding nothing.
  const element =
    resolvePostElement(postKey) || (post.element?.isConnected ? post.element : null);
  if (!element || !isCurrentPost(element, postKey)) return;
  if (element.querySelector(".aibot-placeholder")) return;

  if (!originalContent.has(postKey)) {
    originalContent.set(postKey, element.innerHTML);
  }

  const action =
    settings.hidingAction === HIDING_ACTIONS.REMOVE
      ? HIDING_ACTIONS.REMOVE
      : settings.hidingAction || HIDING_ACTIONS.PLACEHOLDER;

  if (action === HIDING_ACTIONS.REMOVE) {
    element.remove();
    announce(t("placeholderPanelLabel", [BRAND]));
  } else {
    // Was the user interacting with this post? If so their focus is about to be
    // destroyed by replaceChildren, and the panel has to take it. If not,
    // taking it would be a focus steal.
    const hadFocus = element.contains(document.activeElement);
    const placeholder = mountPlaceholder(
      {
        postKey,
        explanation: result.explanation,
        aiScore: result.aiScore,
        newsScore: result.newsScore,
        verdict: result.verdict || "",
        confidence: result.confidence ?? null,
        reasoning_chain: result.reasoning_chain || [],
        evidence: result.evidence || [],
        uncertainties: result.uncertainties || [],
        claim_scores: result.claim_scores || [],
        imageUrl: post.imageUrl || "",
        videoUrl: post.videoUrl || "",
        videoThumb: post.videoThumb || "",
        fontScale: settings.fontScale,
        action,
        // Re-mounting a placeholder after a settings change must not offer to
        // report the same mistake again.
        reported: reportedKeys.has(`${REPORT_KINDS.FALSE_POSITIVE}:${postKey}`),
      },
      {
        onReveal: () => revealPost(post, postKey),
        onReport: () => reportPost(post, postKey, REPORT_KINDS.FALSE_POSITIVE),
        hadFocus,
      },
    );
    if (placeholder) {
      // Announced rather than focused: a screen reader user scrolling the feed
      // must be told a post was hidden without being dragged out of the feed.
      announce(t("placeholderPanelLabel", [BRAND]));
      element.replaceChildren(placeholder);
    }
  }

  markPost(element, { postKey, state: "hidden" });

  // The lifetime total moves only here, on an explicit hide transition.
  // It must never be assigned from a DOM query: nodes come and go as the feed
  // re-renders, so the DOM-present count is a different quantity.
  const transition = recordHide(hiddenKeys, totalHiddenCount, postKey);
  totalHiddenCount = transition.lifetime;
  if (transition.added) {
    queueHiddenKeyWrite();
    void recordCounts({ [TELEMETRY_METRICS.HIDDEN]: 1 });
  }
}

/**
 * @param {object} post
 */
function markSafe(post, postKey) {
  const element = resolvePostElement(postKey) || post.element;
  if (!element) return;
  // The key must be recorded on safe posts too. reapplyAll resolves posts by
  // this attribute, so a post without it is permanently locked at its
  // original verdict and moving a slider cannot affect it.
  markPost(element, { postKey, state: "safe" });
  // A post that was let through is still eligible to be reported: the user may
  // know it is misinformation even though it scored below both thresholds.
  mountReportControl(element, postKey, {
    reported: reportedKeys.has(`${REPORT_KINDS.FALSE_NEGATIVE}:${postKey}`),
    onReport: () => reportPost(post, postKey, REPORT_KINDS.FALSE_NEGATIVE),
  });
}

/**
 * Record a report against a post, from either direction.
 *
 * @param {object} post
 * @param {string} postKey
 * @param {string} kind one of REPORT_KINDS
 */
function reportPost(post, postKey, kind) {
  const marker = `${kind}:${postKey}`;
  if (reportedKeys.has(marker)) return;
  // Marked before the write lands, not after: the button must not be
  // double-clickable while a storage write is in flight.
  reportedKeys.add(marker);

  void queueReport({
    postKey,
    kind,
    imageUrl: post.imageUrl || "",
    caption: post.caption || "",
  }).then(({ queued }) => {
    if (queued) {
      // A count, not the report. Nothing about the post leaves the device here.
      void recordCounts({ [TELEMETRY_METRICS.REPORTED]: 1 });
      return;
    }
    // Already in the persisted queue: keep the UI consistent with storage.
    logDebug("feedback", `duplicate ${kind} report ignored`);
  });
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

  // Replacing the children drops anything the report flow appended.
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

  // Restoring innerHTML destroys whatever was focused inside the panel, so
  // focus lands on the post container and the live region says what happened.
  // A reveal reached by Escape used to drop focus onto <body> silently.
  if (!element.hasAttribute("tabindex")) {
    element.setAttribute("tabindex", "-1");
  }
  element.focus();
  announce(t("placeholderShownLive", [BRAND]));
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
    if (!isCurrentPost(element, postKey)) continue;

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

    const placeholder = mountPlaceholder(
      {
        postKey,
        explanation: result.explanation,
        aiScore: result.aiScore,
        newsScore: result.newsScore,
        verdict: result.verdict || "",
        confidence: result.confidence ?? null,
        reasoning_chain: result.reasoning_chain || [],
        evidence: result.evidence || [],
        uncertainties: result.uncertainties || [],
        claim_scores: result.claim_scores || [],
        action: settings.hidingAction,
        reported: reportedKeys.has(`${REPORT_KINDS.FALSE_POSITIVE}:${postKey}`),
      },
      {
        onReveal: () => revealPost({ element }, postKey),
        // Without this the "Report mistake" button on a re-hidden post is
        // inert: the listener is only attached when a handler is supplied.
        onReport: () =>
          reportPost({ imageUrl: "", caption: "" }, postKey, REPORT_KINDS.FALSE_POSITIVE),
      },
    );
    if (placeholder) element.replaceChildren(placeholder);
    markPost(element, { postKey, state: "hidden" });
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
    // Re-verify against the authoritative binding. dataset is page-controlled:
    // a content script's isolated world shares the DOM, so any attribute can
    // be forged by the page and must not be trusted on its own.
    if (!isCurrentPost(element, postKey)) continue;
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

    if (shouldHide) {
      // Membership of hiddenKeys is not a reliable "is this post currently
      // hidden" test: a post the user revealed with "Show post anyway" stays in
      // the set, so testing it here meant removing a post from the options-page
      // trust list did nothing until the next reload. What is on screen is the
      // thing to look at instead.
      if (!element.querySelector(".aibot-placeholder")) {
        hidePost({ element, imageUrl: null, caption: "" }, result);
      }
    } else if (hiddenKeys.has(postKey)) {
      const transition = recordUnhide(hiddenKeys, totalHiddenCount, postKey);
      totalHiddenCount = transition.lifetime;
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
    if (!post.imageUrl && !post.videoUrl && !post.caption) return false;
    const postKey = stableCacheKey(post);
    if (!postKey) return false;
    if (trustedKeys.has(postKey)) return false;
    // A failed analysis is not cached, so without backoff it would be retried
    // on every scan and a backend outage becomes a request storm.
    if (shouldSkip(retryState, postKey)) return false;
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

  // Cheap client-side pre-filter (#66), run before anything enters inFlight or
  // analysePost. A skipped post is marked processed so the next scan does not
  // re-evaluate it: the cost of the pre-filter has to be one-time, otherwise
  // re-running it every scroll costs more than it saves.
  //
  // A skipped post is marked SAFE, not "processed with no verdict". That is a
  // real statement - nothing to check was found - so the post stays visible and
  // a later threshold change still applies to everything else normally.
  const { keep, skipped } = prefilterPosts(posts, { trustedKeys });
  if (skipped.length > 0) {
    for (const { post, reason } of skipped) {
      const postKey = stableCacheKey(post);
      if (!postKey) continue;
      logDebug("prefilter", `skipped ${reason}`, { postKey });
      markSafe(post, postKey);
    }
  }

  for (const post of keep) {
    const postKey = stableCacheKey(post);
    const cached = resultCache.get(postKey);
    if (cached) {
      applyResult(post, cached);
      continue;
    }
    if (inFlight.has(postKey)) continue;
    // Bind the key to the element now, before any async work. The binding is
    // what lets us prove at mutation time that the element still holds this
    // post rather than a recycled one.
    registerPost(post.element, postKey);
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
  counterWriter.push({
    [STORAGE_KEYS.analyzedCount]: totalAnalyzedCount,
    [STORAGE_KEYS.hiddenCount]: totalHiddenCount,
  });
  void recordCounts({ [TELEMETRY_METRICS.ANALYZED]: pending.length });

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
      if (value.error) {
        const { state, attempts, giveUp } = recordFailure(retryState, postKey);
        retryState = state;
        if (giveUp)
          logDebug("analyze", `giving up on ${postKey} after ${attempts} attempts`);
      } else {
        retryState = clearFailure(retryState, postKey);
        resultCache.set(postKey, value);
      }
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
    logError("persist", "hidden-post keys exceed the storage budget", { dropped });
  }
  hiddenKeyWriter.push(values);
}

/** Persist the user's "show anyway" decisions. */
async function persistTrustedKeys() {
  const result = await writeSync({ [STORAGE_KEYS.trustedKeys]: Array.from(trustedKeys) });
  if (!result.ok) {
    logError("persist", "could not persist trusted keys", { error: result.error });
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
  // The observer only schedules a scan. It must never read the DOM to assign
  // the persisted lifetime hiddenCount: the DOM-present count drops whenever
  // the feed re-renders, while the lifetime total must survive mutations.
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
  setDebug(next.debugLogging === true);
  trustedKeys.clear();
  for (const key of next.trustedKeys) trustedKeys.add(key);
  reapplyAll();
});

async function start() {
  settings = await loadSettings();
  trustedKeys.clear();
  for (const key of settings.trustedKeys) trustedKeys.add(key);

  for (const marker of await readReportedKeys()) reportedKeys.add(marker);

  const stored = await readLocal([STORAGE_KEYS.hiddenCount, STORAGE_KEYS.analyzedCount]);
  const restored = restoreCounts(
    stored,
    STORAGE_KEYS.hiddenCount,
    STORAGE_KEYS.analyzedCount,
  );
  totalHiddenCount = coerceCount(restored.hidden);
  totalAnalyzedCount = coerceCount(restored.analyzed);

  setDebug(settings.debugLogging === true);
  hiddenDigests = await loadHiddenDigests();
  observe();
  await scan();
  void counterWriter.flush();
}

void start();

export { BRAND, queryWithFallback };
