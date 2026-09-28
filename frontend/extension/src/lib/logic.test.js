/**
 * Unit tests for the pure logic extracted from the content script.
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  DEFAULT_AI_GENERATED_THRESHOLD,
  DEFAULT_NEWS_THRESHOLD,
  HIDING_ACTIONS,
  MAX_ALT_TEXT_CHARS,
  MAX_CAPTION_CHARS,
  fromSlider,
  shouldHidePost,
  toSlider,
} from "./defaults.js";
import { buildAnalyzePayload, truncate } from "./payload.js";
import { DEFAULT_BACKEND_URL, normalizeBackendUrl, parseBackendUrl } from "./settings.js";
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

// --------------------------------------------------------------------------
// Backend URL configuration
// --------------------------------------------------------------------------

test("parseBackendUrl accepts an https origin and strips trailing slashes", () => {
  for (const input of [
    "https://api.example.com",
    "https://api.example.com/",
    "https://api.example.com///",
    "  https://api.example.com  ",
  ]) {
    const out = parseBackendUrl(input);
    assert.equal(out.ok, true, `rejected ${input}`);
    assert.equal(out.url, "https://api.example.com");
  }
});

test("parseBackendUrl accepts http on loopback only", () => {
  assert.equal(parseBackendUrl("http://localhost:8000").ok, true);
  assert.equal(parseBackendUrl("http://127.0.0.1:8000").ok, true);
  const remote = parseBackendUrl("http://api.example.com");
  assert.equal(remote.ok, false);
  assert.match(remote.error, /localhost/);
});

test("parseBackendUrl rejects dangerous and malformed schemes", () => {
  for (const input of [
    "javascript:alert(1)",
    "data:text/html,<script>",
    "file:///etc/passwd",
    "ftp://example.com",
    "not a url",
    "",
    "   ",
  ]) {
    assert.equal(parseBackendUrl(input).ok, false, `accepted ${input}`);
  }
});

test("parseBackendUrl rejects a path, query or fragment", () => {
  assert.equal(parseBackendUrl("https://api.example.com/v1").ok, false);
  assert.equal(parseBackendUrl("https://api.example.com?a=1").ok, false);
  assert.equal(parseBackendUrl("https://api.example.com#x").ok, false);
});

test("normalizeBackendUrl falls back to the default for anything rejected", () => {
  for (const input of ["", "garbage", "javascript:alert(1)", "https://x.example/p"]) {
    assert.equal(normalizeBackendUrl(input), DEFAULT_BACKEND_URL);
  }
});

test("normalizeBackendUrl is idempotent", () => {
  const once = normalizeBackendUrl("https://api.example.com/");
  assert.equal(normalizeBackendUrl(once), once);
});

// --------------------------------------------------------------------------
// Payload limits
// --------------------------------------------------------------------------

test("truncate keeps short text verbatim and marks cut text", () => {
  assert.equal(truncate("hello", 10), "hello");
  const cut = truncate("x".repeat(50), 10);
  assert.equal(cut.length, 10);
  assert.ok(cut.endsWith("…"));
});

test("buildAnalyzePayload does not cut a long caption at 100 characters", () => {
  // The original bug: captions were truncated to 100 chars, discarding most of
  // the claim. A 500-character caption must arrive intact.
  const caption = "s".repeat(500);
  const payload = buildAnalyzePayload({ imageUrl: "u", caption }, "p:1");
  assert.equal(payload.caption, caption);
  assert.equal(payload.caption.length, 500);
});

test("buildAnalyzePayload caps caption and alt text at their constants", () => {
  const payload = buildAnalyzePayload(
    {
      imageUrl: "u",
      caption: "c".repeat(MAX_CAPTION_CHARS + 500),
      imageAlt: "a".repeat(9999),
    },
    "p:1",
  );
  assert.ok(payload.caption.length <= MAX_CAPTION_CHARS);
  assert.ok(payload.alt_text.length <= MAX_ALT_TEXT_CHARS);
});

test("buildAnalyzePayload carries the permalink and video flag", () => {
  const payload = buildAnalyzePayload(
    { imageUrl: "u", caption: "c", permalink: "/p/ABC/", isVideo: true },
    "p:ABC",
  );
  assert.deepEqual(payload.metadata, { permalink: "/p/ABC/" });
  assert.equal(payload.is_video, true);
  assert.equal(payload.post_key, "p:ABC");
});

// --------------------------------------------------------------------------
// Drift guards: the markup must not restate the shared constants
// --------------------------------------------------------------------------

test("popup.html does not hardcode the slider range", () => {
  const html = readFileSync(new URL("../../popup.html", import.meta.url), "utf8");
  assert.ok(!/type="range"[\s\S]{0,200}?min="/.test(html), "slider min is hardcoded");
  assert.ok(!/type="range"[\s\S]{0,200}?max="/.test(html), "slider max is hardcoded");
});

test("popup.html does not restate the hiding actions", () => {
  const html = readFileSync(new URL("../../popup.html", import.meta.url), "utf8");
  for (const action of Object.values(HIDING_ACTIONS)) {
    assert.ok(!html.includes(`value="${action}"`), `${action} is hardcoded in markup`);
  }
});

test("manifest.json declares the options page the popup links to", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
  );
  assert.ok(
    manifest.options_ui,
    "options_ui missing: openOptionsPage() would be a no-op",
  );
  assert.equal(manifest.options_ui.page, "options.html");
});

test("manifest.json requests a host permission for the default backend", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
  );
  const hosts = [
    ...(manifest.host_permissions || []),
    ...(manifest.optional_host_permissions || []),
  ];
  const parsed = new URL(DEFAULT_BACKEND_URL);
  const suffix = `${parsed.origin}/*`;
  assert.ok(
    hosts.includes(suffix),
    `no host permission for the default backend (${suffix}); requests would fail`,
  );
});
