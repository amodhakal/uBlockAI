/**
 * Local feedback queue.
 *
 * Reports are queued locally and uploaded in batches. Previously the upload
 * path existed in the service worker but nothing ever sent the message that
 * triggered it, so reports accumulated in storage forever and were never
 * counted anywhere.
 */

import { STORAGE_KEYS } from "./defaults.js";
import { logError } from "./logging.js";
import { STORAGE_AREAS, readSync, writeSync } from "./settings.js";

const KIND_FALSE_POSITIVE = "falsePositiveReports";
const KIND_FALSE_NEGATIVE = "falseNegativeReports";

/** Queued reports older than this are dropped rather than uploaded forever. */
const MAX_REPORT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_QUEUED_REPORTS = 200;

/**
 * @param {string} kind
 * @returns {Promise<object[]>}
 */
async function readQueue(kind) {
  const data = await readSync([kind], STORAGE_AREAS.LOCAL);
  const raw = data[kind];
  return Array.isArray(raw) ? raw : [];
}

/**
 * @param {string} kind
 * @param {object[]} reports
 */
async function writeQueue(kind, reports) {
  const bounded = reports.slice(-MAX_QUEUED_REPORTS);
  const result = await writeSync({ [kind]: bounded }, STORAGE_AREAS.LOCAL);
  if (!result.ok) {
    // Losing a feedback report is not worth interrupting the user over, but it
    // must not be silent either.
    logError("feedback", `could not persist ${kind}`, { error: result.error });
  }
  return result;
}

/**
 * Queue a report against a post.
 *
 * @param {object} params
 * @param {string} params.postKey stable post identifier
 * @param {string} params.kind either falsePositive or falseNegative
 * @param {string} [params.imageUrl]
 * @param {string} [params.caption]
 * @param {string} [params.note]
 * @returns {Promise<void>}
 */
export async function queueReport({
  postKey,
  kind,
  imageUrl = "",
  caption = "",
  note = "",
}) {
  const bucket = kind === "falseNegative" ? KIND_FALSE_NEGATIVE : KIND_FALSE_POSITIVE;
  const queue = await readQueue(bucket);
  queue.push({
    postKey,
    imageUrl,
    caption: caption.slice(0, 1000),
    note: note.slice(0, 500),
    type: kind,
    timestamp: Date.now(),
  });
  await writeQueue(bucket, queue);
}

/**
 * Drain a queue, dropping entries past the maximum age.
 * @param {string} kind
 * @returns {Promise<object[]>} the reports to upload
 */
export async function drainReports(kind) {
  const bucket = kind === "falseNegative" ? KIND_FALSE_NEGATIVE : KIND_FALSE_POSITIVE;
  const queue = await readQueue(bucket);
  const cutoff = Date.now() - MAX_REPORT_AGE_MS;
  const fresh = queue.filter((report) => Number(report.timestamp) >= cutoff);
  if (fresh.length !== queue.length) {
    await writeQueue(bucket, fresh);
  }
  return fresh;
}

/**
 * Clear a queue after a successful upload.
 * @param {string} kind
 */
export async function clearReports(kind) {
  const bucket = kind === "falseNegative" ? KIND_FALSE_NEGATIVE : KIND_FALSE_POSITIVE;
  await writeQueue(bucket, []);
}

/** Both queue kinds, for iteration by the uploader. */
export const REPORT_KINDS = Object.freeze(["falsePositive", "falseNegative"]);

export { STORAGE_KEYS };
