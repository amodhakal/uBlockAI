/**
 * Opt-in telemetry.
 *
 * The `telemetryEnabled` flag existed in storage and nothing ever read it, so
 * there was no way to tell a user what the extension would send, and no way to
 * tell whether it was.
 *
 * The rules this module exists to enforce:
 *
 * 1. Off by default, and off means off: `buildTelemetryEvent` returns null and
 *    the uploader never calls the network. Turning the flag on is the only
 *    thing that can produce an event.
 * 2. Counts only. A post's caption, alt text, image URL and stable key are all
 *    user content or user-identifying, and none of them are ever included. The
 *    allowlist below is the whole payload surface, so a new field has to be
 *    added deliberately rather than arriving with a `{...post}` spread.
 * 3. Aggregated locally. Events accumulate into counters in storage and are
 *    sent as totals on an alarm, so the backend learns how many posts were
 *    analysed, not what was in them, and not when.
 *
 * The local counters are the same ones the popup displays. They are not
 * telemetry: they never leave the device unless the user opts in, and turning
 * telemetry off does not stop them being counted locally.
 */

import { STORAGE_KEYS } from "./defaults.js";
import { coerceCount } from "./counters.js";
import { logError } from "./logging.js";
import { STORAGE_AREAS, readSync, writeSync } from "./settings.js";

/**
 * The only metric names that may be sent. Adding one is a deliberate act.
 * @type {Readonly<Record<string, string>>}
 */
export const TELEMETRY_METRICS = Object.freeze({
  ANALYZED: "analyzed",
  HIDDEN: "hidden",
  REPORTED: "reported",
});

/** Every metric name, for iteration and validation. */
export const TELEMETRY_METRIC_NAMES = Object.freeze(Object.values(TELEMETRY_METRICS));

/** Fields permitted in an uploaded event. Everything else is dropped. */
const ALLOWED_FIELDS = Object.freeze(["schema", "enabled", "counts"]);

/** Bumped if the shape of an event ever changes incompatibly. */
export const TELEMETRY_SCHEMA = 1;

/** Path the batch is POSTed to. */
export const TELEMETRY_PATH = "/api/telemetry";

/**
 * Drop every key that is not a non-negative integer, and every key that is not
 * a known metric.
 *
 * Anything a caller passes that is not a count is discarded rather than
 * coerced: a string is a value, and values are exactly what must not leave the
 * device.
 *
 * @param {unknown} raw
 * @returns {Record<string, number>}
 */
export function sanitizeCounts(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const name of TELEMETRY_METRIC_NAMES) {
    const value = raw[name];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (value < 0) continue;
    out[name] = Math.floor(value);
  }
  return out;
}

/** An empty, well-formed counter set. */
export function emptyCounts() {
  return sanitizeCounts({});
}

/**
 * Add deltas into a counter set, keeping every value a non-negative integer.
 *
 * @param {Record<string, number>} current
 * @param {Record<string, number>} [delta]
 * @returns {Record<string, number>} the new counters; `current` is not mutated
 */
export function addCounts(current, delta) {
  const base = sanitizeCounts(current);
  const add = sanitizeCounts(delta);
  const out = { ...base };
  for (const [name, value] of Object.entries(add)) {
    out[name] = coerceCount((out[name] ?? 0) + value);
  }
  return out;
}

/**
 * Build the event to upload, or null when the user has not opted in.
 *
 * Returns null rather than an empty event so the caller's network path is
 * unreachable, not merely a no-op: an opt-out that still performs a request is
 * an opt-out in name only.
 *
 * @param {boolean} enabled
 * @param {Record<string, unknown>} [counts]
 * @returns {{schema: number, enabled: true, counts: Record<string, number>}|null}
 */
export function buildTelemetryEvent(enabled, counts) {
  if (enabled !== true) return null;

  const clean = sanitizeCounts(counts);
  const event = { schema: TELEMETRY_SCHEMA, enabled: true, counts: clean };

  // Belt and braces: the allowlist is enforced by construction above, and this
  // re-checks it so a future field added to `clean` cannot slip out.
  for (const key of Object.keys(event)) {
    if (!ALLOWED_FIELDS.includes(key)) delete event[key];
  }
  return event;
}

/** Whether an event carries anything worth sending. */
export function hasAnythingToSend(event) {
  if (!event) return false;
  return Object.values(event.counts ?? {}).some((value) => value > 0);
}

/**
 * @param {"sync"|"local"} [area]
 * @returns {Promise<Record<string, unknown>>}
 */
function readLocalCounts(area = STORAGE_AREAS.LOCAL) {
  return readSync([STORAGE_KEYS.telemetryCounts], area);
}

/**
 * Read the pending counts.
 * @returns {Promise<Record<string, number>>}
 */
export async function readPendingCounts() {
  const data = await readLocalCounts();
  return sanitizeCounts(data[STORAGE_KEYS.telemetryCounts]);
}

/**
 * Persist pending counts. Counters are high-churn local state, so this is
 * storage.local rather than the rate-limited sync area.
 *
 * @param {Record<string, number>} counts
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function writePendingCounts(counts) {
  const result = await writeSync({
    [STORAGE_KEYS.telemetryCounts]: sanitizeCounts(counts),
  });
  if (!result.ok) {
    logError("telemetry", "could not persist pending counts", { error: result.error });
  }
  return result;
}

/**
 * Fold a delta into the pending counters.
 *
 * A read-modify-write without a lock: the service worker is the only writer of
 * the upload path, but the content script also bumps these, so a concurrent
 * increment can be lost. That is acceptable for a metric whose only purpose is
 * an aggregate trend, and it is strictly better than the alternative of
 * blocking a content script on a storage round trip per hide.
 *
 * @param {Record<string, number>} delta
 * @returns {Promise<Record<string, number>>} the new totals
 */
export async function recordCounts(delta) {
  const current = await readPendingCounts();
  const next = addCounts(current, delta);
  await writePendingCounts(next);
  return next;
}

/**
 * Zero the pending counters. Called only after a successful upload, so a failed
 * batch is retried rather than dropped.
 * @returns {Promise<void>}
 */
export async function resetPendingCounts() {
  await writePendingCounts({});
}
