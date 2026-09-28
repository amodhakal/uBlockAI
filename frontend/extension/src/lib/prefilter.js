/**
 * Client-side pre-filter (#66).
 *
 * Every post that reaches the backend costs a full agent run: 20-60 seconds,
 * several LLM calls, and real money. A long scroll session can queue dozens of
 * posts before the user has read any of them.
 *
 * The design constraint is asymmetric, and it dictated almost every decision
 * here. Skipping a post that mattered is a correctness failure: misinformation
 * reaches the screen, which is the entire reason this extension exists.
 * Skipping a post that did not matter costs a little CPU. So every rule is
 * written to be wrong in the cheap direction, and the rule set is narrow on
 * purpose.
 *
 * Two findings from writing the tests against this file are baked into the
 * design, because both produced real false suppression on a first pass:
 *
 * 1. A length threshold cannot tell a reaction from a short claim. "Water is
 *    wet" is ten letters; "literally" is nine. Any cutoff that catches one
 *    catches the other, and "drink bleach" is eleven. So length is not used
 *    as a proxy for claim-ness at all - only an explicit list of reactions is.
 *
 * 2. An image is content. The backend OCRs images, so a bare screenshot with
 *    no caption is a primary misinformation vector, not an empty post. Every
 *    text-based rule below is therefore disabled while there is an image to
 *    read, which is why this filter is much more aggressive on text-only
 *    posts than on image posts.
 *
 * Every rule fails open. An exception anywhere means "do not skip", because
 * the only safe answer to "I could not evaluate this" is to analyse it.
 */

import { stableCacheKey } from "./cache.js";

/**
 * Text shorter than this many letters is a reaction, never a claim.
 *
 * Three letters is the only cutoff that is defensible: "omg", "lol" and "wtf"
 * are unambiguously not assertions, and nothing with real content is. Above
 * three, length stops being evidence of absence.
 */
export const MIN_CLAIM_LETTERS = 4;

/** Reasons a post can be skipped. Recorded so the decision is auditable. */
export const SKIP_REASONS = Object.freeze({
  NO_CONTENT: "no_analysable_content",
  TRUSTED: "already_trusted",
  NOT_TEXT: "not_text",
  REACTION: "reaction_only",
});

/**
 * Whole captions that are reactions rather than assertions.
 *
 * Matched against the entire normalised caption, not as a substring: "stop" is
 * a reaction, "stop lying to us" is a claim, and a substring rule would
 * suppress the second. This list is intentionally short and boring. It is not
 * a general "is this interesting" classifier and must not grow into one.
 */
const REACTIONS = new Set([
  "omg",
  "omg no",
  "no",
  "wow",
  "lol",
  "lmao",
  "lmfao",
  "yikes",
  "haha",
  "hahaha",
  "yes",
  "yep",
  "yup",
  "no way",
  "oh no",
  "oh wow",
  "amen",
  "same",
  "true",
  "facts",
  "fr",
  "ikr",
  "stop",
  "wait",
  "wait what",
  "seriously",
  "literally",
  "bruh",
  "nice",
  "cool",
  "aww",
  "oof",
  "oof ouch",
  "nope",
  "nah",
  "yesss",
  "yess",
  "yay",
  "ugh",
  "meh",
  "hmm",
  "huh",
  "who",
  "what",
  "when",
  "where",
  "why",
  "how",
  "not",
  "nta",
  "istg",
  "ngl",
  "w",
  "kk",
  "good morning",
  "good night",
  "happy birthday",
  "congrats",
  "congratulations",
]);

/** @returns {{skip: false, reason: string|null}} */
function analyse() {
  return { skip: false, reason: null };
}

/** @param {string} reason @returns {{skip: true, reason: string}} */
function skip(reason) {
  return { skip: true, reason };
}

/**
 * Strip URLs, leaving the surrounding prose.
 * @param {string} text
 * @returns {string}
 */
function stripUrls(text) {
  return String(text)
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ");
}

/**
 * Keep letters and digits; drop emoji, punctuation and symbols.
 *
 * Uses Unicode property escapes so a caption in any script is treated as text
 * rather than as decoration.
 *
 * @param {string} text
 * @returns {string}
 */
function lettersAndDigits(text) {
  return String(text).replace(/[^\p{Letter}\p{Number}\s]/gu, " ");
}

/**
 * Normalise for exact reaction matching: lowercase, letters/digits only.
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return lettersAndDigits(text).replace(/\s+/g, " ").trim().toLowerCase();
}

/** @param {string} text @returns {boolean} */
function hasDigits(text) {
  return /\d/.test(text);
}

