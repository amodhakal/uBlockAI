/**
 * The feedback loop, in both directions.
 *
 * A report the user cannot submit is worse than no report button at all: it is
 * a promise the extension does not keep. These tests pin the wiring from the
 * control in the page, through the queue, to the uploader.
 *
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { STORAGE_KEYS } from "./defaults.js";
import { REPORT_BUCKETS, REPORT_KIND_LIST, REPORT_KINDS, bucketFor } from "./feedback.js";

// --------------------------------------------------------------------------
// Report kinds
// --------------------------------------------------------------------------

test("both directions of the feedback loop exist", () => {
  // Before this layer the false-negative path was unreachable from the page:
  // there was no control that produced one.
  assert.equal(REPORT_KINDS.FALSE_POSITIVE, "falsePositive");
  assert.equal(REPORT_KINDS.FALSE_NEGATIVE, "falseNegative");
  assert.deepEqual(REPORT_KIND_LIST, ["falsePositive", "falseNegative"]);
});

test("each report kind maps to its own storage bucket", () => {
  // The uploader used to read the queue by *kind* rather than by bucket, so
  // `readSync(["falsePositive"])` never saw the array written to
  // `falsePositiveReports` and reports accumulated forever.
  assert.equal(bucketFor(REPORT_KINDS.FALSE_POSITIVE), STORAGE_KEYS.falsePositiveReports);
  assert.equal(bucketFor(REPORT_KINDS.FALSE_NEGATIVE), STORAGE_KEYS.falseNegativeReports);
  assert.notEqual(
    REPORT_BUCKETS[REPORT_KINDS.FALSE_POSITIVE],
    REPORT_BUCKETS[REPORT_KINDS.FALSE_NEGATIVE],
  );

  // No kind may resolve to a bucket that is not one of the two queues.
  for (const kind of REPORT_KIND_LIST) {
    assert.ok(
      Object.values(STORAGE_KEYS).includes(bucketFor(kind)),
      `${kind} resolves to a bucket outside STORAGE_KEYS`,
    );
  }
});

test("an unknown kind falls back to the false-positive queue rather than losing the report", () => {
  assert.equal(bucketFor("nonsense"), STORAGE_KEYS.falsePositiveReports);
  assert.equal(bucketFor(undefined), STORAGE_KEYS.falsePositiveReports);
});

// --------------------------------------------------------------------------
// Behaviour, against an in-memory chrome.storage
// --------------------------------------------------------------------------

/**
 * Install a minimal in-memory chrome.storage.
 *
 * The assertions that matter here are about which key a report lands under and
 * whether a repeat submission is refused. Both are only observable through the
 * storage layer, so a source read cannot stand in for them.
 */
function withFakeStorage() {
  const store = { local: {}, sync: {} };
  globalThis.chrome = {
    storage: {
      onChanged: { addListener() {}, removeListener() {} },
      local: {
        get(keys, cb) {
          const out = {};
          for (const key of [].concat(keys)) {
            if (key in store.local) out[key] = store.local[key];
          }
          cb(out);
        },
        set(items, cb) {
          Object.assign(store.local, items);
          cb();
        },
      },
      sync: {
        get(keys, cb) {
          const out = {};
          for (const key of [].concat(keys)) {
            if (key in store.sync) out[key] = store.sync[key];
          }
          cb(out);
        },
        set(items, cb) {
          Object.assign(store.sync, items);
          cb();
        },
      },
    },
    runtime: { lastError: undefined },
  };
  return store;
}

