/**
 * Placeholder rendering.
 *
 * The markup for a hidden post was produced by a single function that
 * interpolated untrusted model output into an HTML string and assigned it to
 * `innerHTML`. The same ~100 lines were then duplicated verbatim in three
 * other places (removePost, rehideTempVisiblePosts, processSinglePost), each
 * copy slightly different, and each re-attaching its own listeners.
 *
 * This module owns the markup and the listener wiring in one place. Callers
 * pass a post key and a result; they never touch innerHTML.
 */

import { safeUrl } from "./sanitize.js";
import { HIDING_ACTIONS } from "./defaults.js";

const BRAND = "uBlockAI";

/**
 * The attribute contract between the scanner, this module and the CSS.
 *
 * These names were written out in five places across the content script, with
 * no single owner, so a rename would silently break the post selectors, the
 * MutationObserver filter and the stylesheet.
 */
export const MARK_ATTRS = Object.freeze({
  PROCESSED: "data-aibot-processed",
  REMOVED: "data-aibot-removed",
  SAFE: "data-aibot-safe",
  TEMP_VISIBLE: "data-aibot-temp-visible",
  POST_KEY: "data-aibot-post-key",
});

/**
 * Stamp the processing markers onto a post element, clearing the states that
 * are mutually exclusive with the requested one.
 *
 * @param {Element} element
 * @param {{postKey?: string, state: "hidden"|"safe"|"temp-visible"|"none"}} params
 * @returns {boolean} false when the element is gone
 */
export function markPost(element, { postKey, state }) {
  if (!element || !element.isConnected) return false;

  element.setAttribute(MARK_ATTRS.PROCESSED, "true");
  if (postKey) {
    element.setAttribute(MARK_ATTRS.POST_KEY, postKey);
    element.dataset.postKey = postKey;
  }

  if (state === "hidden") {
    element.setAttribute(MARK_ATTRS.REMOVED, "true");
    element.removeAttribute(MARK_ATTRS.SAFE);
    element.removeAttribute(MARK_ATTRS.TEMP_VISIBLE);
  } else if (state === "safe") {
    element.setAttribute(MARK_ATTRS.SAFE, "true");
    element.removeAttribute(MARK_ATTRS.REMOVED);
    element.removeAttribute(MARK_ATTRS.TEMP_VISIBLE);
  } else if (state === "temp-visible") {
    element.setAttribute(MARK_ATTRS.TEMP_VISIBLE, "true");
    element.removeAttribute(MARK_ATTRS.REMOVED);
    element.removeAttribute(MARK_ATTRS.SAFE);
  }

  return true;
}

/**
 * Build the placeholder node for a flagged post.
 *
 * @param {object} params
 * @param {string} params.postKey stable identifier for the post
 * @param {string} [params.explanation] model-provided text, escaped
 * @param {number} [params.aiScore] 0..1
 * @param {number} [params.newsScore] 0..1
 * @param {string} [params.reason] short reason shown as the heading
 * @param {string} [params.imageUrl] source image, used by the blur action
 * @param {string} [params.videoUrl] source video, used by the blur action
 * @param {string} [params.videoThumb] poster frame shown until the video loads
 * @param {string} [params.action] one of HIDING_ACTIONS
 * @param {boolean} [params.reported] whether a report was already sent
 * @returns {HTMLElement|null} the placeholder element, or null for 'remove'
 */
export function buildPlaceholder(params) {
  const {
    postKey,
    explanation = "",
    aiScore = 0,
    newsScore = 0,
    reason = "",
    imageUrl = "",
    videoUrl = "",
    videoThumb = "",
    action = HIDING_ACTIONS.PLACEHOLDER,
    reported = false,
  } = params;

  if (action === HIDING_ACTIONS.REMOVE) return null;

  const root = document.createElement("div");
  root.className = "aibot-placeholder";
  root.dataset.postKey = postKey;

  if (action === HIDING_ACTIONS.BLUR) {
    // The blur action was inert: the class was added but the placeholder never
    // contained an image, so there was nothing to blur and it rendered
    // identically to the placeholder action.
    root.classList.add("aibot-blur");
    const media = buildBlurredMedia(imageUrl, { videoUrl, videoThumb });
    if (media) root.insertBefore(media, root.firstChild);
  }

  const backdrop = document.createElement("div");
  backdrop.className = "aibot-backdrop";

  const panel = document.createElement("div");
  panel.className = "aibot-panel";
  panel.setAttribute("role", "region");
  panel.setAttribute(
    "aria-label",
    `Content hidden by ${BRAND} as possible misinformation`,
  );

  const icon = document.createElement("div");
  icon.className = "aibot-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "⚠";

  const heading = document.createElement("h3");
  heading.className = "aibot-heading";
  heading.textContent = reason || "Flagged as possible misinformation";

  const brand = document.createElement("p");
  brand.className = "aibot-brand";
  brand.textContent = `Hidden by ${BRAND}`;

  if (explanation) {
    const detail = document.createElement("p");
    detail.className = "aibot-explanation";
    // textContent, not innerHTML: the explanation is model output derived from
    // a social media post.
    detail.textContent = explanation;
    panel.append(icon, heading, brand, detail);
  } else {
    panel.append(icon, heading, brand);
  }

  const scores = document.createElement("div");
  scores.className = "aibot-scores";
  const ai = document.createElement("span");
  ai.textContent = `AI-generated risk: ${Math.round(aiScore * 100)}%`;
  const news = document.createElement("span");
  news.textContent = `Misinformation risk: ${Math.round(newsScore * 100)}%`;
  scores.append(ai, news);
  panel.append(scores);

  const actions = document.createElement("div");
  actions.className = "aibot-actions";

  const showButton = document.createElement("button");
  showButton.type = "button";
  showButton.className = "aibot-show-btn";
  showButton.textContent = "Show post anyway";
  actions.append(showButton);

  const reportButton = document.createElement("button");
  reportButton.type = "button";
  reportButton.className = "aibot-report-fp";
  reportButton.textContent = reported ? "Reported" : "Report mistake";
  if (reported) reportButton.disabled = true;
  actions.append(reportButton);

  panel.append(actions);
  backdrop.append(panel);
  root.append(backdrop);

  return root;
}

