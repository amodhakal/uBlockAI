/**
 * Trust list helpers, backing the options-page management UI.
 *
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { MAX_TRUSTED_KEYS } from "./defaults.js";
import {
  addTrustedKey,
  clearTrustedKeys,
  describeTrustedKey,
  normalizeTrustedKeys,
  removeTrustedKey,
} from "./trust.js";

const KEY = "https://scontent.cdninstagram.com/v/t51/pig.jpg_abc123";

test("addTrustedKey adds once, trims, and reports whether it changed", () => {
  const first = addTrustedKey([], KEY);
  assert.equal(first.added, true);
  assert.deepEqual(first.keys, [KEY]);

  // Padded input must not create a second, near-identical entry.
  const padded = addTrustedKey(first.keys, `  ${KEY}  `);
  assert.equal(padded.added, false);
  assert.deepEqual(padded.keys, [KEY]);

  assert.equal(addTrustedKey([KEY], "").added, false);
  assert.equal(addTrustedKey([KEY], null).added, false);
});

test("addTrustedKey bounds the list by dropping the oldest", () => {
  const oversized = Array.from({ length: MAX_TRUSTED_KEYS }, (_, i) => `k${i}`);
  const out = addTrustedKey(oversized, "newest");
  assert.equal(out.added, true);
  assert.equal(out.dropped, 1);
  assert.equal(out.keys.length, MAX_TRUSTED_KEYS);
  assert.equal(out.keys.at(-1), "newest");
  assert.ok(!out.keys.includes("k0"), "the oldest entry should be evicted");
});

test("removeTrustedKey and clearTrustedKeys report their effect", () => {
  const keys = ["a", "b", "c"];

  const miss = removeTrustedKey(keys, "zzz");
  assert.equal(miss.removed, false);
  assert.deepEqual(miss.keys, keys, "a miss must not produce a new array");

  const hit = removeTrustedKey(keys, "b");
  assert.equal(hit.removed, true);
  assert.deepEqual(hit.keys, ["a", "c"]);

  const cleared = clearTrustedKeys(keys);
  assert.deepEqual(cleared.keys, []);
  assert.equal(cleared.removed, 3);

  assert.equal(clearTrustedKeys([]).removed, 0);
});

test("normalizeTrustedKeys repairs anything a corrupted store hands over", () => {
  assert.deepEqual(normalizeTrustedKeys(null), []);
  assert.deepEqual(normalizeTrustedKeys("nope"), []);
  assert.deepEqual(normalizeTrustedKeys({ 0: "a" }), []);

  assert.deepEqual(normalizeTrustedKeys(["a", "a", " a ", "b"]), ["a", "b"]);
  assert.deepEqual(normalizeTrustedKeys(["a", 1, null, undefined, "", "b"]), ["a", "b"]);

  const oversized = normalizeTrustedKeys(
    Array.from({ length: MAX_TRUSTED_KEYS + 50 }, (_, i) => `k${i}`),
  );
  assert.equal(oversized.length, MAX_TRUSTED_KEYS);
  assert.equal(oversized.at(-1), `k${MAX_TRUSTED_KEYS + 49}`);
});

test("normalizeTrustedKeys round-trips a list built by the content script", () => {
  let keys = [];
  keys = addTrustedKey(keys, KEY).keys;
  keys = addTrustedKey(keys, "https://example.com/b.png").keys;
  assert.deepEqual(normalizeTrustedKeys(keys), keys);
});

test("describeTrustedKey shortens an opaque CDN key", () => {
  const label = describeTrustedKey(KEY);
  assert.ok(label.length <= 13, `label is ${label.length} chars: ${label}`);
  assert.ok(label.includes("…"), "a long key must be elided, not truncated silently");
  assert.ok(label.startsWith("pig"), "the stable prefix should survive");
  assert.ok(label.endsWith("123"), "the unique tail should survive");
});

test("describeTrustedKey handles short, query-laden and empty keys", () => {
  assert.equal(describeTrustedKey("abc"), "abc");
  assert.equal(describeTrustedKey(""), "(unknown post)");
  assert.equal(describeTrustedKey(null), "(unknown post)");
  // Query strings are CDN signature parameters, not identity.
  assert.equal(
    describeTrustedKey("https://x.test/img.png?stp=dst-jpg&_nc_cat=1"),
    "img.png",
  );
});

// --------------------------------------------------------------------------
// The options UI is the first place untrusted keys are rendered, so pin the
// XSS-safety contract at the source level.
// --------------------------------------------------------------------------

test("the options page renders trust keys without innerHTML", () => {
  const source = readFileSync(new URL("../../options.js", import.meta.url), "utf8");

  // The render function is the only place a key reaches the DOM.
  const start = source.indexOf("async function renderTrusted");
  assert.ok(start !== -1, "renderTrusted not found");
  const end = source.indexOf("async function onRemoveTrusted", start);
  const block = source.slice(start, end === -1 ? undefined : end);

  assert.ok(
    !block.includes("innerHTML"),
    "trust keys must never be interpolated as HTML",
  );
  assert.ok(!/insertAdjacentHTML|outerHTML|document\.write/.test(block));
  assert.match(block, /textContent/, "keys and labels must be assigned with textContent");
  assert.match(block, /createElement/);
});

test("every trust mutation goes through the pure helpers and reports failure", () => {
  const source = readFileSync(new URL("../../options.js", import.meta.url), "utf8");
  assert.match(source, /removeTrustedKey\(/);
  assert.match(source, /clearTrustedKeys\(/);
  // A failed write must surface, not silently leave the UI showing stale state.
  assert.ok(
    /Could not update the trust list/.test(source),
    "a failed trust-list write must be reported to the user",
  );
  // Storage is the only writer; the content script is notified by the storage
  // change, so nothing here may hand-mutate a live list.
  assert.match(source, /writeSync\(\{ \[STORAGE_KEYS\.trustedKeys\]/);
});

test("re-hiding a post after it is untrusted does not wait for a reload", () => {
  // A revealed post stays in hiddenKeys, so testing membership in reapplyAll
  // meant removing it from the trust list did nothing until the next reload.
  const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  const start = source.indexOf("function reapplyAll");
  assert.ok(start !== -1, "reapplyAll not found");
  const end = source.indexOf("async function scan", start);
  const block = source.slice(start, end === -1 ? undefined : end);

  assert.match(
    block,
    /trustedKeys\.has\(postKey\)/,
    "trust must win over the thresholds",
  );
  assert.match(
    block,
    /!element\.querySelector\("\.aibot-placeholder"\)/,
    "re-hiding must key off what is on screen, not off hiddenKeys membership",
  );
});

test("the settings listener ignores this script's own counter writes", () => {
  // An unfiltered listener fired for every storage.local counter write, turning
  // one hide into a write -> change -> reapplyAll -> write cycle.
  const source = readFileSync(new URL("./settings.js", import.meta.url), "utf8");
  const start = source.indexOf("export function onSettingsChanged");
  assert.ok(start !== -1);
  const block = source.slice(start);
  assert.match(block, /STORAGE_AREAS\.SYNC/, "must be scoped to the sync area");
  assert.match(block, /SETTINGS_KEYS\.some/);
});
