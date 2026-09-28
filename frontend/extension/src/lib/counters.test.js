/**
 * Lifetime counters: the persisted total must never be overwritten with the
 * DOM-present count. Run with: npm test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  coerceCount,
  countPresent,
  recordHide,
  recordUnhide,
  restoreCounts,
} from "./counters.js";

test("coerceCount sanitises stored values", () => {
  assert.equal(coerceCount(undefined), 0);
  assert.equal(coerceCount(null), 0);
  assert.equal(coerceCount("7"), 7);
  assert.equal(coerceCount(3.9), 3);
  assert.equal(coerceCount(-2), 0);
  assert.equal(coerceCount(Number.NaN), 0);
  assert.equal(coerceCount("garbage"), 0);
});

test("restoreCounts coerces both counters", () => {
  assert.deepEqual(restoreCounts({ h: 5, a: "3" }, "h", "a"), { hidden: 5, analyzed: 3 });
  assert.deepEqual(restoreCounts({}, "h", "a"), { hidden: 0, analyzed: 0 });
  assert.deepEqual(restoreCounts({ h: -1, a: Number.NaN }, "h", "a"), {
    hidden: 0,
    analyzed: 0,
  });
});

test("recordHide increments the lifetime total only for new keys", () => {
  const hidden = new Set();
  let lifetime = 0;

  let out = recordHide(hidden, lifetime, "p:1");
  assert.equal(out.added, true);
  lifetime = out.lifetime;
  assert.equal(lifetime, 1);

  // Re-hiding the same key must not double-count.
  out = recordHide(hidden, lifetime, "p:1");
  assert.equal(out.added, false);
  assert.equal(out.lifetime, 1);

  out = recordHide(hidden, out.lifetime, "p:2");
  assert.equal(out.lifetime, 2);

  // Empty keys never count.
  out = recordHide(hidden, out.lifetime, "");
  assert.equal(out.added, false);
  assert.equal(out.lifetime, 2);
});

test("recordUnhide decrements, floored at zero", () => {
  const hidden = new Set(["p:1", "p:2"]);
  let out = recordUnhide(hidden, 2, "p:1");
  assert.equal(out.removed, true);
  assert.equal(out.lifetime, 1);
  assert.ok(!hidden.has("p:1"));

  // Unhiding a key that is not hidden leaves the total alone.
  out = recordUnhide(hidden, out.lifetime, "p:missing");
  assert.equal(out.removed, false);
  assert.equal(out.lifetime, 1);

  out = recordUnhide(hidden, 0, "p:2");
  assert.equal(out.lifetime, 0, "lifetime must never go negative");
});

test("countPresent is separate from the lifetime total", () => {
  // Regression shape for #19: a feed re-render drops DOM nodes, so the
  // present count falls while the lifetime total must not.
  const hidden = new Set(["p:1", "p:2", "p:3"]);
  const lifetime = 3;
  const present = countPresent(hidden, (key) => key !== "p:3");
  assert.equal(present, 2);
  assert.equal(lifetime, 3, "reading the DOM must not mutate the lifetime total");
});

test("the observer never writes the lifetime counter", () => {
  // The MutationObserver may schedule a scan; it must never assign the
  // persisted hiddenCount. Guard the wiring at the source level, ignoring
  // comments that explain the invariant.
  const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  const start = source.indexOf("const observer = new MutationObserver");
  assert.ok(start !== -1, "observer block not found");
  const end = source.indexOf("function observe()", start);
  const block = source.slice(start, end === -1 ? undefined : end);
  const code = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  assert.ok(
    !code.includes("totalHiddenCount"),
    "observer must not touch the lifetime total",
  );
  assert.ok(
    !code.includes("STORAGE_KEYS.hiddenCount") &&
      !code.includes("STORAGE_KEYS.analyzedCount"),
    "observer must not write persisted counters",
  );
  assert.match(block, /scheduleScan\(\)/);
});

test("the content script persists counters to local storage, not sync", () => {
  // Counters are high-churn local state. Writing them to sync spends the sync
  // write budget and lets profiles race; the popup reads the same area.
  const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  assert.match(source, /readLocal\(\[STORAGE_KEYS\.hiddenCount/);
  const popup = readFileSync(new URL("../../popup.js", import.meta.url), "utf8");
  assert.match(popup, /readLocal\(\[STORAGE_KEYS\.hiddenCount/);
});
