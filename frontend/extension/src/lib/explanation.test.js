/**
 * Explanation detail view (#79). Uses linkedom so these run in Node.
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";

import { parseHTML } from "linkedom";

import {
  buildExplanationDetails,
  hasExplanationDetails,
  normalizeExplanation,
  verdictLabel,
} from "./explanation.js";
import { buildPlaceholder } from "./placeholder.js";

before(() => {
  const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  globalThis.document = dom.document;
  globalThis.HTMLElement = dom.HTMLElement;
  globalThis.Node = dom.Node;
});

test("normalizeExplanation accepts the backend AgentOutput shape", () => {
  const n = normalizeExplanation({
    verdict: "likely_false",
    confidence: 0.82,
    explanation: "flagged",
    reasoning_chain: ["a", "b"],
    evidence: [{ title: "t", source_url: "https://example.com/x" }],
    uncertainties: ["u1"],
  });
  assert.equal(n.verdict, "likely_false");
  assert.equal(n.confidence, 0.82);
  assert.deepEqual(n.reasoningChain, ["a", "b"]);
  assert.equal(n.evidence.length, 1);
  assert.deepEqual(n.uncertainties, ["u1"]);
});

test("verdictLabel maps the enum and passes unknowns through", () => {
  assert.equal(verdictLabel("likely_false"), "Likely false");
  assert.equal(verdictLabel("mixed"), "Mixed");
  assert.equal(verdictLabel("custom"), "custom");
  assert.equal(verdictLabel(""), "");
});

test("hasExplanationDetails is false for an empty result", () => {
  assert.equal(hasExplanationDetails({}), false);
  assert.equal(hasExplanationDetails({ explanation: "only summary" }), false);
  assert.equal(hasExplanationDetails({ reasoning_chain: ["step"] }), true);
});

test("buildExplanationDetails returns null when there is nothing to show", () => {
  assert.equal(buildExplanationDetails({}), null);
  assert.equal(buildExplanationDetails({ explanation: "summary only" }), null);
});

test("buildExplanationDetails renders reasoning, evidence and uncertainties as text", () => {
  const el = buildExplanationDetails({
    verdict: "likely_false",
    confidence: 0.5,
    reasoning_chain: ["first step", "second step"],
    evidence: [
      {
        title: "Source title",
        source_url: "https://example.com/article",
        summary: "says the claim is wrong",
        supporting: false,
        source_credibility: "high",
      },
    ],
    uncertainties: ["could not verify the date"],
  });
  assert.ok(el, "expected a details element");
  assert.equal(el.tagName.toLowerCase(), "details");
  assert.ok(el.querySelector("summary"), "missing toggle");
  assert.equal(el.querySelectorAll("ol.aibot-reasoning li").length, 2);
  assert.match(el.textContent, /Likely false/);
  const link = el.querySelector("a");
  assert.ok(link, "evidence link missing");
  assert.equal(link.getAttribute("href"), "https://example.com/article");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.match(el.textContent, /could not verify the date/);
});

test("model markup in reasoning/evidence never becomes elements", () => {
  const el = buildExplanationDetails({
    reasoning_chain: ['<img src=x onerror="alert(1)">'],
    evidence: [{ title: "<script>window.__pwned = 1</script>" }],
    uncertainties: ["<b>bold</b>"],
  });
  assert.equal(el.querySelector("img"), null);
  assert.equal(el.querySelector("script"), null);
  assert.match(el.textContent, /onerror/);
  assert.match(el.textContent, /__pwned/);
});

test("evidence with a javascript: URL renders as text, not a link", () => {
  const el = buildExplanationDetails({
    evidence: [{ title: "evil", source_url: "javascript:alert(1)" }],
  });
  assert.equal(el.querySelector("a"), null);
  assert.match(el.textContent, /evil/);
});

test("buildPlaceholder includes the detail view when reasoning is present", () => {
  const placeholder = buildPlaceholder({
    postKey: "p:1",
    explanation: "flagged",
    verdict: "likely_false",
    reasoning_chain: ["step one"],
    evidence: [],
    uncertainties: [],
  });
  const details = placeholder.querySelector("details.aibot-details");
  assert.ok(details, "expected expandable detail view in the placeholder");
});

test("buildPlaceholder omits the detail view when only a summary exists", () => {
  const placeholder = buildPlaceholder({ postKey: "p:1", explanation: "flagged" });
  assert.equal(placeholder.querySelector("details.aibot-details"), null);
});
