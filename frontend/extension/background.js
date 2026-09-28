/**
 * Service worker: owns all network access.
 *
 * The backend URL and API key are read from storage per request rather than
 * captured at module scope: a service worker is torn down after roughly 30
 * seconds idle, so a module-level constant can be arbitrarily stale relative to
 * a settings change.
 */

import { FEEDBACK_INTERVAL_MINUTES, REQUEST_TIMEOUT_MS } from "./src/lib/defaults.js";
import { REPORT_KIND_LIST, bucketFor } from "./src/lib/feedback.js";
import { logDebug, logError, setDebug } from "./src/lib/logging.js";
import {
  DEFAULT_BACKEND_URL,
  STORAGE_AREAS,
  loadSettings,
  normalizeBackendUrl,
  readSync,
  writeSync,
} from "./src/lib/settings.js";

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

  return false;
});

/**
 * Periodically drain the local feedback queues.
 *
 * Uploads are driven by the alarm below rather than by a message, so the
 * UPLOAD_REPORTS message type that nothing ever sent has been removed.
 */
async function flushFeedback() {
  for (const kind of REPORT_KIND_LIST) {
    try {
      await flushOne(kind);
    } catch (error) {
      // Keep the queue for the next attempt rather than dropping user reports.
      logError("feedback", `upload deferred for ${kind}`, { error: error?.message });
    }
  }
}

async function flushOne(kind) {
  // The queue is stored under the bucket key, not the report kind. Reading by
  // kind found nothing every time, so reports accumulated forever and the
  // feedback loop never actually closed.
  const bucket = bucketFor(kind);
  const data = await readSync([bucket], STORAGE_AREAS.LOCAL);
  const queue = data[bucket];
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
  // Cleared only on success, so a failed upload retries next time.
  await writeSync({ [bucket]: [] }, STORAGE_AREAS.LOCAL);
  logDebug("feedback", `uploaded ${queue.length} ${kind} reports`);
}

// The service worker has no settings module loaded at startup, so read the
// debug flag directly. A service worker is torn down after ~30s idle, so this
// runs on every wake.
chrome.storage.sync
  .get(["debugLogging"])
  .then((data) => setDebug(data?.debugLogging === true))
  .catch(() => {});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "sync" && changes.debugLogging) {
    setDebug(changes.debugLogging.newValue === true);
  }
});

chrome.alarms.create("flushFeedback", { periodInMinutes: FEEDBACK_INTERVAL_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "flushFeedback") void flushFeedback();
});
