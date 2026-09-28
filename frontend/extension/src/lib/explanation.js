/**
 * Explanation detail view (#79).
 *
 * Renders the reasoning chain, evidence sources and uncertainties behind each
 * verdict in an expandable <details> block inside the placeholder. All
 * model-provided strings are assigned via textContent (never innerHTML); URLs
 * go through safeUrl and get rel="noopener noreferrer".
 *
 * Input shape mirrors backend AgentOutput (backend/app/schemas/agent_io.py):
 *   { verdict, confidence, explanation, reasoning_chain, evidence, uncertainties }
 * where evidence items are { source_url?, title?, summary?, supporting?,
 * source_credibility? }. Every field is optional here: the detail block is
 * omitted entirely when there is nothing to show.
 *
 * Claim-level scores (#86) are rendered from claim-scores.js, which degrades to
 * "no claim rows" rather than inventing any.
 */

import { safeUrl } from "./sanitize.js";
import { buildClaimScoresList } from "./claim-scores.js";

/** Human labels for the backend Verdict enum. Unknown values pass through. */
export const VERDICT_LABELS = Object.freeze({
  likely_true: "Likely true",
  likely_false: "Likely false",
  mixed: "Mixed",
  unverifiable: "Unverifiable",
});

/**
 * Normalize a raw analysis result into the fields the detail view needs.
 * Accepts both snake_case (backend) and camelCase (legacy callers).
 *
 * @param {object} [result]
 * @returns {{verdict: string, confidence: number|null, explanation: string,
 *   reasoningChain: string[], evidence: object[], uncertainties: string[]}}
 */
export function normalizeExplanation(result = {}) {
  const verdict = String(result?.verdict ?? result?.verdictLabel ?? "").trim();
  const rawConfidence = result?.confidence ?? null;
  const confidence =
    rawConfidence === null || rawConfidence === undefined ? null : Number(rawConfidence);
  const explanation = String(result?.explanation ?? result?.reason ?? "");
  const reasoningChain = normalizeStringList(
    result?.reasoning_chain ?? result?.reasoningChain ?? result?.reasoning,
  );
  const uncertainties = normalizeStringList(result?.uncertainties ?? result?.uncertainty);
  const evidence = normalizeEvidenceList(result?.evidence);
  return {
    verdict,
    confidence: Number.isFinite(confidence) ? confidence : null,
    explanation,
    reasoningChain,
    evidence,
    uncertainties,
  };
}
/**
 * Whether there is anything worth expanding: a reasoning step, an evidence
 * item, an uncertainty, or a verdict/confidence badge beyond the summary.
 *
 * @param {object} [result]
 * @returns {boolean}
 */
export function hasExplanationDetails(result = {}) {
  const n = normalizeExplanation(result);
  return (
    n.reasoningChain.length > 0 ||
    n.evidence.length > 0 ||
    n.uncertainties.length > 0 ||
    Boolean(n.verdict) ||
    n.confidence !== null
  );
}

function normalizeStringList(value) {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    const text = String(item).trim();
    // Skip empty strings and "[no ...]" backend placeholders that carry no
    // information for the user.
    if (!text) continue;
    out.push(text);
  }
  return out.slice(0, 20);
}

function normalizeEvidenceList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value.slice(0, 20)) {
    if (item === null || item === undefined) continue;
    if (typeof item === "string") {
      const text = item.trim();
      if (text) out.push({ title: text });
      continue;
    }
    if (typeof item !== "object") continue;
    const title = String(item.title ?? item.source_url ?? item.sourceUrl ?? "").trim();
    const summary = String(item.summary ?? "").trim();
    const url = safeUrl(item.source_url ?? item.sourceUrl ?? item.url ?? "");
    const supporting = typeof item.supporting === "boolean" ? item.supporting : null;
    const credibility = String(item.source_credibility ?? item.credibility ?? "").trim();
    if (!title && !summary && !url) continue;
    out.push({ title, summary, url, supporting, credibility });
  }
  return out;
}

/** @param {string} verdict raw enum value */
export function verdictLabel(verdict) {
  if (!verdict) return "";
  return VERDICT_LABELS[verdict] || String(verdict);
}

