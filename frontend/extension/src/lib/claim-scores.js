/**
 * Claim-level scores (#86).
 *
 * The interface used to present exactly one number pair per post
 * ("AI-generated risk 70%, misinformation risk 55%"), which is the least
 * actionable thing a reader can be shown when a post makes several distinct
 * assertions and only one of them is false.
 *
 * Backend contract (forward-looking, and deliberately tolerant):
 *   AgentOutput today has no per-claim field. When one is added it is expected
 *   to look like:
 *     claim_scores: [
 *       { claim: string,
 *         ai_generated_risk_score?: 0..1,
 *         misinformation_risk_score?: 0..1,
 *         evidence_url?: string, source?: string }
 *     ]
 *   Aliases accepted here: claimScores, claims_detailed, per_claim_scores,
 *   perClaimScores. A bare `claims: [string]` list (the shape the extension
 *   already *sends* to /api/analyze_claims) is also accepted so a backend that
 *   echoes the claims back still gets a useful breakdown.
 *
 * Degradation rule, which is the whole point of this module:
 *   When the backend sends no per-claim data, this returns NO claim rows. It
 *   does not split the caption into sentences and stamp the post-level score
 *   on each fragment. That would be an invented number wearing the label of a
 *   per-claim measurement, and a reader cannot tell the difference. The
 *   post-level scores are already rendered by placeholder.js, so the honest
 *   degraded state is "one score for the post" plus a note saying the
 *   breakdown is not available yet.
 *
 * All model-provided text is assigned via textContent and all URLs go through
 * safeUrl, matching the rest of the detail view.
 */

import { safeUrl } from "./sanitize.js";

/** Cap on rendered claim rows. A post is not a research paper. */
export const MAX_CLAIM_ROWS = 10;

/** Cap on the claim text kept for display. */
const MAX_CLAIM_CHARS = 240;

/** Cap on a source label. */
const MAX_SOURCE_CHARS = 120;

export const CLAIM_FALLBACK_NOTE =
  "Per-claim scores are not available for this post yet. The scores above apply to the post as a whole.";

/**
 * Coerce a backend score to a number in 0..1, or null.
 *
 * A percentage (0..100) is a real possibility once per-claim scores exist, so
 * 7 is read as 7% and 1 is read as 100% rather than being clamped to a
 * meaningless 100% for both. Anything non-numeric, negative, or above 100 is
 * rejected outright: a score we cannot interpret must not be displayed.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function toScoreOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 1) {
    // Percent scale, only if it is unambiguously one.
    if (n <= 100) return n / 100;
    return null;
  }
  return n;
}

/** @param {string} text @returns {string} */
function clip(text) {
  const trimmed = String(text || "").trim();
  return trimmed.length > MAX_CLAIM_CHARS
    ? `${trimmed.slice(0, MAX_CLAIM_CHARS - 1)}…`
    : trimmed;
}

/**
 * Pull the raw per-claim array out of a result, tolerating the alias names.
 * @param {object} result
 * @returns {unknown[]|null}
 */
function rawClaimArray(result) {
  const raw =
    result?.claim_scores ??
    result?.claimScores ??
    result?.claims_detailed ??
    result?.claimsDetailed ??
    result?.per_claim_scores ??
    result?.perClaimScores ??
    // Bare claim list. Treated as claims WITHOUT scores, never as scores.
    result?.claims ??
    null;
  return Array.isArray(raw) ? raw : null;
}

/**
 * Read one claim row.
 *
 * @param {unknown} entry
 * @returns {{text: string, aiScore: number|null, newsScore: number|null,
 *   url: string, source: string}|null} null when the row has no claim text
 */
function readClaimEntry(entry) {
  if (entry === null || entry === undefined) return null;

  if (typeof entry === "string") {
    const text = clip(entry);
    return text ? { text, aiScore: null, newsScore: null, url: "", source: "" } : null;
  }
  if (typeof entry !== "object") return null;

  const text = clip(entry.claim ?? entry.text ?? "");
  // A row with no claim text carries no information for a reader.
  if (!text) return null;

  return {
    text,
    aiScore: toScoreOrNull(
      entry.ai_generated_risk_score ?? entry.aiGeneratedRiskScore ?? entry.aiScore,
    ),
    newsScore: toScoreOrNull(
      entry.misinformation_risk_score ?? entry.misinformationRiskScore ?? entry.newsScore,
    ),
    url: safeUrl(
      entry.evidence_url ??
        entry.evidenceUrl ??
        entry.source_url ??
        entry.sourceUrl ??
        entry.url,
    ),
    source: String(entry.source ?? entry.title ?? "")
      .trim()
      .slice(0, MAX_SOURCE_CHARS),
  };
}