test("a report lands under its own bucket and repeats are refused", async () => {
  const store = withFakeStorage();
  // Imported lazily: settings.js resolves chrome.storage at call time, so the
  // mock has to be in place before the first call, not before the import.
  const { queueReport, readReportedKeys, hasReported } = await import("./feedback.js");

  const first = await queueReport({
    postKey: "post:1",
    kind: REPORT_KINDS.FALSE_NEGATIVE,
    caption: "x".repeat(5000),
    imageUrl: "https://scontent.cdninstagram.com/v/p.jpg",
  });
  assert.equal(first.queued, true);

  // Written under the bucket key the uploader reads, not under the kind.
  assert.ok(Array.isArray(store.local[STORAGE_KEYS.falseNegativeReports]));
  assert.equal(store.local[STORAGE_KEYS.falsePositiveReports], undefined);

  const entry = store.local[STORAGE_KEYS.falseNegativeReports][0];
  assert.equal(entry.type, "falseNegative");
  assert.equal(entry.postKey, "post:1");
  assert.equal(entry.caption.length, 1000, "captions are bounded before storage");

  // A repeat submission is refused: the backend must not see the same post
  // twice because a user scrolled it back into view.
  const second = await queueReport({
    postKey: "post:1",
    kind: REPORT_KINDS.FALSE_NEGATIVE,
  });
  assert.equal(second.queued, false);
  assert.equal(store.local[STORAGE_KEYS.falseNegativeReports].length, 1);

  // The two directions are independent queues.
  await queueReport({ postKey: "post:1", kind: REPORT_KINDS.FALSE_POSITIVE });
  assert.equal(store.local[STORAGE_KEYS.falsePositiveReports].length, 1);
  assert.equal(store.local[STORAGE_KEYS.falseNegativeReports].length, 1);

  assert.equal(await hasReported(REPORT_KINDS.FALSE_NEGATIVE, "post:1"), true);
  assert.equal(await hasReported(REPORT_KINDS.FALSE_NEGATIVE, "post:2"), false);

  // Markers are `kind:postKey`, so both directions of the same post survive
  // the reload as distinct entries.
  assert.deepEqual((await readReportedKeys()).sort(), [
    "falseNegative:post:1",
    "falsePositive:post:1",
  ]);

  // A post with no key is never queued.
  assert.equal(
    (await queueReport({ postKey: "", kind: REPORT_KINDS.FALSE_POSITIVE })).queued,
    false,
  );

  delete globalThis.chrome;
});

test("draining drops stale reports and keeps the fresh ones", async () => {
  withFakeStorage();
  const { drainReports, clearReports } = await import("./feedback.js");
  const bucket = bucketFor(REPORT_KINDS.FALSE_POSITIVE);

  globalThis.chrome.storage.local.set(
    {
      [bucket]: [
        {
          postKey: "old",
          type: "falsePositive",
          timestamp: Date.now() - 40 * 24 * 3600 * 1000,
        },
        { postKey: "new", type: "falsePositive", timestamp: Date.now() },
      ],
    },
    () => {},
  );

  const fresh = await drainReports(REPORT_KINDS.FALSE_POSITIVE);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].postKey, "new");

  // A report with no timestamp is not silently treated as ancient.
  globalThis.chrome.storage.local.set(
    { [bucket]: [{ postKey: "undated", type: "falsePositive" }] },
    () => {},
  );
  assert.equal((await drainReports(REPORT_KINDS.FALSE_POSITIVE)).length, 0);

  await clearReports(REPORT_KINDS.FALSE_POSITIVE);
  assert.deepEqual(await drainReports(REPORT_KINDS.FALSE_POSITIVE), []);

  delete globalThis.chrome;
});

// --------------------------------------------------------------------------
// Content script wiring
// --------------------------------------------------------------------------

test("the content script queues both report kinds", () => {
  const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  for (const kind of REPORT_KIND_LIST) {
    assert.ok(
      source.includes(
        `REPORT_KINDS.${kind === "falsePositive" ? "FALSE_POSITIVE" : "FALSE_NEGATIVE"}`,
      ),
      `${kind} is never queued from the content script`,
    );
  }
  // Report through one helper, so the dedupe and the in-memory marker apply to
  // both directions.
  assert.match(source, /function reportPost\(post, postKey, kind\)/);
  assert.match(source, /reportedKeys\.add\(marker\)/);
});

