/**
 * Offline mode (#88): route a post to the on-device classifier or to the
 * backend, and shape a local verdict into the record the rest of the content
 * script already understands.
 *
 * The decision is a pure function on purpose. "Should this post go to the
 * backend?" is the single most consequential branch in the extension - get it
 * wrong in one direction and misinformation reaches the screen, in the other
 * and a legitimate post disappears - so it is separated from the I/O and tested
 * as a table rather than exercised through a scan.
 *
 * Two requirements pull against each other here, and the resolution is worth
 * stating plainly:
 *
 *   - "The content script must fail open: if the classifier throws or is not
 *     ready, fall through to the normal backend path."
 *   - "If the user is offline and the backend is unreachable, the existing retry
 *     logic must not thrash."
 *
 * Both hold. A local failure is a *local* condition, so it does not by itself
 * justify skipping a post: the backend is a second opinion and taking it is the
 * fail-open answer. But when the browser itself reports that there is no
 * network, the backend is not a second opinion, it is a 45-second timeout per
 * post - and that is a fact we can know without asking, so we act on it instead
 * of discovering it by waiting. The bounded retry backoff in lib/retry.js still
 * covers the case the browser gets wrong.
 *
 * The local score itself is treated as coarse throughout. A heuristic can trip a
 * threshold and hide a post; it cannot produce a verdict, a confidence, a
 * reasoning chain or a piece of evidence, and nothing here synthesises any of
 * those. What it can honestly produce is the list of word patterns that fired,
 * which is measured rather than inferred, and that is what the panel shows.
 */

import { MAX_CAPTION_CHARS } from "./defaults.js";
import { CLASSIFIER_SOURCES, MODEL_STATUS, SIGNAL_IDS } from "./local-classifier.js";

/** Where a post's score comes from. */
export const POST_ROUTES = Object.freeze({
  /** Score it on device and do not contact the backend. */
  LOCAL: "local",
  /** Ask the analysis service, as the extension has always done. */
  BACKEND: "backend",
  /** Do nothing, and do not spend a request finding that out. */
  SKIP: "skip",
});

/**
 * Decide how one post should be scored.
 *
 * @param {object} state
 * @param {unknown} state.offlineMode the user's setting
 * @param {unknown} state.online `navigator.onLine`; only an explicit `false`
 *   counts, because a missing or non-boolean value must not be read as offline
 * @param {boolean} state.localReady whether the on-device classifier produced a
 *   verdict
 * @returns {string} a POST_ROUTES value
 */
export function routeForPost({ offlineMode, online, localReady } = {}) {
  if (offlineMode !== true) return POST_ROUTES.BACKEND;
  if (localReady) return POST_ROUTES.LOCAL;
  // No local verdict, and the browser says there is no network. Waiting out a
  // request timeout to learn the same thing is the thrash this avoids.
  if (online === false) return POST_ROUTES.SKIP;
  // Fail open. The classifier is the cheap path, not the only path.
  return POST_ROUTES.BACKEND;
}

/**
 * The text the on-device classifier gets to see.
 *
 * Caption plus alt text, because the backend OCRs images and a caption is not
 * the only text a post carries. Capped at the same limit the payload uses, so
 * offline mode and online mode look at the same words and a post is not judged
 * differently depending on which mode produced the score.
 *
 * @param {object} post
 * @param {number} [maxChars]
 * @returns {string}
 */
export function textForClassification(post, maxChars = MAX_CAPTION_CHARS) {
  const parts = [post?.caption, post?.imageAlt].map((part) => String(part || "").trim());
  const combined = parts.filter(Boolean).join("\n");
  return combined.length > maxChars ? combined.slice(0, maxChars) : combined;
}

/**
 * Shape a local classification as the result record the scanner already uses.
 *
 * Every backend-owned field is emptied rather than filled in. A panel that
 * rendered a verdict, a confidence or an evidence list here would be asserting
 * something the analysis service never said, and the user has no way to tell
 * the difference between "the model concluded" and "a word counter summed four
 * things". The two local fields are the ones that are actually measured.
 *
 * @param {string} postKey
 * @param {object} classification the value returned by local-classifier.js
 * @returns {object}
 */
export function toResultRecord(postKey, classification) {
  return {
    postKey,
    aiScore: Number(classification?.aiScore) || 0,
    newsScore: Number(classification?.newsScore) || 0,
    // Deliberately empty. The backend did not run, so there is no explanation,
    // no verdict, no confidence, no reasoning chain and no evidence to show,
    // and the panel is labelled as an on-device estimate instead.
    explanation: "",
    verdict: null,
    confidence: null,
    reasoning_chain: [],
    evidence: [],
    uncertainties: [],
    tool_rounds: 0,
    claim_scores: [],
    local: true,
    localSource: String(classification?.source || CLASSIFIER_SOURCES.HEURISTIC),
    localSignals: Array.isArray(classification?.signals) ? classification.signals : [],
    error: false,
  };
}

/**
 * The record for a post offline mode declined to score.
 *
 * `error` is true so the post is not cached as a verdict, and `offline` is true
 * so the scanner can tell "the user asked us not to spend a request" from "the
 * backend failed" and schedule no retry against a service that is not the thing
 * that is broken.
 *
 * @param {string} postKey
 * @returns {object}
 */
export function toOfflineSkipRecord(postKey) {
  return {
    postKey,
    aiScore: 0,
    newsScore: 0,
    explanation: "",
    error: true,
    offline: true,
  };
}

/** Message name for each signal identifier the scorer can report. */
export const SIGNAL_MESSAGE_KEYS = Object.freeze({
  [SIGNAL_IDS.ABSOLUTE_QUANTIFIER]: "localSignalAbsoluteQuantifier",
  [SIGNAL_IDS.CALL_TO_ACTION]: "localSignalCallToAction",
  [SIGNAL_IDS.URGENCY_AUTHORITY]: "localSignalUrgencyAuthority",
  [SIGNAL_IDS.SHOUTING]: "localSignalShouting",
  [SIGNAL_IDS.HASHTAG_SPAM]: "localSignalHashtagSpam",
  [SIGNAL_IDS.SECOND_PERSON_IMPERATIVE]: "localSignalSecondPersonImperative",
  [SIGNAL_IDS.SUPERLATIVE]: "localSignalSuperlative",
});

/** Message name for the name of the engine that produced a local score. */
export const SOURCE_MESSAGE_KEYS = Object.freeze({
  [CLASSIFIER_SOURCES.ONNX]: "placeholderLocalSourceOnnx",
  [CLASSIFIER_SOURCES.HEURISTIC]: "placeholderLocalSourceHeuristic",
});

/** Message name for each state the on-device model can be in. */
export const MODEL_STATUS_MESSAGE_KEYS = Object.freeze({
  [MODEL_STATUS.ONNX_READY]: "popupModelStatusOnnxReady",
  [MODEL_STATUS.MODEL_PRESENT]: "popupModelStatusModelPresent",
  [MODEL_STATUS.MISSING_ASSET]: "popupModelStatusMissingAsset",
  [MODEL_STATUS.RUNTIME_MISSING]: "popupModelStatusRuntimeMissing",
  [MODEL_STATUS.ASSET_UNREADABLE]: "popupModelStatusAssetUnreadable",
  [MODEL_STATUS.HEURISTIC_ONLY]: "popupModelStatusHeuristicOnly",
});
