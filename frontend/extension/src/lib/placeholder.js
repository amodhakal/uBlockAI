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
 *
 * Accessibility notes, because the panel is injected into somebody else's page
 * and is the only UI this extension owns there:
 *
 *  - It is NOT a dialog and does NOT get a focus trap. It is inline in the
 *    feed, so trapping Tab would make it impossible to tab to the next post,
 *    which is a worse outcome than the problem it solves. The modal detail view
 *    from #79 is where `focus.js`'s trapFocus belongs; see that module.
 *  - Escape reveals the post. A keyboard user who lands here has one keystroke
 *    out, without needing to find and aim at a 13px button.
 *  - Focus moves into the panel only when the user was already focused inside
 *    the content being replaced. Stealing focus on every hide would yank a
 *    screen reader user out of the feed several times per scroll.
 *  - Hides and reveals are announced through a polite live region, because a
 *    silent DOM replacement is invisible to a screen reader.
 */

import { safeUrl } from "./sanitize.js";
import { buildExplanationDetails } from "./explanation.js";
import { FONT_SCALE_CSS_VARIABLE, HIDING_ACTIONS, fontScaleFactor } from "./defaults.js";
import { focusFirstIn, onEscape } from "./focus.js";
import { t } from "./i18n.js";

const BRAND = "uBlockAI";

/** Id of the single polite live region shared by every panel on the page. */
const LIVE_REGION_ID = "aibot-live";

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
 * Announce a message to assistive technology.
 *
 * The warning panel replaces a post's entire content without any navigation, so
 * a screen reader user scrolling the feed gets no indication that anything
 * happened. A polite live region is the only notification that does not steal
 * focus. `aria-live="polite"` rather than "assertive" because hiding a post is
 * not an error and interrupting whatever the user is reading is worse than a
 * slightly delayed announcement.
 *
 * @param {string} message
 * @param {Document} [doc]
 * @returns {HTMLElement|null} the live region, or null when there is no document
 */
