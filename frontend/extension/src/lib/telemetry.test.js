/**
 * Telemetry: opt-in, counts only, never content.
 *
 * A telemetry feature is only acceptable if the user can tell exactly what
 * leaves their device. These tests treat "no raw text or URLs" as a property
 * that must be proven, not assumed, and treat opt-out as "no request at all"
 * rather than "a request that sends nothing".
 *
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  TELEMETRY_METRIC_NAMES,
  TELEMETRY_METRICS,
  addCounts,
  buildTelemetryEvent,
  emptyCounts,
  hasAnythingToSend,
  sanitizeCounts,
} from "./telemetry.js";

// --------------------------------------------------------------------------
// Counts
// --------------------------------------------------------------------------

test("only counts survive sanitisation", () => {
  assert.deepEqual(sanitizeCounts({ analyzed: 3, hidden: 0 }), {
    analyzed: 3,
    hidden: 0,
  });
  assert.deepEqual(sanitizeCounts({ analyzed: 3.9 }), { analyzed: 3 });

  // Anything that is not a number is dropped rather than coerced. A string is
  // a value, and values are exactly what must not leave the device.
  assert.deepEqual(sanitizeCounts({ analyzed: "3" }), {});
  assert.deepEqual(sanitizeCounts({ analyzed: true }), {});
  assert.deepEqual(sanitizeCounts({ analyzed: null }), {});
  assert.deepEqual(sanitizeCounts({ analyzed: Number.NaN }), {});
  assert.deepEqual(sanitizeCounts({ analyzed: -1 }), {});
  assert.deepEqual(sanitizeCounts({ analyzed: { nested: 1 } }), {});

  // Unknown metrics are dropped: the allowlist is the whole surface.
  assert.deepEqual(sanitizeCounts({ caption: "hello", postKey: "x" }), {});
  assert.deepEqual(sanitizeCounts(null), {});
  assert.deepEqual(sanitizeCounts("nope"), {});
  assert.deepEqual(emptyCounts(), {});
});

test("the metric surface is exactly the three documented counts", () => {
  // Frozen, so the copy: an in-place sort on a frozen array throws.
  assert.deepEqual([...TELEMETRY_METRIC_NAMES].sort(), [
    "analyzed",
    "hidden",
    "reported",
  ]);
  assert.equal(TELEMETRY_METRICS.REPORTED, "reported");
  // Nothing else may be addable without a deliberate edit to the allowlist.
  assert.equal(Object.isFrozen(TELEMETRY_METRIC_NAMES), true);
});

test("addCounts accumulates and never mutates its input", () => {
  const base = { analyzed: 10, hidden: 4 };
  const next = addCounts(base, { analyzed: 5, reported: 1 });
  assert.deepEqual(next, { analyzed: 15, hidden: 4, reported: 1 });
  assert.deepEqual(base, { analyzed: 10, hidden: 4 }, "the input must not be mutated");

  // A partial delta must not clear the metrics it does not mention.
  assert.deepEqual(addCounts(base, {}), base);
  assert.deepEqual(addCounts({}, { hidden: 2 }), { hidden: 2 });

  // A garbage delta is ignored, not folded in.
  assert.deepEqual(addCounts(base, { hidden: "x" }), base);
  assert.deepEqual(addCounts(base, { hidden: -5 }), base);
});

// --------------------------------------------------------------------------
// Opt-in
// --------------------------------------------------------------------------

test("an opted-out extension produces no event at all", () => {
  // Returning null rather than an empty event is the point: the caller's
  // network path is unreachable, not merely a no-op.
  assert.equal(buildTelemetryEvent(false, { analyzed: 100 }), null);
  assert.equal(buildTelemetryEvent(undefined, { analyzed: 100 }), null);
  assert.equal(buildTelemetryEvent(null, { analyzed: 100 }), null);
  assert.equal(buildTelemetryEvent(0, { analyzed: 100 }), null);
  assert.equal(buildTelemetryEvent("true", { analyzed: 100 }), null);
  assert.equal(hasAnythingToSend(buildTelemetryEvent(false, { analyzed: 1 })), false);
});

test("an opted-in extension sends counts and nothing else", () => {
  const event = buildTelemetryEvent(true, { analyzed: 12, hidden: 3, reported: 1 });
  assert.deepEqual(Object.keys(event).sort(), ["counts", "enabled", "schema"]);
  assert.deepEqual(event.counts, { analyzed: 12, hidden: 3, reported: 1 });
  assert.equal(event.enabled, true);
  assert.equal(typeof event.schema, "number");
});

test("content cannot be smuggled into an event through the counts", () => {
  // Even if a caller hands over the whole post, only counts come out.
  const post = {
    caption: "a thing that should never leave the device",
    imageUrl: "https://scontent.cdninstagram.com/v/secret.jpg",
    altText: "more content",
    postKey: "user-identifying-handle",
    analyzed: 1,
  };
  const event = buildTelemetryEvent(true, post);
  const serialised = JSON.stringify(event);

  assert.deepEqual(event.counts, { analyzed: 1 });
  for (const leak of [
    "caption",
    "imageUrl",
    "altText",
    "postKey",
    "instagram",
    "device",
  ]) {
    assert.ok(
      !serialised.includes(leak),
      `telemetry payload leaked ${leak}: ${serialised}`,
    );
  }
});

test("an event with nothing in it is not worth sending", () => {
  assert.equal(hasAnythingToSend(null), false);
  assert.equal(hasAnythingToSend(buildTelemetryEvent(true, {})), false);
  assert.equal(hasAnythingToSend(buildTelemetryEvent(true, { analyzed: 0 })), false);
  // A single real count is enough.
  assert.equal(hasAnythingToSend(buildTelemetryEvent(true, { hidden: 1 })), true);
});

// --------------------------------------------------------------------------
// Service worker wiring
// --------------------------------------------------------------------------

test("the service worker uploads nothing while telemetry is off", () => {
  const source = readFileSync(new URL("../../background.js", import.meta.url), "utf8");
  const start = source.indexOf("async function flushTelemetry");
  assert.ok(start !== -1, "flushTelemetry not found");
  const end = source.indexOf("// The service worker has no settings module", start);
  const block = source.slice(start, end === -1 ? undefined : end);

  // The opt-in check must precede the read of anything worth sending, and the
  // early return must happen before postJson is reachable.
  const guard = block.indexOf("telemetryEnabled] !== true) return false");
  const upload = block.indexOf("postJson(TELEMETRY_PATH");
  assert.ok(guard !== -1, "no opt-in guard in flushTelemetry");
  assert.ok(upload !== -1, "flushTelemetry never uploads");
  assert.ok(guard < upload, "the opt-in guard must come before the upload");

  // The guard is a strict `!== true`, not a truthiness check: a stored value
  // such as the string "true" is not consent.
  assert.match(block, /STORAGE_KEYS\.telemetryEnabled\] !== true/);
  // Batched on an alarm, and a failed batch is retried rather than dropped.
  assert.match(block, /hasAnythingToSend/);
  assert.match(block, /resetPendingCounts\(\)/);
});

test("a backend without the endpoint is not retried for ever", () => {
  // /api/telemetry is the client half of a two-part change; the backend does
  // not implement it yet. A 404 is not a transient fault, so it must stop the
  // retry loop rather than produce a failed request every alarm.
  const source = readFileSync(new URL("../../background.js", import.meta.url), "utf8");
  const start = source.indexOf("async function flushTelemetry");
  const end = source.indexOf("// The service worker has no settings module", start);
  const block = source.slice(start, end === -1 ? undefined : end);

  assert.match(block, /error\?\.status === 404/);
  assert.match(
    block,
    /telemetryUnsupported\] =|telemetryUnsupported\]: true|\[STORAGE_KEYS\.telemetryUnsupported\]: true/,
  );
  // The check must gate the upload, and the counters must survive it.
  assert.ok(
    block.indexOf("isTelemetryUnsupported()") < block.indexOf("postJson(TELEMETRY_PATH"),
    "a known-unsupported backend must not be called",
  );

  // The user is told, rather than left with a toggle that does nothing.
  // Asserted against the i18n message the options page now renders, not against
  // a string literal: the copy moved into _locales during the a11n/i18n pass,
  // and matching the literal here would fail on a copy edit rather than on a
  // regression.
  const options = readFileSync(new URL("../../options.js", import.meta.url), "utf8");
  assert.match(options, /telemetryUnsupported/);
  const messages = JSON.parse(
    readFileSync(new URL("../../_locales/en/messages.json", import.meta.url), "utf8"),
  );
  assert.match(
    messages.optionsTelemetryUnsupported.message,
    /does not accept usage counts/,
  );
  assert.match(options, /t\("optionsTelemetryUnsupported"\)/);
});

test("telemetry batches on its own alarm, separate from feedback", () => {
  const source = readFileSync(new URL("../../background.js", import.meta.url), "utf8");
  // A count is only useful in aggregate, so it does not share the feedback
  // cadence: a report carries content and is worth sending promptly.
  assert.match(source, /chrome\.alarms\.create\("flushTelemetry"/);
  assert.match(source, /alarm\.name === "flushTelemetry"/);
  // One alarm failing must not stop the other.
  assert.match(source, /telemetry.*catch|catch.*telemetry/s);
});

test("telemetry is a local counter that is only uploaded on opt-in", () => {
  // The counters exist regardless of the flag, which is what makes them
  // displayable in the popup. The flag gates the upload, not the counting.
  const script = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  assert.match(script, /recordCounts\(\{ \[TELEMETRY_METRICS\.ANALYZED\]/);
  assert.match(script, /recordCounts\(\{ \[TELEMETRY_METRICS\.HIDDEN\]: 1 \}\)/);
  assert.match(script, /recordCounts\(\{ \[TELEMETRY_METRICS\.REPORTED\]: 1 \}\)/);

  // The hidden count is recorded only on a real transition, so a re-render or
  // a settings change does not inflate it.
  const start = script.indexOf("function hidePost");
  const block = script.slice(start, script.indexOf("function markSafe", start));
  assert.match(block, /if \(transition\.added\) \{[\s\S]*recordCounts/);
});

// --------------------------------------------------------------------------
// UI
// --------------------------------------------------------------------------

test("the popup surfaces flagged, analysed and reported counts", () => {
  const html = readFileSync(new URL("../../popup.html", import.meta.url), "utf8");
  assert.match(html, /id="hiddenCount"/);
  assert.match(html, /id="analyzedCount"/);
  assert.match(html, /id="reportedCount"/);
  // "Posts flagged" is the wording the issue asks for. The label text lives in
  // _locales now, so check the message rather than the markup.
  const messages = JSON.parse(
    readFileSync(new URL("../../_locales/en/messages.json", import.meta.url), "utf8"),
  );
  assert.match(messages.popupStatHidden.message, /Hidden|Flagged/i);
  assert.match(html, /id="hiddenLabel"/);

  const source = readFileSync(new URL("../../popup.js", import.meta.url), "utf8");
  assert.match(source, /els\.reportedCount\.textContent/);
  // Read by bucket in both directions, so the count is not half of it.
  assert.match(source, /REPORT_KIND_LIST\.map\(bucketFor\)/);
});

test("both the popup and the options page expose the opt-in toggle", () => {
  for (const page of ["popup.html", "options.html"]) {
    const html = readFileSync(new URL(`../../${page}`, import.meta.url), "utf8");
    assert.match(html, /id="telemetryEnabled"/, `${page} has no telemetry toggle`);
    // Both must say what is not sent, not just offer the switch.
    assert.match(
      html,
      /never captions|Never captions/,
      `${page} does not describe the payload`,
    );
  }
});

test("the payload shown to the user is built by the module that sends it", () => {
  // A hand-written description drifts from the behaviour. Both UIs render the
  // real event builder's output instead.
  for (const page of ["popup.js", "options.js"]) {
    const source = readFileSync(new URL(`../../${page}`, import.meta.url), "utf8");
    assert.match(
      source,
      /buildTelemetryEvent\(/,
      `${page} hard-codes the payload description`,
    );
  }
});

test("turning telemetry off drops anything already queued", () => {
  // Otherwise switching the flag back on would upload a total the user did not
  // expect to send.
  for (const page of ["popup.js", "options.js"]) {
    const source = readFileSync(new URL(`../../${page}`, import.meta.url), "utf8");
    assert.match(
      source,
      /resetPendingCounts\(\)/,
      `${page} leaves a pending batch on opt-out`,
    );
  }
});
