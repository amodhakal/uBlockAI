/**
 * The shared on-device classification surface (#1).
 *
 * Two engines sit behind one function:
 *
 *   - The ONNX transformer path in onnx-session.js. It is the accurate one, and
 *     it is absent by default: neither the ~100 MB checkpoint nor the
 *     onnxruntime-web WASM binaries are committed here (docs/models/README.md
 *     has the operator instructions). Nothing in this repository fabricates a
 *     model file, and a small random-weight tensor that "looks like" a
 *     classifier would produce confident, meaningless scores, which is strictly
 *     worse than no model at all.
 *
 *   - The heuristic scorer below, which is a real, inspectable lexical model
 *     with no asset, no WASM and no permissions. It is what the extension
 *     actually runs today, and it is written to be *explainable* rather than
 *     clever: every number it produces is the sum of named signals, each of
 *     which reports its own contribution, so the UI can say which observation
 *     drove a decision instead of asserting a verdict it cannot support.
 *
 * The design constraint is the same asymmetric one the pre-filter (#66) was
 * written under. A false negative - showing a piece of misinformation - is the
 * failure this extension exists to prevent. A false positive - hiding a post a
 * human wrote - costs the user a real post. So the heuristic is tuned to sit
 * well below the backend's own scores: it is a *coarse* signal that can trip a
 * threshold, never a verdict, and callers are expected to label it as such.
 *
 * Nothing here throws. A classifier that raises is a content script that stops
 * scanning the feed, and a missing file is not a reason for that.
 */

import {
  DEFAULT_MAX_INPUT_TOKENS,
  createTokenizer,
  foldText,
  loadVocab,
} from "./tokenizer.js";
import {
  SESSION_STATUS,
  VOCAB_PATH,
  createOnnxSession,
  describeSessionStatus,
  resolveAssetUrl,
} from "./onnx-session.js";

/** Which engine produced a classification. */
export const CLASSIFIER_SOURCES = Object.freeze({
  ONNX: "onnx",
  HEURISTIC: "heuristic",
});

/**
 * What the user is actually getting, in a form the popup can label.
 *
 * Deliberately more states than "works / does not": "the model is installed but
 * this context cannot read it" and "no model is installed" need different
 * actions from the user, and merging them sends people to re-download something
 * they already have.
 */
export const MODEL_STATUS = Object.freeze({
  ONNX_READY: "onnx-ready",
  MODEL_PRESENT: "model-present",
  MISSING_ASSET: "missing-asset",
  RUNTIME_MISSING: "runtime-missing",
  ASSET_UNREADABLE: "asset-unreadable",
  HEURISTIC_ONLY: "heuristic-only",
});

/** Stable signal identifiers. The UI maps these to message names. */
export const SIGNAL_IDS = Object.freeze({
  ABSOLUTE_QUANTIFIER: "absolute-quantifier",
  CALL_TO_ACTION: "call-to-action",
  URGENCY_AUTHORITY: "urgency-authority",
  SHOUTING: "shouting",
  HASHTAG_SPAM: "hashtag-spam",
  SECOND_PERSON_IMPERATIVE: "second-person-imperative",
  SUPERLATIVE: "superlative",
});

/**
 * How much each signal can contribute to each axis.
 *
 * The weights sum to 1 per axis, so a caption that trips every signal at full
 * strength scores exactly 1. That is not decoration: it is what makes
 * `sum(contributions) === score` a checkable invariant, which is the only way
 * the UI can ever honestly explain a number.
 *
 * `ai` is "was this text written by a model": engagement mechanics, shouting
 * and reader-directed instructions. `news` is "is a claim here likely to be
 * false": absolutes, authority appeals and hype. The overlap is real - a post
 * that trips both is usually a generated engagement bait post - and the two
 * axes are thresholds the user sets separately, so they are scored separately.
 */