export function announce(message, doc) {
  const target = doc || (typeof document === "undefined" ? null : document);
  if (!target || !target.body) return null;

  let region = target.getElementById(LIVE_REGION_ID);
  if (!region) {
    region = target.createElement("div");
    region.id = LIVE_REGION_ID;
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "true");
    // Visually hidden but not display:none or visibility:hidden: either of
    // those removes the element from the accessibility tree and the live region
    // never fires.
    region.className = "aibot-visually-hidden";
    target.body.append(region);
  }

  // Clearing first guarantees a repeat of the same message is still announced;
  // writing an identical string is a no-op for most screen readers.
  region.textContent = "";
  region.textContent = message;
  return region;
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
 * @param {string} [params.fontScale] a FONT_SCALES value
 * @param {string} [params.verdict] backend Verdict enum value
 * @param {number} [params.confidence] 0..1
 * @param {string[]|string} [params.reasoning_chain] step-by-step reasoning
 * @param {string[]|string} [params.reasoningChain] camelCase alias
 * @param {object[]} [params.evidence] evidence items (see explanation.js)
 * @param {string[]|string} [params.uncertainties] unverifiable points
 * @param {object[]} [params.claim_scores] per-claim scores (#86)
 * @param {object[]} [params.claimScores] camelCase alias
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
    fontScale,
    verdict = "",
    confidence = null,
    reasoning_chain: reasoningSnake = [],
    reasoningChain: reasoningCamel = [],
    evidence = [],
    uncertainties = [],
    claim_scores: claimScoresSnake = [],
    claimScores: claimScoresCamel = [],
  } = params;

  if (action === HIDING_ACTIONS.REMOVE) return null;

  const root = document.createElement("div");
  root.className = "aibot-placeholder";
  root.dataset.postKey = postKey;
  // Set on the panel rather than on <html>: this stylesheet is injected into
  // somebody else's document, and a custom property on <html> would be visible
  // to, and could collide with, the host site's own styles.
  root.style.setProperty(FONT_SCALE_CSS_VARIABLE, String(fontScaleFactor(fontScale)));
  // The panel is focusable so Escape and the buttons are reachable, and it is a
  // named landmark so a screen reader user can jump between flagged posts.
  root.setAttribute("tabindex", "-1");

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
  panel.setAttribute("aria-label", t("placeholderPanelLabel", [BRAND]));

  const icon = document.createElement("div");
  icon.className = "aibot-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "⚠";

  const heading = document.createElement("h3");
  heading.className = "aibot-heading";
  heading.textContent = reason || t("placeholderHeading");

  const brand = document.createElement("p");
  brand.className = "aibot-brand";
  brand.textContent = t("placeholderBrandLine", [BRAND]);

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
  ai.textContent = t("placeholderScoreAi", [String(Math.round(aiScore * 100))]);
  const news = document.createElement("span");
  news.textContent = t("placeholderScoreNews", [String(Math.round(newsScore * 100))]);
  scores.append(ai, news);
  panel.append(scores);

  // Explanation detail view (#79): expandable reasoning / evidence /
  // uncertainties. Built via textContent + safeUrl only, so model output can
  // never become markup. Omitted when the backend supplied nothing beyond the
  // summary explanation.
  const reasoning_chain =
    Array.isArray(reasoningSnake) && reasoningSnake.length > 0
      ? reasoningSnake
      : reasoningCamel;
  const details = buildExplanationDetails({
    verdict,
    confidence,
    explanation,
    reasoning_chain,
    evidence,
    uncertainties,
    // Claim-level scores (#86). Empty unless the backend started returning
    // them; the detail view omits the section entirely in that case.
    claim_scores:
      Array.isArray(claimScoresSnake) && claimScoresSnake.length > 0
        ? claimScoresSnake
        : claimScoresCamel,
    aiScore,
    newsScore,
  });
  if (details) panel.append(details);

  const actions = document.createElement("div");
  actions.className = "aibot-actions";

  const showButton = document.createElement("button");
  showButton.type = "button";
  showButton.className = "aibot-show-btn";
  showButton.textContent = t("placeholderShowAnyway");
  actions.append(showButton);

  const reportButton = document.createElement("button");
  reportButton.type = "button";
  reportButton.className = "aibot-report-fp";
  reportButton.textContent = reported
    ? t("placeholderReported")
    : t("placeholderReportMistake");
  if (reported) {
    reportButton.disabled = true;
    // A disabled button is skipped by Tab and announced as dimmed, which loses
    // the explanation. aria-disabled keeps it focusable and legible while the
    // `disabled` property keeps it un-clickable.
    reportButton.setAttribute("aria-disabled", "true");
  }
  actions.append(reportButton);

  panel.append(actions);
  backdrop.append(panel);
  root.append(backdrop);

  return root;
}

/** Shown on a report control once the user has used it. */
const REPORTED_LABEL = "Reported";

/** Class of the report control attached to a post that was *not* flagged. */
export const REPORT_CONTROL_CLASS = "aibot-report-fn";

/**
 * Attach a "Report misinformation" control to a post the extension let through.
 *
 * This is the other direction of the feedback loop. The placeholder offers
 * "Report mistake" for a post that was hidden, but a post that scored below
 * both thresholds was shown silently and the user had no way to say the
 * extension missed it. Without this, only false positives could ever be
 * reported and any dataset built from these reports would be biased towards
 * "the model over-flags".
 *
 * The control is deliberately small and appended to the post rather than
 * replacing anything: the post itself is untouched and still fully readable.
 *
 * Idempotent. reapplyAll re-runs on every settings change, and a second mount
 * would stack duplicate controls on the post.
 *
 * @param {Element} element the post element
 * @param {string} postKey
 * @param {{onReport?: () => void, reported?: boolean}} [handlers]
 * @returns {HTMLElement|null} the control, or null when the element is gone
 */