/**
 * Build the expandable detail element. Returns null when there is nothing to
 * show, so callers can omit the toggle entirely.
 *
 * Uses native <details>/<summary> for keyboard + screen-reader support
 * without custom key handlers. The section headings use <h4> and the lists
 * use native <ol>/<ul> semantics with explicit aria-labels.
 *
 * @param {object} [result] raw analysis result (AgentOutput shape)
 * @returns {HTMLElement|null}
 */
export function buildExplanationDetails(result = {}) {
  const n = normalizeExplanation(result);
  if (
    n.reasoningChain.length === 0 &&
    n.evidence.length === 0 &&
    n.uncertainties.length === 0 &&
    !n.verdict &&
    n.confidence === null
  ) {
    return null;
  }

  const details = document.createElement("details");
  details.className = "aibot-details";

  const summary = document.createElement("summary");
  summary.className = "aibot-details-toggle";
  summary.textContent = "Why was this flagged? View reasoning";
  details.append(summary);

  const body = document.createElement("div");
  body.className = "aibot-details-body";
  body.setAttribute("role", "region");
  body.setAttribute("aria-label", "Analysis explanation details");

  if (n.verdict || n.confidence !== null) {
    const verdictRow = document.createElement("p");
    verdictRow.className = "aibot-verdict";
    const parts = [];
    if (n.verdict) parts.push(`Verdict: ${verdictLabel(n.verdict)}`);
    if (n.confidence !== null)
      parts.push(`Confidence: ${Math.round(n.confidence * 100)}%`);
    // textContent: verdict comes from the model and must not become markup.
    verdictRow.textContent = parts.join(" · ");
    body.append(verdictRow);
  }

  // Claim-level scores (#86). Returns null when the backend sent no per-claim
  // data, so the section is simply absent rather than showing a fabricated
  // breakdown. The post-level scores are already rendered above by
  // placeholder.js, which is the honest degraded state.
  const claimsEl = buildClaimScoresList(result, {
    postAiScore: result?.aiScore,
    postNewsScore: result?.newsScore,
  });
  if (claimsEl) body.append(claimsEl);

  if (n.reasoningChain.length > 0) {
    const heading = document.createElement("h4");
    heading.className = "aibot-details-heading";
    heading.textContent = "Reasoning";
    const list = document.createElement("ol");
    list.className = "aibot-reasoning";
    list.setAttribute("aria-label", "Reasoning steps");
    for (const step of n.reasoningChain) {
      const item = document.createElement("li");
      item.textContent = step;
      list.append(item);
    }
    body.append(heading, list);
  }

  if (n.evidence.length > 0) {
    const heading = document.createElement("h4");
    heading.className = "aibot-details-heading";
    heading.textContent = "Evidence sources";
    const list = document.createElement("ul");
    list.className = "aibot-evidence";
    list.setAttribute("aria-label", "Evidence sources");
    for (const item of n.evidence) {
      const entry = document.createElement("li");
      entry.className = "aibot-evidence-item";
      const label = item.title || item.summary || item.url || "Source";
      if (item.url) {
        const link = document.createElement("a");
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = label.slice(0, 200);
        entry.append(link);
      } else {
        const span = document.createElement("span");
        span.textContent = label.slice(0, 200);
        entry.append(span);
      }
      const meta = [];
      if (item.supporting === true) meta.push("supports the claim");
      else if (item.supporting === false) meta.push("contradicts the claim");
      if (item.credibility) meta.push(`credibility: ${item.credibility}`);
      if (meta.length > 0) {
        const metaNode = document.createElement("span");
        metaNode.className = "aibot-evidence-meta";
        metaNode.textContent = ` (${meta.join("; ")})`;
        entry.append(metaNode);
      }
      if (item.url && item.summary && item.summary !== label) {
        const summaryNode = document.createElement("span");
        summaryNode.className = "aibot-evidence-summary";
        summaryNode.textContent = ` — ${item.summary.slice(0, 300)}`;
        entry.append(summaryNode);
      }
      list.append(entry);
    }
    body.append(heading, list);
  }

  if (n.uncertainties.length > 0) {
    const heading = document.createElement("h4");
    heading.className = "aibot-details-heading";
    heading.textContent = "What could not be verified";
    const list = document.createElement("ul");
    list.className = "aibot-uncertainties";
    list.setAttribute("aria-label", "Uncertainties");
    for (const item of n.uncertainties) {
      const entry = document.createElement("li");
      entry.textContent = item;
      list.append(entry);
    }
    body.append(heading, list);
  }

  details.append(body);
  return details;
}