/**
 * Whether every token in the text is a hashtag.
 *
 * "#goals #viral #fyp" is a real and common caption shape with no assertion in
 * it, and it is long enough to clear the letter floor, so neither of the other
 * rules would catch it. Checked per token rather than by counting "#", so
 * "#act #viral the hospital is closing" is correctly left alone: the
 * non-hashtag token is where the claim is.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isOnlyHashtags(text) {
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => /^#\p{L}[\p{L}\p{N}_]*$/u.test(token));
}

/**
 * Whether the post carries an image the backend will OCR.
 *
 * @param {object} post
 * @returns {boolean}
 */
function hasImage(post) {
  return Boolean(String(post?.imageUrl || "").trim());
}

/**
 * Whether the post has anything at all a backend could analyse.
 * @param {object} post
 * @returns {boolean}
 */
function hasAnalysableContent(post) {
  if (String(post?.caption || "").trim()) return true;
  if (String(post?.imageAlt || "").trim()) return true;
  return hasImage(post);
}

/**
 * Whether the text is written in a script this module can reason about.
 *
 * Reaction matching is a fixed English list, and the letter-count floor is
 * calibrated against Latin text. Applying either to a caption in a script it
 * was not written for would suppress real claims in that language, so those
 * captions are let through instead.
 *
 * @param {string} prose output of lettersAndDigits
 * @returns {boolean}
 */
function isMeasurableScript(prose) {
  return /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\s\d]*$/u.test(prose);
}

/**
 * Decide whether a post can be skipped before spending an agent run.
 *
 * @param {object} post a post from an adapter
 * @param {{trustedKeys?: Set<string>|string[], postKey?: string}} [context]
 * @returns {{skip: boolean, reason: string|null, postKey: string}}
 */
export function prefilterPost(post, context = {}) {
  const postKey = context.postKey || stableCacheKey(post) || "";

  try {
    if (!post) return skip(SKIP_REASONS.NO_CONTENT);

    // The user already said "show this anyway". Cheap, and it keeps the
    // pre-filter from fighting the trust list.
    const trusted = context.trustedKeys;
    if (trusted && postKey) {
      const has =
        trusted instanceof Set ? trusted.has(postKey) : trusted.includes(postKey);
      if (has) return skip(SKIP_REASONS.TRUSTED);
    }

    if (!hasAnalysableContent(post)) return skip(SKIP_REASONS.NO_CONTENT);

    // The image is the content. OCR will read it, so nothing about the text
    // layer can justify skipping the post.
    if (hasImage(post)) return analyse();

    const raw = `${post.caption || ""}\n${post.imageAlt || ""}`;
    const withoutUrls = stripUrls(raw);
    const prose = lettersAndDigits(withoutUrls).replace(/\s+/g, " ").trim();

    // Emoji / hashtags / punctuation only. "😂😂 #goals" has no letters.
    if (!prose) return skip(SKIP_REASONS.NOT_TEXT);

    // Links and nothing else is a link, not a claim.
    if (!withoutUrls.replace(/\s+/g, "").length) return skip(SKIP_REASONS.NOT_TEXT);

    // Fail open on scripts the rules below were not written for.
    if (!isMeasurableScript(prose)) return analyse();

    if (isOnlyHashtags(withoutUrls)) return skip(SKIP_REASONS.NOT_TEXT);

    const normalized = normalize(prose);
    if (REACTIONS.has(normalized)) return skip(SKIP_REASONS.REACTION);

    const letters = prose.replace(/[^\p{Letter}]/gu, "");
    if (letters.length < MIN_CLAIM_LETTERS && !hasDigits(raw)) {
      return skip(SKIP_REASONS.REACTION);
    }

    return analyse();
  } catch {
    // Fail open. A pre-filter that cannot evaluate a post must not be the
    // reason a real claim goes unanalysed.
    return analyse();
  }
}

/**
 * Filter a list of posts, returning the ones worth analysing.
 *
 * @param {object[]} posts
 * @param {{trustedKeys?: Set<string>|string[]}} [context]
 * @returns {{keep: object[], skipped: Array<{post: object, reason: string}>}}
 */
export function prefilterPosts(posts, context = {}) {
  const keep = [];
  const skipped = [];
  for (const post of posts || []) {
    const decision = prefilterPost(post, context);
    if (decision.skip) skipped.push({ post, reason: decision.reason });
    else keep.push(post);
  }
  return { keep, skipped };
}