export function mountReportControl(element, postKey, handlers = {}) {
  if (!element || !element.isConnected || !postKey) return null;

  const existing = element.querySelector(`.${REPORT_CONTROL_CLASS}`);
  if (existing) return existing;

  const control = document.createElement("div");
  control.className = REPORT_CONTROL_CLASS;
  // Keyed by post key so a re-render cannot orphan the listener.
  control.dataset.postKey = postKey;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "aibot-report-fn-btn";
  button.textContent = handlers.reported ? REPORTED_LABEL : "Report misinformation";
  if (handlers.reported) button.disabled = true;
  control.append(button);

  if (handlers.onReport) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      handlers.onReport();
    });
  }

  element.append(control);
  return control;
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
  --aibot-font-scale: 1;
  position: relative;
  overflow: hidden;
  border-radius: 8px;
  margin: 8px 0;
  min-height: 220px;
  background: #14161a;
  border: 1px solid #2b3038;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
/* Focusable container: needs a ring when reached by keyboard, including via
   the content script's programmatic .focus() after a hide. */
.aibot-placeholder:focus-visible,
.aibot-placeholder:focus { outline: 3px solid #4dabf7; outline-offset: -3px; }
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
.aibot-placeholder .aibot-icon { font-size: calc(40px * var(--aibot-font-scale)); line-height: 1; margin-bottom: 8px; }
.aibot-placeholder .aibot-heading { font-size: calc(18px * var(--aibot-font-scale)); font-weight: 650; margin: 0 0 4px; }
.aibot-placeholder .aibot-brand { font-size: calc(13px * var(--aibot-font-scale)); color: #9aa3af; margin: 0 0 10px; }
.aibot-placeholder .aibot-explanation { font-size: calc(14px * var(--aibot-font-scale)); color: #cbd2dc; margin: 0 0 10px; line-height: 1.45; }
.aibot-placeholder .aibot-scores {
  display: flex; gap: 14px; justify-content: center;
  font-size: calc(12px * var(--aibot-font-scale)); color: #9aa3af; margin-bottom: 12px; flex-wrap: wrap;
}
.aibot-placeholder .aibot-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.aibot-placeholder .aibot-details { margin: 4px 0 12px; text-align: left; font-size: 13px; }
.aibot-placeholder .aibot-details-toggle { cursor: pointer; color: #4dabf7; font-weight: 600; font-size: 13px; }
.aibot-placeholder .aibot-details-body { margin-top: 8px; color: #cbd2dc; }
.aibot-placeholder .aibot-verdict { font-size: 13px; font-weight: 600; margin: 0 0 8px; color: #e6e8ec; }
.aibot-placeholder .aibot-details-heading { font-size: 13px; font-weight: 650; margin: 10px 0 4px; color: #e6e8ec; }
.aibot-placeholder .aibot-reasoning, .aibot-placeholder .aibot-evidence, .aibot-placeholder .aibot-uncertainties { margin: 0 0 8px 18px; padding: 0; line-height: 1.45; }
.aibot-placeholder .aibot-evidence-item { margin-bottom: 4px; overflow-wrap: anywhere; }
.aibot-placeholder .aibot-evidence-item a { color: #4dabf7; }
.aibot-placeholder .aibot-evidence-meta { color: #9aa3af; }
.aibot-placeholder .aibot-evidence-summary { color: #9aa3af; }
.aibot-placeholder .aibot-claims-list { margin: 0 0 8px 18px; padding: 0; line-height: 1.45; }
.aibot-placeholder .aibot-claim-item { margin-bottom: 5px; overflow-wrap: anywhere; }
.aibot-placeholder .aibot-claim-item a { color: #4dabf7; }
.aibot-placeholder .aibot-claim-score { color: #e6e8ec; font-weight: 600; }
.aibot-placeholder .aibot-claims-note { margin: 0 0 6px; color: #9aa3af; font-size: 12px; }
.aibot-placeholder .aibot-progress { text-align: center; color: #cbd2dc; }
.aibot-placeholder .aibot-progress-heading { font-size: 15px; font-weight: 600; margin: 0 0 10px; }
.aibot-placeholder .aibot-progress-list { list-style: none; margin: 0 auto 12px; padding: 0; text-align: left; display: inline-block; font-size: 13px; }
.aibot-placeholder .aibot-progress-item { display: flex; gap: 8px; align-items: baseline; margin-bottom: 4px; color: #9aa3af; }
.aibot-placeholder .aibot-progress-active { color: #e6e8ec; }
.aibot-placeholder .aibot-progress-complete { color: #cbd2dc; }
.aibot-placeholder .aibot-progress-marker { width: 1em; text-align: center; }
.aibot-placeholder .aibot-progress-error { font-size: 13px; color: #ff8787; margin: 0 0 10px; }
.aibot-placeholder .aibot-progress-cancel {
  font: inherit; font-size: 12px; cursor: pointer;
  border-radius: 999px; padding: 5px 12px; border: 1px solid #3b414b;
  background: transparent; color: #9aa3af;
}
.aibot-placeholder .aibot-progress-cancel:hover { background: #22262d; color: #e6e8ec; }
.aibot-placeholder button {
  font: inherit; font-size: calc(13px * var(--aibot-font-scale)); font-weight: 600; cursor: pointer;
  border-radius: 999px; min-height: 24px; padding: 8px 16px; border: 1px solid #3b414b;
  background: #22262d; color: #e6e8ec;
}
.aibot-placeholder button:hover:not(:disabled) { background: #2b313a; }
.aibot-placeholder button:disabled { opacity: 0.6; cursor: default; }
.aibot-placeholder button:focus-visible { outline: 3px solid #4dabf7; outline-offset: 2px; }
.aibot-placeholder .aibot-show-btn { border-color: #4dabf7; color: #4dabf7; }
.aibot-placeholder.aibot-blur img,
.aibot-placeholder.aibot-blur video { filter: blur(28px); }

/* Off-screen but present in the accessibility tree. display:none or
   visibility:hidden would drop the live region out of the tree entirely, and
   the announcement would never be made. */
.aibot-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .aibot-placeholder, .aibot-placeholder * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
.aibot-report-fn {
  display: flex;
  justify-content: flex-end;
  margin: 4px 0 0;
  padding: 4px 2px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.aibot-report-fn button {
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  color: #9aa3af;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 3px 10px;
  /* Quiet by default: the post is not hidden, so this must not read as an
     alarm sitting under ordinary content. */
  opacity: 0.55;
  transition: opacity 120ms ease-in-out;
}
.aibot-report-fn button:hover:not(:disabled),
.aibot-report-fn button:focus-visible { opacity: 1; border-color: #3b414b; }
.aibot-report-fn button:disabled { cursor: default; opacity: 0.55; }
`;

/**
 * Build the placeholder and attach its listeners, in one call.
 *
 * Listeners are attached to the node this call just created, so a second mount
 * cannot double-bind. Handing callers a bare node and letting them wire it is
 * how the same listener ended up bound twice in the previous design.
 *
 * Focus is moved into the panel only when the caller says the user was already
 * interacting with the post being replaced (`hadFocus`). Moving focus on every
 * hide would interrupt a screen reader user several times per scroll, and
 * moving it when the post was never focused is the definition of a focus
 * steal.
 *
 * Escape is bound to the panel rather than to `document`, so a keystroke aimed
 * at the host site is not swallowed and two panels cannot both fire.
 *
 * @param {Parameters<typeof buildPlaceholder>[0]} params
 * @param {{onReveal?: () => void, onReport?: () => void, hadFocus?: boolean}} [handlers]
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

  if (handlers.onReveal) {
    onEscape(placeholder, () => handlers.onReveal());
  }

  if (handlers.hadFocus) {
    focusFirstIn(placeholder);
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
