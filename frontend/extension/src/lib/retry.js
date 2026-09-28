/**
 * Analysis retry backoff.
 *
 * A failed analysis is not cached, so it would otherwise be retried on every
 * single scan: a backend outage turns into a request storm that keeps the
 * backend down. This paces retries while still recovering from a blip.
 */

import { MAX_ANALYSIS_ATTEMPTS, RETRY_BASE_MS } from "./defaults.js";

/**
 * When a post may be retried, or null if it may be retried now.
 *
 * @param {Record<string, {attempts: number, nextAt: number}>} state
 * @param {string} key
 * @returns {number|null} the timestamp at which a retry is allowed, or Infinity
 *   once the attempt budget is spent
 */
export function nextRetryAt(state, key) {
  const entry = state[key];
  if (!entry) return null;
  if (entry.attempts >= MAX_ANALYSIS_ATTEMPTS) return Infinity;
  return entry.nextAt;
}

/**
 * Whether a post should be skipped right now.
 * @param {Record<string, {attempts: number, nextAt: number}>} state
 * @param {string} key
 * @param {number} [now]
 * @returns {boolean}
 */
export function shouldSkip(state, key, now = Date.now()) {
  const at = nextRetryAt(state, key, now);
  return at !== null && now < at;
}

/**
 * Record a failure, returning the updated state.
 *
 * The delay doubles per attempt. In practice a backoff can only be reached by
 * repeated failures, so this is bounded by RETRY_BACKOFF_MAX_MS.
 *
 * @param {Record<string, {attempts: number, nextAt: number}>} state
 * @param {string} key
 * @param {number} [now]
 * @returns {{state: Record<string, {attempts: number, nextAt: number}>, attempts: number, giveUp: boolean}}
 */
export function recordFailure(state, key, now = Date.now()) {
  const previous = state[key]?.attempts ?? 0;
  const attempts = previous + 1;
  const giveUp = attempts >= MAX_ANALYSIS_ATTEMPTS;
  const delay = RETRY_BASE_MS * 2 ** previous;

  return {
    state: { ...state, [key]: { attempts, nextAt: now + delay } },
    attempts,
    giveUp,
  };
}

/** Clear a key's backoff after a success. */
export function clearFailure(state, key) {
  if (!(key in state)) return state;
  const next = { ...state };
  delete next[key];
  return next;
}
