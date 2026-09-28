/**
 * Persisted-state budget management.
 *
 * chrome.storage.sync caps a single item at 8 KB and the whole area at 100 KB,
 * and separately limits writes to 120/minute and 1800/hour. The previous code
 * wrote the entire array of hidden-post keys on every single hide, so a long
 * session both filled the quota and exhausted the write budget. Writes were
 * best-effort and unmeasured, so nothing surfaced either failure.
 *
 * Two mechanisms, deliberately: the byte budget trims what is stored, and the
 * debounced writer keeps the number of writes under the rate cap.
 */

import { MAX_SYNC_ITEM_BYTES } from "./defaults.js";

/** Leave headroom so a write is never one character away from failing. */
const SAFETY_MARGIN = 0.9;

/** Effective ceiling for one item. */
export const SYNC_ITEM_BUDGET = Math.floor(MAX_SYNC_ITEM_BYTES * SAFETY_MARGIN);

/**
 * UTF-8 byte length, which is what the quota counts.
 *
 * `String.length` counts UTF-16 code units, so any non-ASCII value is
 * undercounted and the real write can exceed the cap that was believed to be
 * respected.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function estimateBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Trim a list so its serialized form fits the per-item budget.
 *
 * The most recent entries are kept, because the posts a user is looking at now
 * are the ones they would notice being forgotten.
 *
 * @param {string[]} values
 * @param {number} [maxBytes]
 * @returns {{values: string[], dropped: number, bytes: number}}
 */
export function trimToByteBudget(values, maxBytes = SYNC_ITEM_BUDGET) {
  const kept = [];
  let dropped = 0;
  let bytes = 0;

  for (let i = values.length - 1; i >= 0; i -= 1) {
    // Measure the candidate list one entry at a time so the overhead of the
    // enclosing array and its commas is accounted for.
    const candidate = [values[i], ...kept];
    const size = estimateBytes(candidate);
    if (bytes + size > maxBytes && kept.length > 0) {
      dropped += 1;
      continue;
    }
    kept.unshift(values[i]);
    bytes = size;
  }

  return { values: kept, dropped, bytes };
}

/**
 * A writer that keeps only the most recent value and writes at most once per
 * interval.
 *
 * `maxWaitMs` matters: without it a continuous stream of hides starves the
 * timer and nothing is ever written.
 *
 * @template T
 * @param {(value: T) => Promise<{ok: boolean, error?: string}>} write
 * @param {number} [waitMs]
 * @param {number} [maxWaitMs]
 * @returns {{push(value: T): void, flush(): Promise<void>, cancel(): void, pending(): boolean}}
 */
export function createDebouncedWriter(write, waitMs = 5000, maxWaitMs = 30000) {
  let timer = null;
  let firstQueuedAt = null;
  let latest;
  let inFlight = null;

  async function run() {
    timer = null;
    firstQueuedAt = null;
    const value = latest;
    inFlight = write(value);
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return {
    push(value) {
      latest = value;
      if (firstQueuedAt === null) firstQueuedAt = Date.now();

      if (timer !== null) {
        // A write is already queued. If the oldest queued value has reached the
        // max-wait deadline, write it now rather than re-arming: re-arming for
        // another full wait would mean a steady stream never writes at all,
        // which is exactly what maxWaitMs exists to prevent.
        if (Date.now() - firstQueuedAt >= maxWaitMs) {
          clearTimeout(timer);
          timer = null;
          void run();
          return;
        }
        return;
      }

      timer = setTimeout(() => {
        void run();
      }, waitMs);
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) return inFlight;
      if (latest === undefined) return Promise.resolve();
      return run();
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      firstQueuedAt = null;
    },
    pending() {
      return timer !== null || inFlight !== null;
    },
  };
}
