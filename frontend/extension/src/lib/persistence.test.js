/**
 * Cache bounding, persistence budgets and the trust list.
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { LruCache, compactStorageKey, stableCacheKey } from "./cache.js";
import { MAX_SYNC_ITEM_BYTES, MAX_TRUSTED_KEYS } from "./defaults.js";
import {
  SYNC_ITEM_BUDGET,
  createDebouncedWriter,
  estimateBytes,
  trimToByteBudget,
} from "./persistence.js";
import { addTrustedKey } from "./trust.js";

// --------------------------------------------------------------------------
// TTL and eviction
// --------------------------------------------------------------------------

test("LruCache honours a TTL", () => {
  let now = 1000;
  const cache = new LruCache(10, { ttlMs: 100, now: () => now });
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
  now += 101;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.size, 0);
});

test("LruCache still accepts a bare maxEntries argument", () => {
  const cache = new LruCache(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.size, 2);
});

test("LruCache reports evictions through onEvict", () => {
  const evicted = [];
  let now = 0;
  const cache = new LruCache(2, {
    ttlMs: 50,
    now: () => now,
    onEvict: (k, v) => evicted.push([k, v]),
  });

  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3); // capacity evicts "a"
  assert.deepEqual(evicted, [["a", 1]]);

  now = 100;
  cache.get("b"); // expired
  assert.deepEqual(evicted[1], ["b", 2]);
});

test("LruCache prune drops every expired entry", () => {
  let now = 0;
  const cache = new LruCache(10, { ttlMs: 10, now: () => now });
  cache.set("a", 1);
  cache.set("b", 2);
  now = 50;
  cache.set("c", 3);
  assert.equal(cache.prune(), 2);
  assert.equal(cache.size, 1);
});

test("LruCache has() expires like get()", () => {
  let now = 0;
  const cache = new LruCache(5, { ttlMs: 10, now: () => now });
  cache.set("a", 1);
  assert.equal(cache.has("a"), true);
  now = 20;
  assert.equal(cache.has("a"), false);
});

// --------------------------------------------------------------------------
// Stable cache keys
// --------------------------------------------------------------------------

test("stableCacheKey keys a reel on its permalink, not its CDN URL", () => {
  // The permalink regex only matched /p/ while the adapter also produced
  // /reel/ links, so every reel fell through to a CDN-URL key.
  const key = stableCacheKey({
    permalink: "/reel/Cabc123/",
    imageUrl: "https://scontent.cdninstagram.com/x.jpg?ccb=1",
  });
  assert.ok(key.startsWith("p:"), `expected a permalink key, got ${key}`);
});

test("stableCacheKey keys a tv and a reels permalink", () => {
  assert.ok(stableCacheKey({ permalink: "/tv/DEF/" }).startsWith("p:"));
  assert.ok(stableCacheKey({ permalink: "/reels/GHI/" }).startsWith("p:"));
});

test("stableCacheKey prefers mediaId over permalink and url", () => {
  const key = stableCacheKey({
    mediaId: "999",
    permalink: "/p/ABC/",
    imageUrl: "https://x/a.jpg?ccb=1",
  });
  assert.equal(key, "mid:999");
});

test("stableCacheKey returns empty when there is no identifier", () => {
  assert.equal(stableCacheKey({}), "");
  assert.equal(stableCacheKey(null), "");
});

// --------------------------------------------------------------------------
// Persistence budget
// --------------------------------------------------------------------------

test("estimateBytes counts UTF-8 bytes, not code units", () => {
  // "é" is two UTF-8 bytes but one JS string character. An ASCII assumption
  // here would undercount and let a write exceed the quota it believed it
  // respected.
  assert.equal(estimateBytes("é"), '"é"'.length + 1);
  assert.ok(estimateBytes("é") > "é".length);
});

test("trimToByteBudget keeps the most recent values", () => {
  const values = Array.from({ length: 500 }, (_, i) =>
    compactStorageKey(`url:https://x/${i}.jpg`),
  );
  const { values: kept, dropped } = trimToByteBudget(values);
  assert.ok(dropped > 0, "expected the list to be trimmed");
  assert.equal(kept.length, values.length - dropped);
  assert.equal(kept[kept.length - 1], values[values.length - 1]);
});

test("trimToByteBudget output fits the per-item cap", () => {
  // The direct regression test: 500 digests must not exceed the 8 KB item cap.
  const values = Array.from({ length: 500 }, (_, i) =>
    compactStorageKey(`url:https://x/${i}.jpg`),
  );
  const { values: kept } = trimToByteBudget(values);
  assert.ok(
    estimateBytes(kept) <= MAX_SYNC_ITEM_BYTES,
    `serialized size ${estimateBytes(kept)} exceeds the ${MAX_SYNC_ITEM_BYTES} byte cap`,
  );
  assert.ok(SYNC_ITEM_BUDGET < MAX_SYNC_ITEM_BYTES, "budget should leave headroom");
});

test("trimToByteBudget is a no-op when the list already fits", () => {
  const { values: kept, dropped } = trimToByteBudget(["a", "b", "c"]);
  assert.deepEqual(kept, ["a", "b", "c"]);
  assert.equal(dropped, 0);
});

test("trimToByteBudget never returns an empty list for a non-empty input", () => {
  const { values: kept } = trimToByteBudget(["a"], 0);
  assert.equal(kept.length, 1);
});

// --------------------------------------------------------------------------
// Debounced writer
// --------------------------------------------------------------------------

test("createDebouncedWriter coalesces a burst into one write", async () => {
  const writes = [];
  const writer = createDebouncedWriter(
    (v) => {
      writes.push(v);
      return { ok: true };
    },
    20,
    200,
  );

  for (let i = 0; i < 20; i += 1) writer.push(i);
  assert.equal(writes.length, 0, "wrote before the interval elapsed");

  await writer.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0], 19, "should persist the latest value, not the first");
});

test("createDebouncedWriter honours maxWaitMs under a continuous stream", async () => {
  const writes = [];
  // waitMs is far longer than maxWaitMs, so the only thing that can produce a
  // write during the stream is the max-wait re-arm.
  const writer = createDebouncedWriter(
    (v) => {
      writes.push(v);
      return { ok: true };
    },
    5000,
    40,
  );

  for (let i = 0; i < 8; i += 1) {
    writer.push(i);
    await new Promise((r) => setTimeout(r, 15));
  }

  // Count writes before the explicit flush, so the assertion is about the
  // max-wait path and not about the flush.
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(writes.length >= 1, `maxWaitMs did not fire; got ${writes.length} writes`);

  await writer.flush();
  assert.equal(
    writes[writes.length - 1],
    7,
    "the latest value must be the one persisted",
  );
});

// --------------------------------------------------------------------------
// Trust list
// --------------------------------------------------------------------------

test("addTrustedKey dedupes and bounds the list", () => {
  let keys = [];
  const first = addTrustedKey(keys, "p:1");
  assert.equal(first.added, true);
  keys = first.keys;

  const again = addTrustedKey(keys, "p:1");
  assert.equal(again.added, false);
  assert.equal(again.keys.length, 1);

  for (let i = 0; i < MAX_TRUSTED_KEYS + 50; i += 1) {
    keys = addTrustedKey(keys, `p:${i}`).keys;
  }
  assert.ok(keys.length <= MAX_TRUSTED_KEYS, `list grew to ${keys.length}`);
  assert.equal(keys[keys.length - 1], `p:${MAX_TRUSTED_KEYS + 49}`, "keeps the newest");
});

// --------------------------------------------------------------------------
// Source-level guards
// --------------------------------------------------------------------------

test("the content script does not cache a failed analysis", () => {
  // A cached failure record makes a post permanently un-analysable, which is
  // the bug the request timeout was added to prevent.
  const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  assert.match(source, /if \(!value\.error\) resultCache\.set\(/);
});

test("markSafe routes through markPost, which records the post key", () => {
  // The behaviour is covered in dom.test.js. This guards the wiring, so a
  // future refactor cannot reintroduce a markSafe that skips the key and makes
  // safe posts invisible to threshold re-evaluation.
  const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  const start = source.indexOf("function markSafe");
  const body = source.slice(start, start + 900);
  assert.match(body, /markPost\(element, \{ postKey, state: "safe" \}\)/);
});

test("the original content store is bounded", () => {
  const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  const declaration = source.match(/const originalContent = new (\w+)\(/);
  assert.ok(declaration, "originalContent is not declared the way this test expects");
  assert.equal(
    declaration[1],
    "LruCache",
    "originalContent must be bounded, not an unbounded Map",
  );
});

test("the result cache is constructed with a TTL", () => {
  const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  assert.match(source, /ttlMs: RESULT_TTL_MS/);
});
