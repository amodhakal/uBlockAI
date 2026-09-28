/**
 * Unit tests for the pure logic extracted from the content script.
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_AI_GENERATED_THRESHOLD,
  DEFAULT_NEWS_THRESHOLD,
  fromSlider,
  shouldHidePost,
  toSlider,
} from "./defaults.js";
import {
  LruCache,
  compactStorageKey,
  stableCacheKey,
  stripSignatureParams,
} from "./cache.js";
import { escapeHtml, safeUrl, stripTags } from "./sanitize.js";
import { runBounded, withTimeout } from "./concurrency.js";
import { adapterForUrl, matchesPattern } from "../adapters/index.js";

// --------------------------------------------------------------------------
// Thresholds
// --------------------------------------------------------------------------

test("slider round-trips through the score domain", () => {
  for (const value of [0, 0.1, 0.25, 0.3, 0.5, 0.75, 1]) {
    assert.ok(Math.abs(fromSlider(toSlider(value)) - value) < 0.1, `failed at ${value}`);
  }
});

test("slider default matches the code default", () => {
  // The first-run mismatch: the slider showed 7 (0.7) while the code used 0.3.
  // Both now derive from the same constants, so the displayed default and the
  // applied default cannot drift.
  for (const value of [DEFAULT_AI_GENERATED_THRESHOLD, DEFAULT_NEWS_THRESHOLD]) {
    assert.ok(Math.abs(fromSlider(toSlider(value)) - value) <= 1 / 9);
  }
  assert.notEqual(toSlider(DEFAULT_AI_GENERATED_THRESHOLD), 7);
});

test("slider clamps out-of-range input", () => {
  assert.equal(toSlider(-5), 1);
  assert.equal(toSlider(5), 10);
  assert.equal(fromSlider(-1), 0);
  assert.equal(fromSlider(99), 1);
});

test("thresholds are inclusive on both axes", () => {
  assert.equal(shouldHidePost(0.3, 0, 0.3, 0.2), true);
  assert.equal(shouldHidePost(0.29, 0, 0.3, 0.2), false);
  assert.equal(shouldHidePost(0, 0.2, 0.3, 0.2), true);
  assert.equal(shouldHidePost(0, 0.19, 0.3, 0.2), false);
  assert.equal(shouldHidePost(0, 0, 0.3, 0.2), false);
});

// --------------------------------------------------------------------------
// Cache
// --------------------------------------------------------------------------

test("LruCache evicts the least recently used entry", () => {
  const cache = new LruCache(3);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  cache.get("a"); // 'a' becomes most recent, so 'b' is now oldest
  cache.set("d", 4);

  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.get("d"), 4);
  assert.equal(cache.size, 3);
});

test("LruCache is bounded under sustained writes", () => {
  const cache = new LruCache(10);
  for (let i = 0; i < 1000; i += 1) cache.set(`k${i}`, i);
  assert.equal(cache.size, 10);
});

test("cache key ignores expiring CDN signature parameters", () => {
  const first =
    "https://scontent.cdninstagram.com/v/x.jpg?stp=dst-jpg&_nc_cat=1&ccb=7&ig_cache_key=AAA";
  const second =
    "https://scontent.cdninstagram.com/v/x.jpg?stp=dst-png&_nc_cat=2&ccb=9&ig_cache_key=BBB";
  assert.equal(stableCacheKey({ imageUrl: first }), stableCacheKey({ imageUrl: second }));
});

test("cache key prefers a stable media id", () => {
  assert.equal(
    stableCacheKey({ mediaId: "999", imageUrl: "https://x/a.jpg?ccb=1" }),
    "mid:999",
  );
});

test("cache key falls back to the permalink", () => {
  assert.equal(stableCacheKey({ permalink: "/p/ABC123/" }), "p:ABC123");
});

test("stripSignatureParams removes only volatile params", () => {
  const out = stripSignatureParams("https://x/y.jpg?stp=a&keep=1&ccb=7#frag");
  assert.ok(out.includes("keep=1"));
  assert.ok(!out.includes("stp"));
  assert.ok(!out.includes("ccb"));
  assert.ok(!out.includes("frag"));
});

test("compact storage key is short, stable and distinct", () => {
  const a = compactStorageKey("url:https://x/a.jpg");
  const b = compactStorageKey("url:https://x/b.jpg");
  assert.equal(a, compactStorageKey("url:https://x/a.jpg"));
  assert.notEqual(a, b);
  assert.ok(a.length < 16, `key too long for the storage quota: ${a.length}`);
});

// --------------------------------------------------------------------------
// Sanitisation
// --------------------------------------------------------------------------

test("escapeHtml neutralises tag and attribute injection", () => {
  const attack = '<img src=x onerror="alert(1)">';
  const escaped = escapeHtml(attack);
  assert.ok(!escaped.includes("<"));
  assert.ok(!escaped.includes(">"));
  assert.ok(escaped.includes("&lt;"));
  assert.ok(escaped.includes("&quot;"));
});

test("escapeHtml handles null and undefined", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("safeUrl rejects javascript and data schemes", () => {
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("data:text/html,<script>"), "");
  assert.equal(safeUrl("https://ok/x.jpg"), "https://ok/x.jpg");
  assert.equal(safeUrl(""), "");
});

test("stripTags removes markup", () => {
  assert.equal(stripTags("<b>bold</b>  text"), "bold text");
});

// --------------------------------------------------------------------------
// Concurrency
// --------------------------------------------------------------------------

test("runBounded preserves input order", async () => {
  const results = await runBounded(
    [() => Promise.resolve("a"), () => Promise.resolve("b"), () => Promise.resolve("c")],
    2,
  );
  assert.deepEqual(
    results.map((r) => r.value),
    ["a", "b", "c"],
  );
});

test("runBounded caps concurrency", async () => {
  let active = 0;
  let peak = 0;
  const task = () =>
    new Promise((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active -= 1;
        resolve("ok");
      }, 20);
    });

  // Tasks must be thunks, not promises: runBounded invokes each one.
  await runBounded(
    Array.from({ length: 10 }, () => task),
    3,
  );
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  assert.ok(peak > 1, "tasks did not run concurrently");
});

test("runBounded captures failures without rejecting", async () => {
  const results = await runBounded(
    [
      () => Promise.resolve("ok"),
      () => Promise.reject(new Error("boom")),
      () => Promise.resolve("ok"),
    ],
    2,
  );
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error.message, /boom/);
  assert.equal(results[2].ok, true);
});

test("runBounded handles an empty task list", async () => {
  assert.deepEqual(await runBounded([], 4), []);
});

test("withTimeout rejects a hung operation", async () => {
  const hung = () => new Promise(() => {});
  await assert.rejects(() => withTimeout(hung, 30, "analysis"), /timed out after 30ms/);
});

test("withTimeout resolves a fast operation", async () => {
  assert.equal(await withTimeout(() => Promise.resolve("done"), 500), "done");
});

// --------------------------------------------------------------------------
// Adapters
// --------------------------------------------------------------------------

test("matchesPattern handles wildcards and exact matches", () => {
  assert.ok(matchesPattern("https://www.instagram.com/x", "https://www.instagram.com/*"));
  assert.ok(!matchesPattern("https://evil.com/x", "https://www.instagram.com/*"));
  assert.ok(matchesPattern("https://x.com", "*"));
});

test("adapterForUrl picks the platform adapter", () => {
  assert.equal(adapterForUrl("https://www.instagram.com/").id, "instagram");
  assert.equal(adapterForUrl("https://example.com/").id, "generic");
});
