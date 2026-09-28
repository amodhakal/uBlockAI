/**
 * Claim-level scores (#86).
 *
 * The central assertion of this file is negative: when the backend sends no
 * per-claim data, nothing is rendered. AgentOutput has no per-claim field
 * today, so a test that only covered the happy path would be testing a shape
 * the backend cannot currently produce.
 *
 * Uses linkedom so these run in Node. Run with: npm test
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";

import { parseHTML } from "linkedom";

import {
  CLAIM_FALLBACK_NOTE,
  buildClaimScoresList,
  normalizeClaimScores,
  toScoreOrNull,
} from "./claim-scores.js";
import { buildExplanationDetails } from "./explanation.js";
import { buildPlaceholder } from "./placeholder.js";

let dom;

before(() => {
  dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  globalThis.document = dom.document;
  globalThis.HTMLElement = dom.HTMLElement;
  globalThis.Node = dom.Node;
});

// --------------------------------------------------------------------------
// Score coercion
// --------------------------------------------------------------------------

test("toScoreOrNull passes through the 0..1 domain the backend scores in", () => {
  assert.equal(toScoreOrNull(0), 0);
  assert.equal(toScoreOrNull(0.42), 0.42);
  assert.equal(toScoreOrNull(1), 1);
  assert.equal(toScoreOrNull("0.75"), 0.75);
});

test("toScoreOrNull reads an unambiguous percentage, and rejects nonsense", () => {
  // 7 is 7%, not 700% clamped into looking like certainty.
  assert.equal(toScoreOrNull(7), 0.07);
  // 1 stays 100%: the 0..1 domain wins at exactly 1 rather than 1%.
  assert.equal(toScoreOrNull(1), 1);
  assert.equal(toScoreOrNull(-0.2), null);
  assert.equal(toScoreOrNull(101), null);
  assert.equal(toScoreOrNull("high"), null);
  assert.equal(toScoreOrNull(null), null);
  assert.equal(toScoreOrNull(undefined), null);
  assert.equal(toScoreOrNull(""), null);
});

// --------------------------------------------------------------------------
// The degradation rule
// --------------------------------------------------------------------------

test("no per-claim data yields no claim rows at all", () => {
  // This is the shape the backend actually returns today: post-level scores,
  // no claim_scores key.
  const n = normalizeClaimScores({
    ai_generated_risk_score: 0.8,
    misinformation_risk_score: 0.6,
    verdict: "likely_false",
  });
  assert.deepEqual(n.items, []);
  assert.equal(n.degraded, true);
  assert.equal(n.note, CLAIM_FALLBACK_NOTE);
});

test("no per-claim data renders no list, and does not invent claim rows", () => {
  const result = {
    verdict: "likely_false",
    confidence: 0.9,
    reasoning_chain: ["step"],
    aiScore: 0.8,
    newsScore: 0.6,
    // A caption the old fallback would have split into "claims".
    caption:
      "The mayor resigned today. The council said nothing about it. Everyone knows why.",
  };
  const n = normalizeClaimScores(result);
  assert.deepEqual(n.items, [], "must not derive claims from the caption");

  const el = buildClaimScoresList(result, { postAiScore: 0.8, postNewsScore: 0.6 });
  assert.equal(el, null, "no claim rows means no claim section");
  assert.equal(buildExplanationDetails(result).querySelector(".aibot-claims"), null);
});

test("an empty claim array degrades exactly like a missing one", () => {
  const n = normalizeClaimScores({ claim_scores: [] });
  assert.deepEqual(n.items, []);
  assert.equal(n.degraded, true);
  assert.equal(n.note, CLAIM_FALLBACK_NOTE);
});

test("a non-array claim field is ignored rather than iterated", () => {
  const n = normalizeClaimScores({ claim_scores: "not-a-list" });
  assert.deepEqual(n.items, []);
  assert.equal(n.degraded, true);
});

test("a null claim_scores does not shadow a populated claims list", () => {
  const n = normalizeClaimScores({ claim_scores: null, claims: ["a", "b"] });
  assert.equal(n.items.length, 2);
});

// --------------------------------------------------------------------------
// Real per-claim data
// --------------------------------------------------------------------------

test("per-claim scores render one row per claim with its own numbers", () => {
  const result = {
    verdict: "mixed",
    ai_generated_risk_score: 0.1,
    misinformation_risk_score: 0.1,
    claim_scores: [
      { claim: "The bridge opened in 1994", misinformation_risk_score: 0.05 },
      {
        claim: "The bridge is scheduled for demolition",
        misinformation_risk_score: 0.91,
        evidence_url: "https://example.com/council-minutes",
        source: "City council minutes",
      },
    ],
  };

  const n = normalizeClaimScores(result);
  assert.equal(n.items.length, 2);
  assert.equal(n.hasScores, true);
  assert.equal(n.degraded, false);
  assert.equal(n.items[0].newsScore, 0.05);
  assert.equal(n.items[1].newsScore, 0.91);
  // A claim the backend did not score is null, not zero.
  assert.equal(n.items[0].aiScore, null);

  const el = buildClaimScoresList(result);
  const rows = el.querySelectorAll("li.aibot-claim-item");
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /opened in 1994/);
  assert.match(rows[0].textContent, /misinformation 5%/);
  // No invented AI score for claim 0.
  assert.doesNotMatch(rows[0].textContent, /AI-generated/);
  assert.match(rows[1].textContent, /misinformation 91%/);
  assert.match(rows[1].textContent, /City council minutes/);
});

test("a per-claim score is never borrowed from the post-level score", () => {
  // The post is a 90% AI risk; one of its claims is not. Stamping 90% on that
  // claim would be the exact fabrication this issue is meant to fix.
  const result = {
    aiScore: 0.9,
    newsScore: 0.9,
    claim_scores: [
      { claim: "Unrelated true statement", misinformation_risk_score: 0.02 },
    ],
  };
  const n = normalizeClaimScores(result);
  assert.equal(n.items[0].newsScore, 0.02);
  assert.equal(n.items[0].aiScore, null);
});

test("claim rows with no scores at all are labelled as unscored", () => {
  const result = { claim_scores: ["one", "two"] };
  const n = normalizeClaimScores(result);
  assert.equal(n.items.length, 2);
  assert.equal(n.hasScores, false);
  assert.equal(n.degraded, false);
  assert.match(n.note, /did not return a score/);

  const el = buildClaimScoresList(result, { postAiScore: 0.9, postNewsScore: 0.9 });
  assert.match(el.textContent, /did not return a score/);
  // Says outright that the visible percentages are post-level.
  assert.match(el.textContent, /for the post as a whole, not for each claim/);
  const rows = el.querySelectorAll("li.aibot-claim-item");
  assert.equal(rows.length, 2);
  assert.equal(el.querySelectorAll(".aibot-claim-score").length, 0);
});

test("a claim row with no text is dropped", () => {
  const n = normalizeClaimScores({
    claim_scores: [{ misinformation_risk_score: 0.5 }, "  ", { claim: "real" }],
  });
  assert.equal(n.items.length, 1);
  assert.equal(n.items[0].text, "real");
});

test("claim rows are capped so a wall of text cannot break the panel", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ claim: `claim ${i}` }));
  assert.equal(normalizeClaimScores({ claim_scores: many }).items.length, 10);
});

test("an over-long claim is clipped rather than rendered whole", () => {
  const n = normalizeClaimScores({ claim_scores: [{ claim: "x".repeat(5000) }] });
  assert.ok(n.items[0].text.length <= 240);
  assert.match(n.items[0].text, /…$/);
});

// --------------------------------------------------------------------------
// Safety
// --------------------------------------------------------------------------

test("claim text is never interpreted as markup", () => {
  const el = buildClaimScoresList({
    claim_scores: [
      { claim: '<img src=x onerror="alert(1)">', misinformation_risk_score: 0.9 },
    ],
  });
  assert.equal(el.querySelector("img"), null);
  assert.match(el.textContent, /onerror/);
});

test("a javascript: evidence url on a claim is dropped, not linked", () => {
  const el = buildClaimScoresList({
    claim_scores: [{ claim: "c", evidence_url: "javascript:alert(1)" }],
  });
  assert.equal(el.querySelector("a"), null);
});

// --------------------------------------------------------------------------
// Integration with the placeholder
// --------------------------------------------------------------------------

test("the placeholder renders claim rows when the backend sends them", () => {
  const placeholder = buildPlaceholder({
    postKey: "p:1",
    explanation: "mixed",
    verdict: "mixed",
    claim_scores: [
      { claim: "first", misinformation_risk_score: 0.2 },
      { claim: "second", misinformation_risk_score: 0.8 },
    ],
  });
  const details = placeholder.querySelector("details.aibot-details");
  assert.ok(details, "the detail view must open for claim rows alone");
  assert.equal(details.querySelectorAll("li.aibot-claim-item").length, 2);
  // The post-level scores are still shown, unchanged.
  assert.match(
    placeholder.querySelector(".aibot-scores").textContent,
    /Misinformation risk/,
  );
});

test("a placeholder with no per-claim data shows the post score and no claim rows", () => {
  const placeholder = buildPlaceholder({
    postKey: "p:1",
    explanation: "flagged",
    verdict: "likely_false",
    aiScore: 0.8,
    newsScore: 0.6,
  });
  const scores = placeholder.querySelector(".aibot-scores");
  assert.match(scores.textContent, /AI-generated risk: 80%/);
  assert.match(scores.textContent, /Misinformation risk: 60%/);
  assert.equal(
    placeholder.querySelector("li.aibot-claim-item"),
    null,
    "no claim rows may be invented",
  );
});
