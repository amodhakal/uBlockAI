/**
 * Redaction, the debug gate, and retry backoff.
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { MAX_ANALYSIS_ATTEMPTS, RETRY_BASE_MS } from "./defaults.js";
import { logDebug, logError, redact, setDebug } from "./logging.js";
import { clearFailure, nextRetryAt, recordFailure, shouldSkip } from "./retry.js";

function capture(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args);
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

// --------------------------------------------------------------------------
// Redaction
// --------------------------------------------------------------------------

test("redact replaces a value whose key looks sensitive", () => {
  assert.equal(redact({ apiKey: "sk-live-abc" }).apiKey, "[redacted]");
  assert.equal(redact({ caption: "my private post" }).caption, "[redacted]");
  assert.equal(redact({ postKey: "url:https://x/a.jpg" }).postKey, "[redacted]");
});

test("redact keeps non-sensitive keys", () => {
  const input = { postCount: 3, verdict: "likely_true", nested: { score: 0.5 } };
  assert.deepEqual(redact(input), input);
});

test("redact matches keys case-insensitively and by substring", () => {
  for (const key of ["API_KEY", "Authorization", "myToken", "x-api-key", "X_API_KEY"]) {
    assert.equal(redact({ [key]: "sensitive" })[key], "[redacted]", `missed ${key}`);
  }
});

test("redact truncates long strings and says so", () => {
  const out = redact({ note: "x".repeat(500) });
  assert.match(out.note, /…\(500 chars\)$/);
  assert.ok(out.note.length < 500);
});

test("redact passes primitives through unchanged", () => {
  assert.equal(redact(42), 42);
  assert.equal(redact(true), true);
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
});

test("redact terminates on a self-referential object", () => {
  const obj = { name: "loop" };
  obj.self = obj;
  const out = redact(obj);
  assert.equal(out.self, "[circular]");
});

test("redact terminates on a mutually recursive pair", () => {
  const a = { id: "a" };
  const b = { id: "b", a };
  a.b = b;
  assert.doesNotThrow(() => redact(a));
});

test("redact stops at maxDepth", () => {
  const deep = { l1: { l2: { l3: { l4: { l5: "bottom" } } } } };
  const out = redact(deep, { maxDepth: 2 });
  assert.ok(JSON.stringify(out).includes("[depth]"));
});

test("redact reduces an Error to name and message", () => {
  const out = redact({ err: new TypeError("boom") });
  assert.equal(out.err.name, "TypeError");
  assert.equal(out.err.message, "boom");
});

// --------------------------------------------------------------------------
// The gate
// --------------------------------------------------------------------------

test("logDebug is silent when debug is off", () => {
  setDebug(false);
  assert.equal(capture(() => logDebug("scope", "should not appear")).length, 0);
});

test("logDebug emits when debug is on", () => {
  setDebug(true);
  const lines = capture(() => logDebug("scope", "visible"));
  assert.equal(lines.length, 1);
  assert.match(lines[0][0], /visible/);
});

test("logError emits regardless of the gate", () => {
  setDebug(false);
  const lines = capture(() => logError("scope", "always"));
  assert.equal(lines.length, 1);
});

test("setDebug(false) silences logDebug again", () => {
  setDebug(true);
  capture(() => logDebug("s", "first"));
  setDebug(false);
  assert.equal(capture(() => logDebug("s", "second")).length, 0);
});

test("logError redacts its detail", () => {
  setDebug(false);
  const lines = capture(() =>
    logError("analyze", "failed", { apiKey: "sk-live-secret", caption: "private" }),
  );
  const rendered = JSON.stringify(lines);
  assert.ok(!rendered.includes("sk-live-secret"), "api key reached the console");
  assert.ok(!rendered.includes("private"), "caption reached the console");
});

test("no console call outside the logging module is ungated", () => {
  // Everything should route through logDebug/logError so redaction cannot be
  // bypassed.
  for (const file of [
    "../script.js",
    "../../background.js",
    "../../popup.js",
    "./feedback.js",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(
      !/console\.(log|warn|error|debug|info)\(/.test(source),
      `${file} calls console directly; use logDebug/logError so redaction applies`,
    );
  }
});

// --------------------------------------------------------------------------
// Retry backoff
// --------------------------------------------------------------------------

test("a post with no failure is not skipped", () => {
  assert.equal(shouldSkip({}, "p:1"), false);
  assert.equal(nextRetryAt({}, "p:1"), null);
});

test("backoff grows exponentially and caps at MAX_ANALYSIS_ATTEMPTS", () => {
  const now = 1000;
  let state = {};
  const delays = [];

  for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS + 2; i += 1) {
    const before = state;
    const { state: next } = recordFailure(before, "p:1", now);
    state = next;
    delays.push(state["p:1"].nextAt - now);
  }

  assert.equal(delays[0], RETRY_BASE_MS);
  assert.equal(delays[1], RETRY_BASE_MS * 2);
  assert.ok(delays[2] > delays[1], "delay must keep growing");

  // Past the attempt budget the post is never retried again, rather than
  // retried indefinitely, which would be a request storm against a downed
  // backend.
  assert.equal(nextRetryAt(state, "p:1"), Infinity);
  assert.equal(shouldSkip(state, "p:1", now), true);
  assert.equal(shouldSkip(state, "p:1", now + 10 ** 9), true);
});

test("a post inside its retry window is skipped", () => {
  const now = 1000;
  const { state } = recordFailure({}, "p:1", now);
  assert.equal(shouldSkip(state, "p:1", now), true);
  assert.equal(shouldSkip(state, "p:1", now + RETRY_BASE_MS - 1), true);
  assert.equal(shouldSkip(state, "p:1", now + RETRY_BASE_MS + 1), false);
});

test("backoff is tracked per post", () => {
  const { state } = recordFailure({}, "p:1", 1000);
  assert.equal(shouldSkip(state, "p:1", 1000), true);
  assert.equal(
    shouldSkip(state, "p:2", 1000),
    false,
    "a different post must be unaffected",
  );
});

test("clearFailure re-enables a post", () => {
  const { state } = recordFailure({}, "p:1", 1000);
  const cleared = clearFailure(state, "p:1");
  assert.equal(shouldSkip(cleared, "p:1", 1000), false);
  assert.equal("p:1" in cleared, false);
});

test("recordFailure does not mutate the state it is given", () => {
  const original = {};
  recordFailure(original, "p:1", 1000);
  assert.deepEqual(original, {}, "state was mutated in place");
});
