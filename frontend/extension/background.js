/**
 * Service worker: owns all network access.
 *
 * The backend URL is still a constant here; making it configurable is handled
 * separately so the module split and the configuration change stay separable.
 */

import { REQUEST_TIMEOUT_MS } from "./src/lib/defaults.js";

const BRAND = "uBlockAI";
const BACKEND_URL = "https://hack-ncstate-2026.onrender.com";

/**
 * POST JSON to the backend with a hard timeout.
 *
 * The AbortController is required, not decorative: a request the server accepts
 * and then never answers otherwise hangs the worker indefinitely.
 *
 * @param {string} path
 * @param {object} body
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
async function postJson(path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.status === 429) {
      throw new Error("Rate limited by the analysis backend. Try again shortly.");
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
      20_000,
    );
    await chrome.storage.local.set({ falsePositiveReports: [] });
  } catch (error) {
    // Keep the queue for the next attempt rather than dropping user reports.
    console.warn(`[${BRAND}] feedback upload deferred: ${error?.message || error}`);
  }
}

chrome.alarms?.create("flushFeedback", { periodInMinutes: 15 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "flushFeedback") void flushFeedback();
});
