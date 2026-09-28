/**
 * Persisted trust list.
 *
 * "Show post anyway" only lasted until reload: nothing ever wrote the trust
 * list, and the re-hide-on-scroll path ignored the user's current thresholds,
 * so a revealed post was re-hidden anyway after the user *raised* sensitivity.
 *
 * The list is bounded for the same reason the hidden-key set is: it lives in
 * storage.sync, which is quota-capped and rate-limited.
 */

import { MAX_TRUSTED_KEYS } from "./defaults.js";

/**
 * Add a post key to the trust list, deduplicated and bounded.
 *
 * @param {string[]} current existing keys
 * @param {string} key
 * @returns {{keys: string[], added: boolean, dropped: number}}
 */
export function addTrustedKey(current, key) {
  if (!key) return { keys: current, added: false, dropped: 0 };
  if (current.includes(key)) return { keys: current, added: false, dropped: 0 };

  const next = [...current, key];
  const dropped = Math.max(0, next.length - MAX_TRUSTED_KEYS);
  return { keys: next.slice(-MAX_TRUSTED_KEYS), added: true, dropped };
}

/**
 * Remove a post key from the trust list.
 * @param {string[]} current
 * @param {string} key
 * @returns {{keys: string[], removed: boolean}}
 */
export function removeTrustedKey(current, key) {
  if (!current.includes(key)) return { keys: current, removed: false };
  return { keys: current.filter((k) => k !== key), removed: true };
}
