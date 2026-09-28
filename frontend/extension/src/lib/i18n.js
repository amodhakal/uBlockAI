/**
 * Localization.
 *
 * Chrome extensions are localized through `chrome.i18n.getMessage`, which reads
 * `_locales/<locale>/messages.json`. Every user-visible string in the popup,
 * the options page and the in-page warning now goes through it.
 *
 * Two things make this safe to roll out incrementally:
 *
 *  1. English stays the working language. `manifest.json` declares
 *     `"default_locale": "en"`, so Chrome resolves the `en` catalogue for every
 *     locale in the world, including ones we have no translation for. A user on
 *     a Korean Chrome sees English, exactly as before this change, rather than
 *     a blank or a raw message key.
 *
 *  2. A message that does not resolve is not allowed to reach the screen.
 *     `t()` falls back to `FALLBACK` and then to the key, and `applyTranslations`
 *     only overwrites text that already exists in the markup, so a typo in a
 *     message name degrades to the English that is still in the HTML instead of
 *     rendering "popupThresholdAi" to a user.
 *
 * FALLBACK mirrors the handful of strings that are *composed* in JavaScript
 * (score readouts, error messages), where there is no markup to fall back to.
 * The HTML-declared strings deliberately keep their English inline. The parity
 * test in i18n.test.js fails if FALLBACK and _locales/en/messages.json drift.
 */

const FALLBACK = Object.freeze({
  placeholderPanelLabel: "Content hidden by $BRAND$ as possible misinformation",
  placeholderHeading: "Flagged as possible misinformation",
  placeholderBrandLine: "Hidden by $BRAND$",
  placeholderScoreAi: "AI-generated risk: $PERCENT$%",
  placeholderScoreNews: "Misinformation risk: $PERCENT$%",
  placeholderShowAnyway: "Show post anyway",
  placeholderReportMistake: "Report mistake",
  placeholderReported: "Reported",
  placeholderCloseDetail: "Close details",
  placeholderDetailLabel: "Details about why $BRAND$ hid this post",
  placeholderShownLive: "$BRAND$ showed this post again at your request.",
});

/** Attributes `applyTranslations` writes, mapped from their data- attribute. */
const I18N_ATTRIBUTES = Object.freeze({
  "data-i18n-aria-label": "aria-label",
  "data-i18n-placeholder": "placeholder",
  "data-i18n-title": "title",
});

/** @returns {object|undefined} the chrome.i18n namespace, if there is one. */
function i18nApi() {
  return typeof chrome === "undefined" ? undefined : chrome.i18n;
}

/**
 * Declaration order of placeholders per message name.
 *
 * Chrome's `content: "$1"` form means "take substitution N", so the mapping from
 * placeholder name to substitution index is exactly the order the names were
 * declared. Recording it here keeps the FALLBACK path faithful without pulling
 * a JSON import into the extension.
 */
const FALLBACK_PLACEHOLDER_ORDER = Object.freeze({
  placeholderPanelLabel: ["BRAND"],
  placeholderBrandLine: ["BRAND"],
  placeholderScoreAi: ["PERCENT"],
  placeholderScoreNews: ["PERCENT"],
  placeholderCloseDetail: [],
  placeholderDetailLabel: ["BRAND"],
  placeholderShownLive: ["BRAND"],
});

/**
 * Substitute `$NAME$` placeholders, case-insensitively, as Chrome does.
 *
 * Only used for the FALLBACK path. When chrome.i18n is present it has already
 * done this substitution itself.
 *
 * @param {string} template
 * @param {string[]} [placeholderNames] declaration order, from FALLBACK_PLACEHOLDERS
 * @param {Array<string|number>} [substitutions]
 * @returns {string}
 */
export function interpolate(template, placeholderNames, substitutions) {
  if (!placeholderNames || !substitutions || substitutions.length === 0) return template;
  const lowered = placeholderNames.map((name) => String(name).toLowerCase());
  return template.replace(/\$([A-Za-z0-9_]+)\$/g, (match, name) => {
    // Chrome's `content: "$1"` form means "take substitution N", so the
    // mapping from placeholder name to substitution index is the order the
    // names were declared.
    const position = lowered.indexOf(String(name).toLowerCase());
    if (position === -1) return match;
    const value = substitutions[position];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * Resolve a message name.
 *
 * @param {string} key message name from _locales/<locale>/messages.json
 * @param {Array<string|number>} [substitutions]
 * @returns {string} the localized string, the English fallback, or the key
 */
export function t(key, substitutions) {
  const api = i18nApi();
  if (api && typeof api.getMessage === "function") {
    const resolved = api.getMessage(key, substitutions);
    if (resolved) return resolved;
  }
  const fallback = FALLBACK[key];
  if (!fallback) return key;
  return interpolate(fallback, FALLBACK_PLACEHOLDERS[key], substitutions);
}

/**
 * Write every `data-i18n*` declaration in a subtree into the DOM.
 *
 * Safe to call before translations exist: a key that does not resolve leaves
 * the element's existing English text alone.
 *
 * @param {ParentNode} [root]
 * @returns {number} how many elements were changed
 */
export function applyTranslations(root) {
  const scope = root || (typeof document === "undefined" ? null : document);
  if (!scope) return 0;
  let changed = 0;

  for (const node of scope.querySelectorAll("[data-i18n]")) {
    const resolved = t(node.getAttribute("data-i18n"));
    // Only overwrite when the key resolved to something. An unresolved key
    // would otherwise replace working English with its own name.
    if (resolved && resolved !== node.getAttribute("data-i18n")) {
      node.textContent = resolved;
      changed += 1;
    }
  }

  for (const [dataAttr, attribute] of Object.entries(I18N_ATTRIBUTES)) {
    for (const node of scope.querySelectorAll(`[${dataAttr}]`)) {
      const resolved = t(node.getAttribute(dataAttr));
      if (!resolved || resolved === node.getAttribute(dataAttr)) continue;
      node.setAttribute(attribute, resolved);
      changed += 1;
    }
  }

  return changed;
}

/**
 * Point `<html lang>` at the UI language, so screen readers use the right voice
 * and the browser translates relative dates correctly.
 *
 * @returns {string} the language tag that was applied
 */
export function setDocumentLocale() {
  const api = i18nApi();
  const tag = api && typeof api.getUILanguage === "function" ? api.getUILanguage() : "en";
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("lang", tag || "en");
  }
  return tag || "en";
}

/** Exposed for the parity test only. */
export const FALLBACK_MESSAGES = FALLBACK;

/** Exposed for the parity test only. */
export const FALLBACK_PLACEHOLDERS = FALLBACK_PLACEHOLDER_ORDER;
