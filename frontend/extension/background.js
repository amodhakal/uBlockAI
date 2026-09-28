/**
 * Service worker: owns all network access.
 *
 * The backend URL and API key are read from storage per request rather than
 * captured at module scope: a service worker is torn down after roughly 30
 * seconds idle, so a module-level constant can be arbitrarily stale relative to
 * a settings change.
 */

import { REQUEST_TIMEOUT_MS } from "./src/lib/defaults.js";
import {
  DEFAULT_BACKEND_URL,
  loadSettings,
  normalizeBackendUrl,
  writeLocal,
} from "./src/lib/settings.js";

const BRAND = "uBlockAI";

/**
 * Resolve the backend base URL from storage.
 *
 * This was a hardcoded constant, so a self-hosted deployment was impossible
 * without editing and rebuilding the extension.
 *
 * @returns {Promise<string>}
 */
async function resolveBackendUrl() {
  try {
    const stored = await chrome.storage.sync.get(["backendUrl"]);
    return normalizeBackendUrl(stored?.backendUrl);
  } catch {
    return DEFAULT_BACKEND_URL;
  }
}

/**
 * POST JSON to the backend with a hard timeout.
 *
 * The AbortController is required, not decorative: a request the server accepts
 * and then never answers otherwise hangs the worker indefinitely.
 *
 * @param {string} path
 * @param {object} body
 * @param {{baseUrl?: string, apiKey?: string, timeoutMs?: number}} [options]
 * @returns {Promise<any>}
 */
async function postJson(path, body, options = {}) {
  const baseUrl = options.baseUrl
    ? normalizeBackendUrl(options.baseUrl)
    : await resolveBackendUrl();
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const headers = { "Content-Type": "application/json" };
  // The key is collected in the options page and stored in local storage
  // rather than sync, because Chrome sync is not end-to-end encrypted.
  if (options.apiKey) headers["X-API-Key"] = options.apiKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.status === 429) {
      // Honour Retry-After so a rate-limited client backs off for as long as
      // the server asked, instead of retrying immediately and extending the
      // penalty.
      const retryAfter = Number(response.headers.get("Retry-After"));
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0 ? ` Retry in ${retryAfter}s.` : "";
      throw new Error(`Rate limited by the analysis backend.${wait}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Backend ${response.status}: ${text.slice(0, 200)}`);
    }
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request to ${path} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "ANALYZE_POST") {
    postJson("/api/analyze_claims", msg.payload, msg.timeoutMs)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) }),
      );
    return true;
  }

  if (msg?.type === "UPLOAD_REPORTS") {
    const reports = Array.isArray(msg.reports) ? msg.reports : [];
    if (reports.length === 0) {
      sendResponse({ ok: true, result: { uploaded: 0 } });
      return true;
    }
    postJson("/api/feedback", { reports }, 20_000)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) }),
      );
    return true;
  }

  return false;
});

/** Periodically drain the local feedback queue. */
async function flushFeedback() {
  try {
    const data = await chrome.storage.local.get(["falsePositiveReports"]);
    const queue = data.falsePositiveReports;
    if (!Array.isArray(queue) || queue.length === 0) return;

    const settings = await loadSettings();
    await postJson(
      "/api/feedback",
      {
        reports: queue.map((entry) => ({
          type: entry.type,
          imageUrl: entry.imageUrl,
          caption: entry.caption,
          timestamp: entry.timestamp,
          post_key: entry.postKey,
        })),
      },
      { baseUrl: settings.backendUrl, apiKey: settings.apiKey, timeoutMs: 20_000 },
    );
    await writeLocal({ falsePositiveReports: [] });
  } catch (error) {
    // Keep the queue for the next attempt rather than dropping user reports.
    console.warn(`[${BRAND}] feedback upload deferred: ${error?.message || error}`);
  }
}

chrome.alarms?.create("flushFeedback", { periodInMinutes: 15 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "flushFeedback") void flushFeedback();
});
