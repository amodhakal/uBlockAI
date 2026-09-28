/**
 * Local feedback queue.
 *
 * Reports are queued locally and uploaded in batches. Previously the upload
 * path existed in the service worker but nothing ever sent the message that
 * triggered it, so reports accumulated in storage forever and were never
 * counted anywhere.
 *
 * A report is a claim by the user that the extension got a post wrong, in one
 * of two directions: a post it hid that was fine (false positive), or a post it
 * showed that was misinformation (false negative). Both are queued here and
 * drained by the service worker on an alarm.
 */

import { STORAGE_KEYS } from "./defaults.js";
import { logError } from "./logging.js";
import { STORAGE_AREAS, readSync, writeSync } from "./settings.js";

/**
 * The two directions a post can be reported in.
 *
 * These are the values sent to the backend as `type`, and the keys callers pass
 * to queueReport/drainReports. They are deliberately distinct from the storage
 * keys, which is what made the uploader miss the queue entirely: it looked the
 * reports up by *kind*, so `readSync(["falsePositive"])` never saw the array
 * written to `falsePositiveReports`, and the queue was silently never drained.
 */
export const REPORT_KINDS = Object.freeze({
  FALSE_POSITIVE: "falsePositive",
  FALSE_NEGATIVE: "falseNegative",
});

/** Report kind -> the storage key its queue lives under. */
export const REPORT_BUCKETS = Object.freeze({
  [REPORT_KINDS.FALSE_POSITIVE]: STORAGE_KEYS.falsePositiveReports,
  [REPORT_KINDS.FALSE_NEGATIVE]: STORAGE_KEYS.falseNegativeReports,
});

/** Every kind, in the order the uploader drains them. */
export const REPORT_KIND_LIST = Object.freeze([
  REPORT_KINDS.FALSE_POSITIVE,
  REPORT_KINDS.FALSE_NEGATIVE,
]);

/** Queued reports older than this are dropped rather than uploaded forever. */
const MAX_REPORT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_QUEUED_REPORTS = 200;

/**
 * Resolve a report kind to its storage bucket.
 * @param {string} kind
 * @returns {string}
 */
export function bucketFor(kind) {
  return REPORT_BUCKETS[kind] ?? REPORT_BUCKETS[REPORT_KINDS.FALSE_POSITIVE];
}

/**
 * Read a queue. Takes a *bucket*, not a kind: resolving twice is how a false
 * negative ends up written to the false-positive queue.
 *
 * @param {string} bucket
 * @returns {Promise<object[]>}
 */
async function readQueue(bucket) {
  const data = await readSync([bucket], STORAGE_AREAS.LOCAL);
  const raw = data[bucket];
  return Array.isArray(raw) ? raw : [];
}

/**
 * @param {string} bucket
 * @param {object[]} reports
 */
async function writeQueue(bucket, reports) {
  const bounded = reports.slice(-MAX_QUEUED_REPORTS);
  const result = await writeSync({ [bucket]: bounded }, STORAGE_AREAS.LOCAL);
  if (!result.ok) {
    // Losing a feedback report is not worth interrupting the user over, but it
    // must not be silent either.
    logError("feedback", `could not persist ${bucket}`, { error: result.error });
  }
  return result;
}

/**
 * Queue a report against a post.
 *
 * Deduplicated per post and kind. A user who clicks the report button twice, or
 * scrolls a post back into view, should not produce two entries for the same
 * post: it inflates the numbers the backend derives from these reports and it
 * makes the same post the subject of repeated submissions.
 *
 * @param {object} params
 * @param {string} params.postKey stable post identifier
 * @param {string} params.kind one of REPORT_KINDS
 * @param {string} [params.imageUrl]
 * @param {string} [params.caption]
 * @param {string} [params.note]
 * @returns {Promise<{queued: boolean, kind: string}>}
 */
export async function queueReport({
  postKey,
  kind,
  imageUrl = "",
  caption = "",
  note = "",
}) {
  if (!postKey) return { queued: false, kind };
  const bucket = bucketFor(kind);

  const queue = await readQueue(bucket);
  if (queue.some((entry) => entry?.postKey === postKey)) {
    return { queued: false, kind };
  }

  queue.push({
    postKey,
    imageUrl,
    caption: caption.slice(0, 1000),
    note: note.slice(0, 500),
    type: kind,
    timestamp: Date.now(),
  });
  await writeQueue(bucket, queue);
  return { queued: true, kind };
}

/**
 * Whether a post has already been reported in a direction.
 * @param {string} kind
 * @param {string} postKey
 * @returns {Promise<boolean>}
 */
export async function hasReported(kind, postKey) {
  if (!postKey) return false;
  const queue = await readQueue(bucketFor(kind));
  return queue.some((entry) => entry?.postKey === postKey);
}

/**
 * The `kind:postKey` markers for everything already queued.
 *
 * Read at startup so a report the user made before a reload comes back with its
 * control disabled, rather than offering the same post to the backend again.
 *
 * @returns {Promise<string[]>}
 */
export async function readReportedKeys() {
  const markers = [];
  for (const kind of REPORT_KIND_LIST) {
    const queue = await readQueue(bucketFor(kind));
    for (const entry of queue) {
      if (typeof entry?.postKey === "string" && entry.postKey) {
        markers.push(`${kind}:${entry.postKey}`);
      }
    }
  }
  return markers;
}

/**
 * Drain a queue, dropping entries past the maximum age.
 * @param {string} kind
 * @returns {Promise<object[]>} the reports to upload
 */
export async function drainReports(kind) {
  const bucket = bucketFor(kind);
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
  await writeQueue(bucketFor(kind), []);
}
