/**
 * Bounded LRU cache for analysis results.
 *
 * The result cache was an unbounded Map. During a long scroll session it grew
 * until the tab ran out of memory, and because it was never pruned, a post
 * visited early could never be evicted.
 *
 * Values are keyed on a stable identifier rather than the image URL. Instagram
 * CDN URLs carry expiring signature parameters (`stp`, `_nc_cat`, `ig_cache_key`,
 * `ccb`) that change on every page load, so keying on `img.src` meant the cache
 * never hit and grew without bound.
 */

/**
 * @template V
 */
export class LruCache {
  /**
   * @param {number} maxEntries maximum retained entries
   */
  constructor(maxEntries = 500) {
    this.maxEntries = Math.max(1, maxEntries);
    /** @type {Map<string, V>} */
    this._entries = new Map();
  }

  /** @returns {number} */
  get size() {
    return this._entries.size;
  }

  /**
   * @param {string} key
   * @returns {V | undefined}
   */
  get(key) {
    if (!this._entries.has(key)) return undefined;
    // Re-insert to move to the most-recently-used end.
    const value = this._entries.get(key);
    this._entries.delete(key);
    this._entries.set(key, value);
    return value;
  }

  /**
   * @param {string} key
   * @param {V} value
   * @returns {void}
   */
  set(key, value) {
    if (this._entries.has(key)) {
      this._entries.delete(key);
    }
    this._entries.set(key, value);
    this._evictIfNeeded();
  }

  /**
   * @param {string} key
   * @returns {boolean} whether an entry was removed
   */
  delete(key) {
    return this._entries.delete(key);
  }

  clear() {
    this._entries.clear();
  }

  /** @returns {string[]} keys from least to most recently used */
  keys() {
    return Array.from(this._entries.keys());
  }

  _evictIfNeeded() {
    while (this._entries.size > this.maxEntries) {
      // Map preserves insertion order, so the first key is the least recently
      // used.
      const oldest = this._entries.keys().next().value;
      this._entries.delete(oldest);
    }
  }
}

/**
 * Derive a stable cache key for a post.
 *
 * Preference order, most stable first:
 *  1. An explicit media id, which never changes for a post.
 *  2. A path segment from the post permalink, e.g. `/p/ABC123/`.
 *  3. A content hash of the image URL with its signature parameters removed.
 *
 * Never the raw `img.src`, which carries per-load signature parameters.
 *
 * @param {{mediaId?: string, permalink?: string, imageUrl?: string}} post
 * @returns {string}
 */
export function stableCacheKey(post) {
  if (!post) return "";

  if (post.mediaId) return `mid:${post.mediaId}`;

  if (post.permalink) {
    const match = String(post.permalink).match(/\/p\/([A-Za-z0-9_-]+)/);
    if (match) return `p:${match[1]}`;
  }

  if (post.imageUrl) return `url:${stripSignatureParams(post.imageUrl)}`;

  return "";
}

/** Query parameters that change on every request and must not be part of a key. */
const VOLATILE_PARAMS = new Set([
  "stp",
  "_nc_cat",
  "_nc_ohc",
  "ig_cache_key",
  "ccb",
  "_nc_htc",
  "oh",
  "oe",
  "_nc_sid",
  "_nc_rid",
  "v",
  "t",
  "ts",
]);

/**
 * Remove volatile signature and cache-busting parameters from a URL.
 * @param {string} url
 * @returns {string}
 */
export function stripSignatureParams(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (VOLATILE_PARAMS.has(key)) parsed.searchParams.delete(key);
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // Not parseable as a URL; fall back to stripping a query string by hand.
    return String(url).split("#")[0].replace(/\?.*$/, "");
  }
}

/**
 * A compact, fixed-size key suitable for chrome.storage.sync.
 *
 * Storage is capped at 8 KB per item. Persisting full CDN URLs consumed the
 * quota within a few dozen posts, and the resulting write failure was ignored,
 * so previously hidden posts were forgotten on reload.
 *
 * @param {string} key key from stableCacheKey
 * @returns {string} a short, stable digest
 */
export function compactStorageKey(key) {
  if (!key) return "";
  // FNV-1a, 32-bit. Deterministic, dependency-free, and short enough that a
  // thousand entries fit comfortably inside the quota.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Mix in the length so that keys differing only in length rarely collide.
  return `${hash.toString(36)}-${key.length.toString(36)}`;
}