const WEIGHTS = Object.freeze({
  [SIGNAL_IDS.ABSOLUTE_QUANTIFIER]: { ai: 0.1, news: 0.26 },
  [SIGNAL_IDS.CALL_TO_ACTION]: { ai: 0.28, news: 0.16 },
  [SIGNAL_IDS.URGENCY_AUTHORITY]: { ai: 0.06, news: 0.24 },
  [SIGNAL_IDS.SHOUTING]: { ai: 0.18, news: 0.06 },
  [SIGNAL_IDS.HASHTAG_SPAM]: { ai: 0.1, news: 0.1 },
  [SIGNAL_IDS.SECOND_PERSON_IMPERATIVE]: { ai: 0.16, news: 0.04 },
  [SIGNAL_IDS.SUPERLATIVE]: { ai: 0.12, news: 0.14 },
});

/** Detection order. Output is re-sorted by contribution before scoring. */
const SIGNAL_ORDER = Object.freeze([
  SIGNAL_IDS.ABSOLUTE_QUANTIFIER,
  SIGNAL_IDS.CALL_TO_ACTION,
  SIGNAL_IDS.URGENCY_AUTHORITY,
  SIGNAL_IDS.SHOUTING,
  SIGNAL_IDS.HASHTAG_SPAM,
  SIGNAL_IDS.SECOND_PERSON_IMPERATIVE,
  SIGNAL_IDS.SUPERLATIVE,
]);

/**
 * A term that asserts rather than hedges.
 *
 * Single tokens only. Multi-word variants were tried and dropped: "no one" and
 * "nobody" both appear here, and a phrase list that overlaps itself makes the
 * per-word denominator meaningless.
 */
const ABSOLUTE_WORDS = new Set([
  "always",
  "never",
  "everyone",
  "everybody",
  "nobody",
  "no1",
  "none",
  "nothing",
  "everything",
  "all",
  "every",
  "must",
  "guaranteed",
  "proven",
  "proved",
  "definitely",
  "certainly",
  "undoubtedly",
  "unquestionably",
  "undeniable",
]);

/**
 * Engagement mechanics.
 *
 * Phrases rather than words because the individual words are ordinary: "share"
 * and "save" and "follow" are how every caption on the platform reads. Only the
 * instruction is a signal.
 */
const CALL_TO_ACTION_PHRASES = Object.freeze([
  "share this",
  "like and share",
  "comment below",
  "comment this",
  "tag a friend",
  "tag someone",
  "send this to",
  "forward this",
  "link in bio",
  "link in my bio",
  "double tap",
  "swipe up",
  "dm me",
  "follow me",
  "subscribe",
  "turn on notifications",
  "enable notifications",
  "save this post",
  "save this video",
  "share in your stories",
  "copy this",
  "let that sink in",
  "drop a comment",
  "help me reach",
  "go viral",
  "sound off",
]);

/**
 * Urgency and borrowed authority.
 *
 * "studies show" is the single most useful entry here and the reason this
 * signal exists. It is a citation with no citation: the appeal to authority is
 * the claim, and the absence of a source is what makes it misinformation rather
 * than reporting.
 */
const URGENCY_AUTHORITY_PHRASES = Object.freeze([
  "before it's too late",
  "before it is too late",
  "before this is removed",
  "before they delete this",
  "act now",
  "apply now",
  "urgent",
  "urgently",
  "breaking",
  "exclusive",
  "doctors say",
  "doctors know",
  "studies show",
  "study shows",
  "scientists say",
  "scientists confirm",
  "researchers say",
  "officials say",
  "the government says",
  "the government knows",
  "they don't want you to know",
  "they do not want you to know",
  "wake up",
  "sheeple",
  "follow the money",
  "last chance",
  "final warning",
  "sources say",
  "insider",
  "leaked",
  "exposed",
  "banned",
  "censored",
  "silenced",
  "cover up",
  "cover-up",
]);

/** Audience words. "we" and "us" count: "stop lying to us" is second person. */
const SECOND_PERSON_WORDS = new Set([
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
  "u",
  "ur",
  "urs",
  "we",
  "us",
  "our",
  "ours",
  "everyone",
  "everybody",
  "people",
  "yall",
]);

/**
 * Verbs that open an instruction.
 *
 * Checked only as the first word of a clause, so "I share this" is not an
 * instruction and "share this" is.
 */
