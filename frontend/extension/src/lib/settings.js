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
  HIDING_ACTIONS,
  STORAGE_KEYS,
} from "./defaults.js";

/**
 * @typedef {object} Settings
 * @property {number} aiGeneratedThreshold
 * @property {number} newsThreshold
 * @property {string} hidingAction
 * @property {string} backendUrl
 * @property {string} apiKey
 * @property {boolean} telemetryEnabled
 * @property {string[]} trustedKeys
 */

/** The hosted default. Overridable from the options page for self-hosting. */
export const DEFAULT_BACKEND_URL = "https://hack-ncstate-2026.onrender.com";

/** Normalize a backend URL, rejecting anything that is not http(s). */
export function normalizeBackendUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return DEFAULT_BACKEND_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_BACKEND_URL;
    return url.origin.replace(/\/+$/, "");
  } catch {
    return DEFAULT_BACKEND_URL;
  }
}

/**
 * Read a subset of chrome.storage.sync, promisified.
 * @param {string[]} keys
 * @returns {Promise<Record<string, unknown>>}
 */
export function readSync(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(keys, (data) => resolve(data || {}));
    } catch {
      resolve({});
    }
  });
}

/**
 * Write to chrome.storage.sync, promisified, and surface quota failures.
 *
 * The previous writes ignored the callback entirely. When a write exceeded
 * the 8 KB per-item cap it failed silently, so the extension believed it had
 * remembered which posts it had hidden and then forgot them on reload.
 *
 * @param {Record<string, unknown>} items
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export function writeSync(items) {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.set(items, () => {
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

/**
 * @returns {Promise<Settings>}
 */
export async function loadSettings() {
  const data = await readSync([
    STORAGE_KEYS.aiGeneratedThreshold,
    STORAGE_KEYS.newsThreshold,
    STORAGE_KEYS.hidingAction,
    STORAGE_KEYS.backendUrl,
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.telemetryEnabled,
    STORAGE_KEYS.trustedKeys,
  ]);

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
      typeof data[STORAGE_KEYS.apiKey] === "string" ? data[STORAGE_KEYS.apiKey] : "",
    telemetryEnabled: data[STORAGE_KEYS.telemetryEnabled] === true,
    trustedKeys: Array.isArray(data[STORAGE_KEYS.trustedKeys])
      ? data[STORAGE_KEYS.trustedKeys]
      : [],
  };
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
