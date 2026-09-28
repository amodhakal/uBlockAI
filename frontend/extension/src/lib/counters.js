/**
 * Lifetime counters for hidden/analysed posts.
 *
 * The MutationObserver used to overwrite the lifetime `hiddenCount` with the
 * number of placeholders currently present in the DOM, corrupting the
 * statistic whenever the feed re-rendered. The lifetime total and the
 * DOM-present count are different quantities and must never be assigned to
 * each other:
 *
 * - lifetime: monotonic-ish total persisted to storage, moved only by
 *   recordHide/recordUnhide on explicit hide/unhide transitions.
 * - present: derived live from the DOM (or from the in-memory hidden-key set
 *   intersected with connected elements), never persisted, never written back
 *   to the lifetime counter.
 *
 * These helpers are pure so the counter logic is unit-testable without a DOM.
 */

/**
 * Coerce a stored counter to a safe non-negative integer.
 * @param {unknown} value
 * @returns {number}
 */
export function coerceCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

/**
 * Restore persisted counters.
 * @param {Record<string, unknown>} stored
 * @param {string} hiddenKey
 * @param {string} analyzedKey
 * @returns {{hidden: number, analyzed: number}}
 */
export function restoreCounts(stored, hiddenKey, analyzedKey) {
  return {
    hidden: coerceCount(stored?.[hiddenKey]),
    analyzed: coerceCount(stored?.[analyzedKey]),
  };
}

/**
 * Record a hide transition. Increments the lifetime total only when the key
 * is newly hidden; re-hiding an already-hidden key is a no-op.
 *
 * @param {Set<string>} hiddenKeys in-memory hidden-key set (mutated)
 * @param {number} lifetime current lifetime total
 * @param {string} postKey
 * @returns {{added: boolean, lifetime: number}}
 */
export function recordHide(hiddenKeys, lifetime, postKey) {
  if (!postKey || hiddenKeys.has(postKey)) return { added: false, lifetime };
  hiddenKeys.add(postKey);
  return { added: true, lifetime: coerceCount(lifetime) + 1 };
}

/**
 * Record an unhide transition (e.g. the user relaxed a threshold and a
 * previously hidden post becomes visible). Decrements the lifetime total,
 * floored at zero.
 *
 * @param {Set<string>} hiddenKeys in-memory hidden-key set (mutated)
 * @param {number} lifetime current lifetime total
 * @param {string} postKey
 * @returns {{removed: boolean, lifetime: number}}
 */
export function recordUnhide(hiddenKeys, lifetime, postKey) {
  if (!postKey || !hiddenKeys.has(postKey)) {
    return { removed: false, lifetime: coerceCount(lifetime) };
  }
  hiddenKeys.delete(postKey);
  return { removed: true, lifetime: Math.max(0, coerceCount(lifetime) - 1) };
}

/**
 * Count how many hidden keys are currently present (connected) in the DOM.
 *
 * This is the DOM-present count: a display/live quantity. It must never be
 * written back to the persisted lifetime counter.
 *
 * @param {Iterable<string>} hiddenKeys
 * @param {(postKey: string) => boolean} [isPresent] defaults to always present
 * @returns {number}
 */
export function countPresent(hiddenKeys, isPresent = null) {
  let count = 0;
  for (const key of hiddenKeys) {
    if (typeof isPresent === "function") {
      if (isPresent(key)) count += 1;
    } else {
      count += 1;
    }
  }
  return count;
}