/**
 * Render the stylesheet for placeholders once per document.
 *
 * These were inline `style="..."` attributes before, repeated on every element.
 * A stylesheet is smaller, cacheable, and keeps the markup readable.
 */
const STYLE_ID = "aibot-styles";

const CSS = `
.aibot-placeholder {
  position: relative;
  overflow: hidden;
  border-radius: 8px;
  margin: 8px 0;
  min-height: 220px;
  background: #14161a;
  border: 1px solid #2b3038;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.aibot-placeholder .aibot-backdrop {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  text-align: center;
  background: linear-gradient(to bottom, rgba(0,0,0,0.35), rgba(0,0,0,0.7));
}
.aibot-placeholder .aibot-panel { max-width: 420px; color: #e6e8ec; }
.aibot-placeholder .aibot-icon { font-size: 40px; line-height: 1; margin-bottom: 8px; }
.aibot-placeholder .aibot-heading { font-size: 18px; font-weight: 650; margin: 0 0 4px; }
.aibot-placeholder .aibot-brand { font-size: 13px; color: #9aa3af; margin: 0 0 10px; }
.aibot-placeholder .aibot-explanation { font-size: 14px; color: #cbd2dc; margin: 0 0 10px; line-height: 1.45; }
.aibot-placeholder .aibot-scores {
  display: flex; gap: 14px; justify-content: center;
  font-size: 12px; color: #9aa3af; margin-bottom: 12px; flex-wrap: wrap;
}
.aibot-placeholder .aibot-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.aibot-placeholder button {
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  border-radius: 999px; padding: 8px 16px; border: 1px solid #3b414b;
  background: #22262d; color: #e6e8ec;
}
.aibot-placeholder button:hover:not(:disabled) { background: #2b313a; }
.aibot-placeholder button:disabled { opacity: 0.6; cursor: default; }
.aibot-placeholder .aibot-show-btn { border-color: #4dabf7; color: #4dabf7; }
.aibot-placeholder.aibot-blur img,
.aibot-placeholder.aibot-blur video { filter: blur(28px); }
`;

/**
 * Build the placeholder and attach its listeners, in one call.
 *
 * Listeners are attached to the node this call just created, so a second mount
 * cannot double-bind. Handing callers a bare node and letting them wire it is
 * how the same listener ended up bound twice in the previous design.
 *
 * @param {Parameters<typeof buildPlaceholder>[0]} params
 * @param {{onReveal?: () => void, onReport?: () => void}} [handlers]
 * @returns {HTMLElement|null} null when the action is "remove"
 */
export function mountPlaceholder(params, handlers = {}) {
  const placeholder = buildPlaceholder(params);
  if (!placeholder) return null;

  const showButton = placeholder.querySelector(".aibot-show-btn");
  if (showButton && handlers.onReveal) {
    showButton.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onReveal();
    });
  }

  const reportButton = placeholder.querySelector(".aibot-report-fp");
  if (reportButton && handlers.onReport) {
    reportButton.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      handlers.onReport();
    });
  }

  return placeholder;
}

/** Inject the placeholder stylesheet once. Safe to call repeatedly. */
export function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).append(style);
}

/**
 * Build the media wrapper used by the blur action.
 *
 * The original content is kept but blurred, so the user can still recognise
 * the post they are looking at while the text is illegible. The image is
 * re-created rather than reusing the site's node so the site's own event
 * handlers are not attached to it. For video/Reel posts the poster frame is
 * blurred the same way, with the video itself paused behind it so nothing
 * autoplays inside a hidden post.
 *
 * @param {string|null} imageUrl
 * @param {{videoUrl?: string, videoThumb?: string}} [video]
 * @returns {HTMLElement}
 */
export function buildBlurredMedia(imageUrl, video = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "aibot-media";

  const videoSrc = safeUrl(video.videoUrl);
  if (videoSrc) {
    const node = document.createElement("video");
    // setAttribute rather than property assignment: linkedom and older
    // engines only reflect src/poster on HTMLMediaElement, not on the
    // generic element these tests construct.
    node.setAttribute("src", videoSrc);
    const poster = safeUrl(video.videoThumb) || safeUrl(imageUrl);
    if (poster) node.setAttribute("poster", poster);
    node.muted = true;
    node.loop = true;
    node.playsInline = true;
    node.preload = "none";
    node.setAttribute("aria-hidden", "true");
    node.setAttribute("tabindex", "-1");
    wrapper.append(node);
  }

  const url = safeUrl(imageUrl);
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    wrapper.append(img);
  }

  return wrapper;
}