/**
 * Normalize whatever the backend sent into displayable claim rows.
 *
 * `hasScores` distinguishes "the backend scored each claim" from "the backend
 * sent claim texts only". The UI labels those two cases differently because
 * showing a claim with no number next to claims that have numbers would imply
 * the missing one scored zero.
 *
 * @param {object} [result] raw analysis result
 * @returns {{items: Array<{text: string, aiScore: number|null, newsScore: number|null, url: string, source: string}>,
 *   hasScores: boolean, degraded: boolean, note: string}}
 */
export function normalizeClaimScores(result = {}) {
  const raw = rawClaimArray(result);
  if (!raw || raw.length === 0) {
    return { items: [], hasScores: false, degraded: true, note: CLAIM_FALLBACK_NOTE };
  }

  const items = [];
  for (const entry of raw.slice(0, MAX_CLAIM_ROWS)) {
    const claim = readClaimEntry(entry);
    if (claim) items.push(claim);
  }

  if (items.length === 0) {
    return { items: [], hasScores: false, degraded: true, note: CLAIM_FALLBACK_NOTE };
  }

  const hasScores = items.some((c) => c.aiScore !== null || c.newsScore !== null);
  return {
    items,
    hasScores,
    degraded: false,
    note: hasScores
      ? ""
      : "This post's claims are listed, but the backend did not return a score for any of them.",
  };
}

/**
 * Build the claim-scores list element (#86), or null when there is nothing
 * real to show.
 *
 * @param {object} [result] raw analysis result
 * @param {{postAiScore?: number|null, postNewsScore?: number|null}} [post]
 *   post-level scores, used only to state what the single post-level number
 *   refers to in the degraded case
 * @returns {HTMLElement|null}
 */
export function buildClaimScoresList(result = {}, post = {}) {
  const { items, hasScores, note } = normalizeClaimScores(result);
  if (items.length === 0) return null;

  const wrap = document.createElement("div");
  wrap.className = "aibot-claims";

  const heading = document.createElement("h4");
  heading.className = "aibot-details-heading";
  heading.textContent = hasScores ? "Claim-by-claim scores" : "Claims in this post";
  wrap.append(heading);

  if (note) {
    const noteNode = document.createElement("p");
    noteNode.className = "aibot-claims-note";
    noteNode.textContent = note;
    wrap.append(noteNode);
  }

  const list = document.createElement("ul");
  list.className = "aibot-claims-list";
  list.setAttribute(
    "aria-label",
    hasScores ? "Claim-level scores" : "Claims in this post",
  );

  for (const item of items) {
    const row = document.createElement("li");
    row.className = "aibot-claim-item";

    const textNode = document.createElement("span");
    textNode.className = "aibot-claim-text";
    textNode.textContent = item.text;
    row.append(textNode);

    const parts = [];
    if (item.newsScore !== null)
      parts.push(`misinformation ${formatPct(item.newsScore)}`);
    if (item.aiScore !== null) parts.push(`AI-generated ${formatPct(item.aiScore)}`);
    if (parts.length > 0) {
      const scoreNode = document.createElement("span");
      scoreNode.className = "aibot-claim-score";
      scoreNode.textContent = ` — ${parts.join(", ")}`;
      row.append(scoreNode);
    }

    if (item.url) {
      row.append(document.createTextNode(" "));
      const link = document.createElement("a");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = item.source || "evidence";
      link.setAttribute("aria-label", `Evidence for claim: ${item.text.slice(0, 80)}`);
      row.append(link);
    }

    list.append(row);
  }

  wrap.append(list);

  if (
    !hasScores &&
    (post.postAiScore !== undefined || post.postNewsScore !== undefined)
  ) {
    const foot = document.createElement("p");
    foot.className = "aibot-claims-note";
    foot.textContent =
      "The percentages above are for the post as a whole, not for each claim.";
    wrap.append(foot);
  }

  return wrap;
}

/** @param {number} value 0..1 @returns {string} */
function formatPct(value) {
  return `${Math.round(value * 100)}%`;
}
