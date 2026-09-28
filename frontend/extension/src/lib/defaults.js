/**
 * Single source of truth for every tunable default.
 *
 * The popup sliders and the content script previously carried independent
 * copies of these numbers. The sliders defaulted to 7 and 5 on a 0-10 scale,
 * which is 0.7 and 0.5, while the content script started at 0.3 and 0.2. On
 * first run, before any storage write, the UI showed one number and the code
 * used another.
 *
 * Everything derives from the constants here. `THRESHOLD_SCALE` converts
 * between the 0..1 domain the backend scores in and the integer domain the
 * sliders operate in.
 */

/** Backend scores are 0..1. */
export const SCORE_MIN = 0;
export const SCORE_MAX = 1;

/** The popup sliders run 1..10, which is a strictly more conservative scale. */
export const SLIDER_MIN = 1;
export const SLIDER_MAX = 10;
export const SLIDER_STEPS = SLIDER_MAX - SLIDER_MIN + 1;

export const DEFAULT_AI_GENERATED_THRESHOLD = 0.3;
export const DEFAULT_NEWS_THRESHOLD = 0.2;

/** Captions were truncated at 100 characters, which is far too short. */
export const MAX_CAPTION_CHARS = 3000;
export const MAX_ALT_TEXT_CHARS = 1000;

/** Bounds on payloads sent to the backend. */
export const DEFAULT_MAX_IMAGES = 3;
export const MAX_MAX_IMAGES = 10;

/** How long a single analysis may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 45_000;

/** How long the batch endpoint is allowed before the batch is abandoned. */
export const BATCH_TIMEOUT_MS = 90_000;

/** Wait after a scroll before reprocessing, in milliseconds. */
export const SCROLL_DEBOUNCE_MS = 200;

/**
 * How often the service worker drains the feedback queue.
 *
 * chrome.alarms persists across worker restarts, unlike setTimeout, which is
 * why the worker uses it rather than an interval. 15 minutes is comfortably
 * above every documented floor; do not lower it to speed up a test, assert on
 * the constant instead.
 */
export const FEEDBACK_INTERVAL_MINUTES = 15;

/** Maximum number of analysis requests in flight at once. */
export const MAX_CONCURRENT_REQUESTS = 4;

/**
 * A failed analysis is not cached, so it would be retried on every scan. A
 * backend outage would then become a request storm that keeps it down. Retries
 * are paced and capped.
 */
export const RETRY_BASE_MS = 5000;
export const MAX_ANALYSIS_ATTEMPTS = 3;

/** Maximum entries retained in the in-memory result cache. */
export const MAX_CACHE_ENTRIES = 500;

/** How long a cached score stays valid. A verdict going stale is a real harm. */
export const RESULT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Persisted hidden-key budget.
 *
 * A digest serializes to roughly 14 bytes, so the 8 KB per-item cap binds at
 * about 580 entries. 400 leaves real headroom.
 */
export const MAX_HIDDEN_KEYS = 400;

/** Persisted trust-list bound, for the same reason. */
export const MAX_TRUSTED_KEYS = 400;

/**
 * storage.sync permits 120 writes per minute and 1800 per hour. Writing the
 * whole hidden-key set on every hide saturated that within a session, so writes
 * are coalesced.
 */
export const HIDDEN_KEY_WRITE_DEBOUNCE_MS = 5000;
export const HIDDEN_KEY_WRITE_MAX_WAIT_MS = 30000;

/**
 * chrome.storage.sync caps each item at 8 KB and the whole area at 100 KB.
 * CDN URLs run to several hundred characters, so a long session blew the quota
 * and the write failed silently.
 */
export const MAX_SYNC_QUOTA_BYTES = 102_400;
export const MAX_SYNC_ITEM_BYTES = 8192;

/** What to do with a post that trips a threshold. */
export const HIDING_ACTIONS = Object.freeze({
  BLUR: "blur",
  PLACEHOLDER: "placeholder",
  REMOVE: "remove",
});

export const DEFAULT_HIDING_ACTION = HIDING_ACTIONS.PLACEHOLDER;

/** How the extension identifies itself in storage. */
export const STORAGE_KEYS = Object.freeze({
  aiGeneratedThreshold: "aiGeneratedThreshold",
  newsThreshold: "newsThreshold",
  hiddenCount: "hiddenCount",
  removedPostKeys: "removedPostKeys",
  backendUrl: "backendUrl",
  apiKey: "apiKey",
  debugLogging: "debugLogging",
  hidingAction: "hidingAction",
  trustedKeys: "trustedKeys",
  telemetryEnabled: "telemetryEnabled",
  analyzedCount: "analyzedCount",
  falsePositiveReports: "falsePositiveReports",
  falseNegativeReports: "falseNegativeReports",
});

/**
 * Convert a backend score threshold to the slider's integer domain.
 * @param {number} value threshold in 0..1
 * @returns {number} integer in SLIDER_MIN..SLIDER_MAX
 */
export function toSlider(value) {
  const clamped = Math.min(SCORE_MAX, Math.max(SCORE_MIN, Number(value) || 0));
  return Math.round(SLIDER_MIN + clamped * (SLIDER_STEPS - 1));
}

/**
 * Convert a slider value back to the 0..1 threshold domain.
 * @param {number} value integer in SLIDER_MIN..SLIDER_MAX
 * @returns {number} threshold in 0..1
 */
export function fromSlider(value) {
  const clamped = Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, Number(value) || SLIDER_MIN));
  return (clamped - SLIDER_MIN) / (SLIDER_STEPS - 1);
}

/**
 * Whether a post's scores should be hidden, given the current thresholds.
 *
 * Both comparisons are inclusive, which is the behaviour the original content
 * script had and what the threshold unit tests pin.
 *
 * @param {number} aiScore 0..1
 * @param {number} newsScore 0..1
 * @param {number} aiThreshold 0..1
 * @param {number} newsThreshold 0..1
 * @returns {boolean}
 */
export function shouldHidePost(aiScore, newsScore, aiThreshold, newsThreshold) {
  return (
    Number(aiScore || 0) >= Number(aiThreshold || 0) ||
    Number(newsScore || 0) >= Number(newsThreshold || 0)
  );
}
