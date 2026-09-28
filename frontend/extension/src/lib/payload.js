/**
 * Request payload construction.
 *
 * Extracted so the field limits are testable. They previously lived inline in
 * the scan loop, where testing them would have required a DOM.
 */

import { MAX_ALT_TEXT_CHARS, MAX_CAPTION_CHARS } from "./defaults.js";

/**
 * Truncate to a maximum length, marking that content was cut.
 * @param {string} value
 * @param {number} max
 * @param {string} [suffix]
 * @returns {string}
 */
export function truncate(value, max, suffix = "…") {
  const text = value ?? "";
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/**
 * Build the request body for one post.
 *
 * Captions were truncated to 100 characters before being sent, which threw away
 * most of the claim: a misinformation caption routinely states its assertion
 * after the first sentence or two. The backend needs the whole thing to extract
 * and verify the claim.
 *
 * @param {object} post a post from an adapter
 * @param {string} postKey stable identifier, from stableCacheKey
 * @returns {object} the analyze request body
 */
export function buildAnalyzePayload(post, postKey) {
  return {
    post_key: postKey,
    // The backend still needs a fetchable URL for the scrape path, and for
    // AgentContext. The cache key is derived separately and never from this.
    url: post.imageUrl || "",
    caption: truncate(post.caption || "", MAX_CAPTION_CHARS),
    alt_text: truncate(post.imageAlt || "", MAX_ALT_TEXT_CHARS),
    metadata: post.permalink ? { permalink: post.permalink } : {},
    is_video: Boolean(post.isVideo),
  };
}