test("an unflagged post gets a report control", () => {
  // A post that scored below both thresholds used to be shown silently, so the
  // only reports the backend could ever receive were "you hid something you
  // shouldn't have".
  const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  const start = source.indexOf("function markSafe");
  assert.ok(start !== -1, "markSafe not found");
  const end = source.indexOf("function reportPost", start);
  const block = source.slice(start, end === -1 ? undefined : end);

  assert.match(block, /mountReportControl\(/);
  assert.match(block, /FALSE_NEGATIVE/);
});

test("every placeholder mount that offers a report button has a handler", () => {
  // mountPlaceholder only attaches the listener when a handler is supplied, so
  // a mount without onReport renders a control that silently does nothing.
  const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  const mounts = [...source.matchAll(/mountPlaceholder\(([\s\S]*?)\n {4}\);/g)];
  assert.ok(
    mounts.length >= 2,
    `expected at least two placeholder mounts, saw ${mounts.length}`,
  );

  for (const [, body] of mounts) {
    assert.match(body, /onReport:/, "a placeholder mount is missing its report handler");
  }
});

test("report state survives a reload", () => {
  // Reported posts come back with the control disabled rather than offering the
  // same post to the backend a second time.
  const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  assert.match(source, /readReportedKeys\(\)/);
  assert.match(source, /reportedKeys\.has\(`\$\{REPORT_KINDS\.FALSE_POSITIVE\}/);
  assert.match(source, /reportedKeys\.has\(`\$\{REPORT_KINDS\.FALSE_NEGATIVE\}/);
});

test("reports are queued from a click, not from a scan", () => {
  // queueing from the scan path would report every post the user happened to
  // scroll past.
  const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  const start = source.indexOf("async function scan");
  const block = source.slice(start);
  assert.ok(!block.includes("reportPost("), "the scan path must never queue a report");
});

// --------------------------------------------------------------------------
// Service worker wiring
// --------------------------------------------------------------------------

test("the uploader reads and clears the queue by bucket, not by kind", () => {
  const source = readFileSync(new URL("../../background.js", import.meta.url), "utf8");
  const start = source.indexOf("async function flushOne");
  assert.ok(start !== -1, "flushOne not found");
  const end = source.indexOf("// The service worker has no settings module", start);
  const block = source.slice(start, end === -1 ? undefined : end);

  assert.match(block, /const bucket = bucketFor\(kind\)/);
  assert.match(block, /readSync\(\[bucket\]/);
  assert.match(block, /const queue = data\[bucket\]/);
  assert.match(block, /writeSync\(\{ \[bucket\]: \[\] \}/);

  // The exact bug this replaces.
  assert.ok(
    !/readSync\(\[kind\]/.test(block),
    "must not look the queue up by report kind",
  );
  assert.ok(
    !/\{ \[kind\]: \[\] \}/.test(block),
    "must not clear a key that is not a queue",
  );

  // Both kinds, so false negatives are uploaded as well as false positives.
  assert.match(source, /for \(const kind of REPORT_KIND_LIST\)/);
});

test("the uploaded report carries the kind the user chose", () => {
  // The backend stores `type` verbatim; collapsing both directions into one
  // value would make the false-negative reports indistinguishable.
  const source = readFileSync(new URL("../../background.js", import.meta.url), "utf8");
  assert.match(source, /type: entry\.type/);
});

// --------------------------------------------------------------------------
// Redaction
// --------------------------------------------------------------------------

test("report payloads are redacted before anything is logged", () => {
  const logging = readFileSync(new URL("./logging.js", import.meta.url), "utf8");
  for (const key of ["caption", "imageurl", "post_key"]) {
    assert.ok(
      logging.toLowerCase().includes(key),
      `${key} is not a redacted key, so a report could reach the console verbatim`,
    );
  }
  // The content script's one feedback log line must pass through logDebug,
  // which redacts, rather than console directly.
  const script = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  const start = script.indexOf("function reportPost");
  const block = script.slice(start, script.indexOf("function revealPost", start));
  assert.match(block, /logDebug\("feedback"/);
  assert.ok(
    !/console\./.test(block),
    "the report path must not write to the console directly",
  );
});
