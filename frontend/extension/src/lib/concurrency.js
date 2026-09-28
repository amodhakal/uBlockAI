/**
 * Bounded-concurrency task pool.
 *
 * Posts were analysed one at a time through sequential awaits, so the time to
 * analyse a screenful of posts was the sum of every individual analysis, each
 * of which can take tens of seconds. Analysing five posts took five times as
 * long as analysing one.
 *
 * A pool runs several at once but caps how many, because every in-flight
 * request costs real money on the backend and holds an OCR worker.
 */

/**
 * Run tasks with at most `limit` in flight.
 *
 * @template T, R
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} limit
 * @returns {Promise<Array<{ok: true, value: T} | {ok: false, error: Error}>>}
 *          one entry per task, in input order
 */
export async function runBounded(tasks, limit) {
  const results = new Array(tasks.length);
  const bound = Math.max(1, Math.min(limit, tasks.length || 1));
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      try {
        results[index] = { ok: true, value: await tasks[index]() };
      } catch (error) {
        results[index] = {
          ok: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: bound }, () => worker()));
  return results;
}

/**
 * Abortable wrapper around a promise-returning function.
 *
 * There was no timeout on the analysis request. A backend that accepted the
 * connection and then hung left the post permanently unclassified, and the
 * in-flight marker was never cleared, so that post was never retried for the
 * rest of the session. A senior user simply saw an unflagged post.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} timeoutMs
 * @param {string} [label]
 * @returns {Promise<T>}
 */
export function withTimeout(fn, timeoutMs, label = "request") {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  return Promise.race([fn(), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Reject with a timeout error if a promise has not settled.
 *
 * @param {number} ms
 * @param {string} [label]
 */
export function deadline(ms, label = "operation") {
  let timer;
  const promise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}