const IMPERATIVE_VERBS = new Set([
  "stop",
  "share",
  "comment",
  "tag",
  "send",
  "forward",
  "click",
  "tap",
  "follow",
  "save",
  "subscribe",
  "wake",
  "check",
  "read",
  "look",
  "listen",
  "believe",
  "remember",
  "delete",
  "open",
  "visit",
  "type",
  "go",
  "get",
  "do",
  "dont",
  "ask",
  "tell",
  "watch",
  "support",
  "like",
  "repost",
  "report",
  "call",
  "text",
  "post",
  "demand",
]);

/**
 * Superlatives and hype, as an explicit list.
 *
 * A morphological `-est` rule was tried and rejected: "interest", "request",
 * "witness", "protest" and "harvest" all end in it, and the signal fired on
 * ordinary English often enough to be worthless. Precision matters more here
 * than coverage - a fixed list can be audited, a suffix rule cannot.
 */
const SUPERLATIVE_WORDS = new Set([
  "best",
  "worst",
  "biggest",
  "fastest",
  "cheapest",
  "safest",
  "greatest",
  "smallest",
  "largest",
  "strongest",
  "deadliest",
  "ultimate",
  "unbeatable",
  "unmatched",
  "unforgettable",
  "miracle",
  "miraculous",
  "revolutionary",
  "unprecedented",
  "world first",
]);

/**
 * A shouted word: four or more capitals in a row.
 *
 * Four rather than three, and that one character is the whole rule. Three would
 * sweep in "FBI", "CDC" and "WHO" - an acronym in an ordinary sentence is not
 * shouting, and the signal is strong enough that a caption naming two agencies
 * should not look like engagement bait. It also exempts the three-letter grammar
 * glue of a fully capitalised caption ("THE", "AND", "IS"), which lowers the
 * ratio of a real all-caps post without ever taking it below saturation.
 */
const SHOUTING_TOKEN = /^[\p{Lu}\p{N}]{4,}$/u;

/** A whole word or a hashtag. */
const WORD_TOKEN = /^[\p{L}\p{N}]+$/u;
const HASHTAG_TOKEN = /^#[\p{L}\p{N}_]+$/u;

/** Caption length at which the evidence is considered full. */
const EVIDENCE_FULL_WORDS = 40;

/** Absolute terms needed to saturate the signal. */
const ABSOLUTE_SATURATION = 3;
/** Phrases needed to saturate a phrase signal. */
const PHRASE_SATURATION = 2;
/** All-caps words needed to saturate the shouting signal. */
const SHOUTING_SATURATION = 3;
/** Hashtags needed to saturate the hashtag signal. */
const HASHTAG_SATURATION = 4;
/** Superlatives needed to saturate the superlative signal. */
const SUPERLATIVE_SATURATION = 2;

/**
 * Which output column feeds which score.
 *
 * The two axes are different questions - "was this machine-generated" and "is a
 * claim here probably false" - and a single binary classifier cannot honestly
 * answer both. The exported checkpoint is therefore a two-head model and the
 * column order is part of the operator contract, documented in
 * docs/models/README.md. Re-training with the columns the other way round
 * produces a confidently inverted score rather than an error, which is why this
 * is a constant and not something inferred at runtime.
 */
export const DEFAULT_CHANNEL_MAP = Object.freeze({ ai: 1, news: 0 });

/** @param {number} value @returns {number} */
function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(1, Math.max(0, numeric));
}

