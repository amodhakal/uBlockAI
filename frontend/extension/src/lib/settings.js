/**
 * Storage-backed settings.
 *
 * The content script, the popup and the service worker each read the same
 * values from chrome.storage with slightly different key names and different
 * fallbacks, which is how the first-run default mismatch happened. This module
 * is the only place that knows the key names and the defaults.
 */

import {
  DEFAULT_AI_GENERATED_THRESHOLD,
  DEFAULT_NEWS_THRESHOLD,
  DEFAULT_HIDING_ACTION,
  DEFAULT_FONT_SCALE,
  FONT_SCALE_CSS_VARIABLE,
  FONT_SCALES,
  HIDING_ACTIONS,
  STORAGE_KEYS,
  fontScaleFactor,
} from "./defaults.js";

/**
 * @typedef {object} Settings
 * @property {number} aiGeneratedThreshold
 * @property {number} newsThreshold
 * @property {string} hidingAction
 * @property {string} backendUrl
 * @property {string} apiKey
 * @property {boolean} telemetryEnabled
 * @property {boolean} debugLogging
 * @property {string} fontScale
 * @property {string[]} trustedKeys
 */

/** The hosted default. Overridable from the options page for self-hosting. */
export const DEFAULT_BACKEND_URL = "https://hack-ncstate-2026.onrender.com";

/** Chrome storage areas. `sync` roams and is quota-capped; `local` is not. */
export const STORAGE_AREAS = Object.freeze({ SYNC: "sync", LOCAL: "local" });

/** Loopback hosts are permitted over http, for local development. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Strictly parse a user-supplied backend URL.
 *
 * Separate from normalizeBackendUrl on purpose. normalize returns the default
 * for anything unusable, which is right when *reading* a stored value but
 * catastrophic when *writing* one: a typo in the options field would appear to
 * save successfully and then silently point every request at the hosted
 * backend.
 *
 * A failure carries both an English `error` and an `errorKey`. `error` is what
 * the service worker logs, and it stays in English so a log line is greppable
 * and translatable after the fact. `errorKey` is what the options page renders,
 * through chrome.i18n, so a user never has to read a developer-facing string.
 *
 * @param {string} value
 * @returns {{ok: true, url: string}
 *   | {ok: false, error: string, errorKey: string, errorParams: string[]}}
 */
export function parseBackendUrl(value) {
  const fail = (errorKey, error, ...errorParams) => ({
    ok: false,
    error,
    errorKey,
    errorParams,
  });

  const raw = String(value ?? "").trim();
  if (!raw) {
    return fail("optionsErrorEmptyUrl", "Enter a backend URL.");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail("optionsErrorInvalidUrl", "That is not a valid URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return fail("optionsErrorScheme", "Only http and https URLs are supported.");
  }

  if (url.protocol === "http:") {
    // Chrome will not grant an http host permission for a non-loopback origin,
    // so accepting one here would fail later with an opaque permissions error.
    if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
      return fail(
        "optionsErrorInsecureRemote",
        "http is only allowed for localhost; use https for a remote backend.",
      );
    }
  }

  // Redundant trailing slashes are equivalent to the root, not a sub-path.
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "") {
    return fail("optionsErrorPath", "The backend URL must not include a path.");
  }
  if (url.search || url.hash) {
    return fail(
      "optionsErrorQuery",
      "The backend URL must not include a query or fragment.",
    );
  }

  return { ok: true, url: url.origin };
}

/** Lenient read-path normalisation: anything unusable becomes the default. */
export function normalizeBackendUrl(value) {
  const parsed = parseBackendUrl(value);
  return parsed.ok ? parsed.url : DEFAULT_BACKEND_URL;
}

/**
 * @param {"sync"|"local"} [area]
 * @returns {typeof chrome.storage.sync}
 */
function storage(area = STORAGE_AREAS.SYNC) {
  return chrome.storage[area];
}

/**
 * Read from a storage area, promisified.
 * @param {string[]} keys
 * @param {"sync"|"local"} [area]
 * @returns {Promise<Record<string, unknown>>}
 */
