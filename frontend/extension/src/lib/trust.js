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
  const value = typeof key === "string" ? key.trim() : "";
  if (!value) return { keys: current, added: false, dropped: 0 };
  if (current.includes(value)) return { keys: current, added: false, dropped: 0 };

  const next = [...current, value];
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

/**
 * Clear the whole trust list.
 * @param {string[]} current
 * @returns {{keys: string[], removed: number}}
 */
export function clearTrustedKeys(current) {
  return { keys: [], removed: current.length };
}

/**
 * Coerce a value read out of storage into a usable trust list.
 *
 * `loadSettings` only checked `Array.isArray`, so a hand-edited or
 * partially-synced value containing non-strings reached the content script,
 * where it was compared against post keys and written straight back out. Every
 * consumer now goes through here.
 *
 * @param {unknown} raw
 * @returns {string[]} deduplicated, bounded, strings only
 */
export function normalizeTrustedKeys(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const key of raw) {
    if (typeof key !== "string") continue;
    const trimmed = key.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  // Keep the newest, matching addTrustedKey. Bounding from the other end would
  // silently drop the entry the user just added and keep the stale ones.
  return out.slice(-MAX_TRUSTED_KEYS);
}

/** Longest suffix shown in the options list before it is elided. */
const DISPLAY_MAX_CHARS = 12;

/**
 * Render a post key as a short, recognisable label for the trust list.
 *
 * Keys are CDN URLs ending in a long opaque filename. Rendering one in full
 * produces a wall of base64-ish text that no user can match against a post.
 * The trailing segment is the only part with any meaning, so that is what the
 * list shows, with the full key available in the row's title attribute.
 *
 * The result is derived from a URL that ultimately came from a social media
 * post, so callers must still assign it with `textContent`, never `innerHTML`.
 *
 * @param {string} key
 * @returns {string}
 */
export function describeTrustedKey(key) {
  const raw = typeof key === "string" ? key.trim() : "";
  if (!raw) return "(unknown post)";

  const segment = raw.split("?")[0].split("/").filter(Boolean).pop() || raw;
  if (segment.length <= DISPLAY_MAX_CHARS) return segment;

  // Keep both ends: the extension is stable and the tail is unique.
  const head = Math.ceil((DISPLAY_MAX_CHARS - 1) / 2);
  const tail = Math.floor((DISPLAY_MAX_CHARS - 1) / 2);
  return `${segment.slice(0, head)}…${segment.slice(segment.length - tail)}`;
}