/** @param {number} numerator @param {number} saturation @returns {number} */
function ratio(numerator, saturation) {
  return Math.min(1, numerator / saturation);
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * @param {string} haystack @param {string} needle @returns {number}
 */
function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * @param {string} folded @param {readonly string[]} phrases
 * @returns {{value: number, evidence: string[]}}
 */
function phraseSignal(folded, phrases) {
  const evidence = [];
  let hits = 0;
  for (const phrase of phrases) {
    const found = occurrences(folded, phrase);
    if (found === 0) continue;
    hits += found;
    evidence.push(phrase);
  }
  return { value: ratio(hits, PHRASE_SATURATION), evidence };
}

/**
 * @param {object} context
 * @param {string} context.folded lowercased, accent-stripped, single-spaced
 * @param {string[]} context.tokens whitespace tokens of the folded text
 * @param {string[]} context.rawTokens whitespace tokens with the case intact
 * @param {string[]} context.words tokens that are entirely letters/digits
 * @returns {Record<string, {value: number, evidence: string[]}>}
 */
function detectAll(context) {
  const { folded, tokens, rawTokens, words } = context;
  const out = {};

  const absolutes = words.filter((word) => ABSOLUTE_WORDS.has(word));
  out[SIGNAL_IDS.ABSOLUTE_QUANTIFIER] = {
    value: ratio(absolutes.length, ABSOLUTE_SATURATION),
    evidence: absolutes.slice(0, 5),
  };

  out[SIGNAL_IDS.CALL_TO_ACTION] = phraseSignal(folded, CALL_TO_ACTION_PHRASES);

  out[SIGNAL_IDS.URGENCY_AUTHORITY] = phraseSignal(folded, URGENCY_AUTHORITY_PHRASES);

  // Case-sensitive on purpose, and the only signal that is: shouting is the
  // whole signal. It reads the raw tokens, because every other detector sees
  // folded text and folding first would delete this one entirely.
  const caps = rawTokens.filter((token) => SHOUTING_TOKEN.test(token));
  const shoutable = words.length >= 3;
  out[SIGNAL_IDS.SHOUTING] = {
    value: shoutable ? ratio(caps.length, SHOUTING_SATURATION) : 0,
    evidence: caps.slice(0, 5),
  };

  const hashtags = tokens.filter((token) => HASHTAG_TOKEN.test(token));
  out[SIGNAL_IDS.HASHTAG_SPAM] = {
    value: ratio(hashtags.length, HASHTAG_SATURATION),
    evidence: hashtags.slice(0, 5),
  };

  // Sentence-level, not word-level: "you" appears constantly in captions that
  // assert nothing ("I saw you at the store"), and only an instruction aimed at
  // the reader is a generation signal.
  const clauses = folded
    .split(/[.!?;:,\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const addressed = clauses.filter(
    (clause) =>
      IMPERATIVE_VERBS.has(clause.split(" ")[0]) &&
      clause.split(" ").some((word) => SECOND_PERSON_WORDS.has(word)),
  );
  out[SIGNAL_IDS.SECOND_PERSON_IMPERATIVE] = {
    value: clauses.length > 0 ? addressed.length / clauses.length : 0,
    evidence: addressed.slice(0, 3),
  };

  const superlatives = words.filter((word) => SUPERLATIVE_WORDS.has(word));
  out[SIGNAL_IDS.SUPERLATIVE] = {
    value: ratio(superlatives.length, SUPERLATIVE_SATURATION),
    evidence: superlatives.slice(0, 5),
  };

  return out;
}
/**
 * Score a caption with the heuristic, deterministically and without any asset.
 *
 * @param {unknown} text
 * @returns {{aiScore: number, newsScore: number, confidence: number,
 *   signals: Array<{id: string, value: number, evidence: string[],
 *     aiWeight: number, newsWeight: number,
 *     aiContribution: number, newsContribution: number}>}}
 */
export function classifyHeuristic(text) {
  const raw = String(text ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const folded = foldText(raw);
  const tokens = folded ? folded.split(" ") : [];
  const rawTokens = raw ? raw.split(" ") : [];
  const words = tokens.filter((token) => WORD_TOKEN.test(token));

  const detected = detectAll({ folded, tokens, rawTokens, words });

  const signals = [];
  for (const id of SIGNAL_ORDER) {
    const hit = detected[id];
    if (!hit || !(hit.value > 0)) continue;
    const weights = WEIGHTS[id];
    signals.push({
      id,
      value: hit.value,
      evidence: hit.evidence,
      aiWeight: weights.ai,
      newsWeight: weights.news,
      aiContribution: hit.value * weights.ai,
      newsContribution: hit.value * weights.news,
    });
  }

  // Sorted before scoring, and scored by folding over the sorted list, so the
  // contributions a caller sees always add up to the number it is shown.
  signals.sort(
    (a, b) =>
      b.aiContribution + b.newsContribution - (a.aiContribution + a.newsContribution) ||
      a.id.localeCompare(b.id),
  );

  const aiScore = clamp01(
    signals.reduce((sum, signal) => sum + signal.aiContribution, 0),
  );
  const newsScore = clamp01(
    signals.reduce((sum, signal) => sum + signal.newsContribution, 0),
  );

  // How much the numbers are worth, not a probability of correctness: half the
  // evidence available (a 40-word caption is a full one, a five-word caption is
  // an eighth), half the separation from "nothing fired". A trained model would
  // earn this from calibration; a keyword counter cannot, so it is reported as
  // what it is.
  const evidenceVolume = Math.min(1, words.length / EVIDENCE_FULL_WORDS);
  const confidence = clamp01(0.5 * evidenceVolume + 0.5 * Math.max(aiScore, newsScore));

  return { aiScore, newsScore, confidence, signals };
}

/**
 * @param {unknown} text
 * @returns {string}
 */
function textShape(text) {
  return foldText(String(text ?? ""))
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The vocabulary fetched from the packaged asset, kept for the page's life. */
let cachedVocab = null;

/**
 * @param {string|null} path
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Map<string, number>|null>}
 */
async function fetchVocab(path, fetchImpl, session) {
  const text =
    typeof session?.textAsset === "function" && !fetchImpl
      ? await session.textAsset(path)
      : null;
  if (text !== null) {
    try {
      return loadVocab(text);
    } catch {
      return null;
    }
  }

  const doFetch =
    fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  if (!doFetch) return null;
  try {
    const response = await doFetch(resolveAssetUrl(path));
    if (!response?.ok) return null;
    return loadVocab(await response.text());
  } catch {
    return null;
  }
}

/**
 * Resolve a tokenizer, reusing the module-level one when possible.
 *
 * The vocabulary is a fixed packaged asset, so it is fetched at most once per
 * page even with a dozen posts in the feed. A tokenizer is required for the ONNX
 * path: the model takes ids, and inventing them would produce a sequence the
 * checkpoint has never seen.
 *
 * @param {object} options
 * @param {import("./onnx-session.js").OnnxSession|null} session
 * @returns {Promise<import("./tokenizer.js").WordPieceTokenizer|null>}
 */
async function resolveTokenizer(options, session) {
  if (options.tokenizer) return options.tokenizer;
  if (options.vocab !== undefined && options.vocab !== null) {
    try {
      cachedVocab = loadVocab(options.vocab);
    } catch {
      cachedVocab = null;
    }
  }
  if (!cachedVocab) {
    cachedVocab = await fetchVocab(
      options.vocabPath ?? VOCAB_PATH,
      options.fetchImpl,
      session,
    );
  }
  if (!cachedVocab || cachedVocab.size === 0) return null;
  return createTokenizer({
    vocab: cachedVocab,
    maxInputTokens: options.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
  });
}

/** @param {number} value @returns {number} */
function sigmoid(value) {
  // Branch rather than the closed form: exp(1000) is Infinity and 1 - Infinity
  // is -Infinity, so the naive expression returns NaN for a confident logit
  // and a NaN score is worse than no score at all.
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

/**
 * Pull the score vector out of a session's output map.
 *
 * @param {any} outputs
 * @returns {number[]|null}
 */
function readLogits(outputs) {
  if (!outputs || typeof outputs !== "object") return null;
  const candidate = outputs.logits ?? Object.values(outputs)[0];
  const data = candidate?.data;
  if (!data || typeof data.length !== "number" || data.length === 0) return null;
  const values = Array.from(data, (value) => Number(value));
  return values.every((value) => Number.isFinite(value)) ? values : null;
}

/**
 * @typedef {object} Classification
 * @property {number} aiScore 0..1
 * @property {number} newsScore 0..1
 * @property {number|null} confidence null for the ONNX path: a raw
 *   classification head is not calibrated, and inventing a number here would be
 *   the most misleading thing this module could do
 * @property {"onnx"|"heuristic"} source
 * @property {string} status a MODEL_STATUS value
 * @property {boolean} aiScored whether this run produced the ai axis
 * @property {boolean} newsScored whether this run produced the news axis
 * @property {Array<object>} signals per-signal attribution, empty for the ONNX
 *   path: a transformer has no lexical explanation to offer, and pretending
 *   otherwise would be a fabrication
 */

/**
 * @param {number[]} logits
 * @param {{channels?: {ai?: number, news?: number}, singleChannel?: "ai"|"news"}} options
 * @returns {{aiScore: number, newsScore: number, aiScored: boolean, newsScored: boolean}|null}
 */
function scoresFromLogits(logits, options) {
  const channels = { ...DEFAULT_CHANNEL_MAP, ...(options.channels || {}) };
  const single = options.singleChannel === "news" ? "news" : "ai";

  if (logits.length === 1) {
    // A one-output head can answer one question. The other axis is left at 0
    // and reported as unscored, so a caller can tell "the model said no" from
    // "the model did not look".
    const value = clamp01(sigmoid(logits[0]));
    return single === "ai"
      ? { aiScore: value, newsScore: 0, aiScored: true, newsScored: false }
      : { aiScore: 0, newsScore: value, aiScored: false, newsScored: true };
  }

  const ai = channels.ai;
  const news = channels.news;
  if (!Number.isInteger(ai) || !Number.isInteger(news)) return null;
  if (ai < 0 || news < 0 || ai >= logits.length || news >= logits.length) return null;

  // Squashed independently, not as a 2-way softmax: the two heads answer two
  // different questions, and forcing them to sum to 1 would make "90% AI
  // generated" and "90% misinformation" mutually exclusive, which is nonsense.
  return {
    aiScore: clamp01(sigmoid(logits[ai])),
    newsScore: clamp01(sigmoid(logits[news])),
    aiScored: true,
    newsScored: true,
  };
}

/** @returns {import("./onnx-session.js").OnnxSession} */
function defaultSession() {
  if (!defaultSession.instance) {
    defaultSession.instance = createOnnxSession();
  }
  return defaultSession.instance;
}

/** The lazily created shared session. Exposed for tests and for reset. */
export function getDefaultSession() {
  return defaultSession();
}

/**
 * Forget the shared session and vocabulary.
 *
 * The point is operational rather than architectural: an operator who installs
 * a model has to be able to see it without reloading every open tab, and a
 * remembered failure would otherwise hide it for the life of the page.
 */
export function resetDefaultSession() {
  if (defaultSession.instance) defaultSession.instance.reset();
  defaultSession.instance = null;
  cachedVocab = null;
}

/**
 * @param {string} sessionStatus
 * @returns {string} a MODEL_STATUS value
 */
function modelStatusFor(sessionStatus) {
  switch (sessionStatus) {
    case SESSION_STATUS.READY:
      return MODEL_STATUS.ONNX_READY;
    case SESSION_STATUS.MISSING_ASSET:
      return MODEL_STATUS.MISSING_ASSET;
    case SESSION_STATUS.RUNTIME_UNAVAILABLE:
      return MODEL_STATUS.RUNTIME_MISSING;
    case SESSION_STATUS.ASSET_UNREADABLE:
      return MODEL_STATUS.ASSET_UNREADABLE;
    default:
      return MODEL_STATUS.HEURISTIC_ONLY;
  }
}

/**
 * Run the transformer, if one is installed and loadable here.
 *
 * @param {string} text
 * @param {import("./onnx-session.js").OnnxSession} session
 * @param {object} options
 * @returns {Promise<Classification|null>} null for every failure, without throwing
 */
async function classifyWithOnnx(text, session, options) {
  const tokenizer = await resolveTokenizer(options, session);
  if (!tokenizer) return null;

  const encoding = tokenizer.tokenize(text);
  const length = encoding.inputIds.length;
  const dims = [1, length];

  const inputIds = await session.tensor("input_ids", encoding.inputIds, dims);
  const attentionMask = await session.tensor(
    "attention_mask",
    encoding.attentionMask,
    dims,
  );
  if (!inputIds || !attentionMask) return null;

  const feeds = { input_ids: inputIds, attention_mask: attentionMask };
  // Optional: many exports drop token_type_ids, and passing a tensor for an
  // input the graph does not have is an error in onnxruntime, not a no-op.
  const tokenTypes = await session.tensor("token_type_ids", encoding.tokenTypeIds, dims);
  if (tokenTypes) feeds.token_type_ids = tokenTypes;

  const outputs = await session.run(feeds);
  const logits = readLogits(outputs);
  if (!logits) return null;

  const scores = scoresFromLogits(logits, options);
  if (!scores) return null;

  return {
    aiScore: scores.aiScore,
    newsScore: scores.newsScore,
    confidence: null,
    source: CLASSIFIER_SOURCES.ONNX,
    status: MODEL_STATUS.ONNX_READY,
    aiScored: scores.aiScored,
    newsScored: scores.newsScored,
    signals: [],
  };
}

/**
 * Classify a caption on device.
 *
 * The ONNX path is tried first and the heuristic is the floor, never the other
 * way round: an installed model is strictly more informative than a keyword
 * count and there is no reason to prefer the cheap answer.
 *
 * @param {unknown} text
 * @param {object} [options]
 * @param {import("./onnx-session.js").OnnxSession|null} [options.session]
 *   null forces the heuristic and skips the asset probes entirely
 * @param {import("./tokenizer.js").WordPieceTokenizer} [options.tokenizer]
 * @param {unknown} [options.vocab] vocabulary, to avoid fetching the asset
 * @param {{ai?: number, news?: number}} [options.channels] output column map
 * @param {"ai"|"news"} [options.singleChannel] which axis a 1-output head fills
 * @returns {Promise<Classification|null>} null only for empty input
 */
export async function classify(text, options = {}) {
  const normalized = textShape(text);
  if (!normalized) return null;

  const session = options.session === undefined ? defaultSession() : options.session;
  let onnx = null;
  if (session) {
    try {
      onnx = await classifyWithOnnx(normalized, session, options);
    } catch {
      // A runtime that throws while loading or running is the same as one that
      // is not there. The heuristic below is the answer either way.
      onnx = null;
    }
  }

  if (onnx) return onnx;

  const snapshot = session?.snapshot?.() ?? null;
  return {
    ...classifyHeuristic(normalized),
    source: CLASSIFIER_SOURCES.HEURISTIC,
    status: modelStatusFor(snapshot?.status ?? SESSION_STATUS.IDLE),
    aiScored: true,
    newsScored: true,
  };
}

/**
 * Report what a user is actually getting, without loading the weights.
 *
 * The popup calls this. It deliberately stops at a probe: opening a ~100 MB
 * model just to render one line of status would make the popup slower than the
 * thing it is describing.
 *
 * @param {object} [options]
 * @param {import("./onnx-session.js").OnnxSession|null} [options.session]
 * @returns {Promise<{status: string, runtime: boolean, asset: string, detail: string}>}
 */
export async function describeLocalModel(options = {}) {
  const session = options.session === undefined ? defaultSession() : options.session;
  if (!session) {
    return {
      status: MODEL_STATUS.HEURISTIC_ONLY,
      runtime: false,
      asset: "unknown",
      detail: "no onnx session was created",
    };
  }

  try {
    await session.readiness();
  } catch {
    return {
      status: MODEL_STATUS.HEURISTIC_ONLY,
      runtime: false,
      asset: "unknown",
      detail: "the onnx probe threw",
    };
  }

  const { status, detail } = session.snapshot();
  const asset =
    status === SESSION_STATUS.MISSING_ASSET
      ? "missing"
      : status === SESSION_STATUS.ASSET_UNREADABLE
        ? "unreadable"
        : status === SESSION_STATUS.RUNTIME_UNAVAILABLE
          ? "unknown"
          : "present";

  return {
    // A successful probe that has not built a session yet means the files are
    // all there. Saying "heuristic only" would be wrong in the one case where
    // the user's next action is nothing at all.
    status:
      status === SESSION_STATUS.IDLE || status === SESSION_STATUS.LOADING
        ? MODEL_STATUS.MODEL_PRESENT
        : modelStatusFor(status),
    runtime: status !== SESSION_STATUS.RUNTIME_UNAVAILABLE,
    asset,
    detail: describeSessionStatus(status, detail),
  };
}