export function readSync(keys, area = STORAGE_AREAS.SYNC) {
  return new Promise((resolve) => {
    try {
      storage(area).get(keys, (data) => resolve(data || {}));
    } catch {
      resolve({});
    }
  });
}

/**
 * Write to a storage area, promisified, and surface quota failures.
 *
 * The previous writes ignored the callback entirely. When a write exceeded
 * the 8 KB per-item cap it failed silently, so the extension believed it had
 * remembered which posts it had hidden and then forgot them on reload.
 *
 * @param {Record<string, unknown>} items
 * @param {"sync"|"local"} [area]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export function writeSync(items, area = STORAGE_AREAS.SYNC) {
  return new Promise((resolve) => {
    try {
      storage(area).set(items, () => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, error: String(lastError.message || lastError) });
          return;
        }
        resolve({ ok: true });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error) });
    }
  });
}

/** @param {string[]} keys */
export function readLocal(keys) {
  return readSync(keys, STORAGE_AREAS.LOCAL);
}

/** @param {Record<string, unknown>} items */
export function writeLocal(items) {
  return writeSync(items, STORAGE_AREAS.LOCAL);
}

/**
 * @returns {Promise<Settings>}
 */
export async function loadSettings() {
  const data = await readSync([
    STORAGE_KEYS.aiGeneratedThreshold,
    STORAGE_KEYS.newsThreshold,
    STORAGE_KEYS.hidingAction,
    STORAGE_KEYS.backendUrl,
    STORAGE_KEYS.telemetryEnabled,
    STORAGE_KEYS.trustedKeys,
    STORAGE_KEYS.debugLogging,
    STORAGE_KEYS.fontScale,
  ]);
  // The API key is read from local storage, never sync: Chrome sync is not
  // end-to-end encrypted, so a bearer token there would be uploaded to the
  // user's Google account in cleartext.
  const local = await readLocal([STORAGE_KEYS.apiKey]);

  const action = data[STORAGE_KEYS.hidingAction];

  return {
    aiGeneratedThreshold: numberOr(
      data[STORAGE_KEYS.aiGeneratedThreshold],
      DEFAULT_AI_GENERATED_THRESHOLD,
    ),
    newsThreshold: numberOr(data[STORAGE_KEYS.newsThreshold], DEFAULT_NEWS_THRESHOLD),
    hidingAction: Object.values(HIDING_ACTIONS).includes(action)
      ? action
      : DEFAULT_HIDING_ACTION,
    backendUrl: normalizeBackendUrl(data[STORAGE_KEYS.backendUrl]),
    apiKey:
      typeof local[STORAGE_KEYS.apiKey] === "string" ? local[STORAGE_KEYS.apiKey] : "",
    telemetryEnabled: data[STORAGE_KEYS.telemetryEnabled] === true,
    debugLogging: data[STORAGE_KEYS.debugLogging] === true,
    fontScale: Object.values(FONT_SCALES).includes(data[STORAGE_KEYS.fontScale])
      ? data[STORAGE_KEYS.fontScale]
      : DEFAULT_FONT_SCALE,
    trustedKeys: Array.isArray(data[STORAGE_KEYS.trustedKeys])
      ? data[STORAGE_KEYS.trustedKeys]
      : [],
  };
}

/**
 * Publish the text-size setting as a CSS custom property.
 *
 * One property, read by the popup stylesheet, the options stylesheet and the
 * in-page warning stylesheet, so the three cannot drift apart.
 *
 * @param {string} scale a FONT_SCALES value
 * @param {HTMLElement} [root] defaults to <html>
 * @returns {number} the multiplier that was applied
 */
export function applyFontScale(scale, root) {
  const factor = fontScaleFactor(scale);
  const target =
    root || (typeof document === "undefined" ? null : document.documentElement);
  if (target && target.style && typeof target.style.setProperty === "function") {
    target.style.setProperty(FONT_SCALE_CSS_VARIABLE, String(factor));
  }
  return factor;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 && num <= 1 ? num : fallback;
}

/**
 * Subscribe to settings changes.
 * @param {(settings: Settings) => void} handler
 * @returns {() => void} unsubscribe
 */
export function onSettingsChanged(handler) {
  const listener = () => {
    loadSettings().then(handler);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
