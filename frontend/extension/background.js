/**
 * Service worker: owns all network access.
 *
 * The backend URL and API key are read from storage per request rather than
 * captured at module scope: a service worker is torn down after roughly 30
 * seconds idle, so a module-level constant can be arbitrarily stale relative to
 * a settings change.
 */

import {
  FEEDBACK_INTERVAL_MINUTES,
  REQUEST_TIMEOUT_MS,
  STORAGE_KEYS,
  TELEMETRY_INTERVAL_MINUTES,
} from "./src/lib/defaults.js";
import { REPORT_KIND_LIST, bucketFor } from "./src/lib/feedback.js";
import { logDebug, logError, setDebug } from "./src/lib/logging.js";
import { isStreamResponse, parseSSE } from "./src/lib/progress.js";
import {
  DEFAULT_BACKEND_URL,
  STORAGE_AREAS,
  loadSettings,
  normalizeBackendUrl,
  readSync,
  writeSync,
} from "./src/lib/settings.js";
import {
  TELEMETRY_PATH,
  buildTelemetryEvent,
  hasAnythingToSend,
  resetPendingCounts,
} from "./src/lib/telemetry.js";

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
      const error = new Error(`Backend ${response.status}: ${text.slice(0, 200)}`);
      // The status travels with the error so callers can distinguish "the
      // server said no" from "the request never arrived", which decide very
      // different follow-ups.
      error.status = response.status;
      throw error;
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

/**
 * POST a streaming (SSE) analysis request and relay each event to `onEvent`.
 *
 * Why this lives in the service worker: a content script cannot read a
 * cross-origin response body, and only the worker holds the API key. So the
 * worker owns the stream and forwards parsed events over a Port.
 *
 * Degradation is deliberate and tested. If the backend has no stream endpoint
 * (404), or something in the middle returns HTML instead, or the body is not a
 * readable stream at all, this resolves with `{ streamed: false }` and the
 * caller falls back to the plain JSON request. The failure is surfaced as a
 * boolean rather than an exception because "no stream available" is an
 * expected state, not an error.
 *
 * @param {object} body analyze payload
 * @param {{timeoutMs?: number, onEvent: (event: object) => void, signal?: AbortSignal}} options
 * @returns {Promise<{streamed: boolean, result?: object, error?: string}>}
 */
async function postStream(path, body, options) {
  const baseUrl = await resolveBackendUrl();
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const onEvent = options.onEvent;

  const headers = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (options.apiKey) headers["X-API-Key"] = options.apiKey;

  // The caller's signal (a cancelled analysis) and the timeout share one
  // controller: either one has to be able to stop the request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onExternalAbort);
  }

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!isStreamResponse(response)) {
      // Not a stream. Drain so the connection can be reused, then report it.
      await response.body?.cancel?.().catch(() => {});
      return { streamed: false };
    }
    if (!response.body) return { streamed: false };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let remainder = "";
    let result;
    let error;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const { events, remainder: rest } = parseSSE(
        remainder + decoder.decode(value, { stream: true }),
      );
      remainder = rest;
      for (const event of events) {
        onEvent(event);
        if (event.stage === "done") result = event.result;
        if (event.stage === "error") error = event.message;
      }
    }

    if (error) return { streamed: true, error };
    if (!result) {
      // The stream ended without a terminal event: the worker was torn down or
      // the connection dropped. Not a fallback case, the analysis never
      // finished.
      return { streamed: true, error: "The analysis stream ended unexpectedly." };
    }
    return { streamed: true, result };
  } catch (error) {
    if (error?.name === "AbortError") {
      // A cancel is a normal outcome, not a failure to report as an error
      // string the user will read.
      return { streamed: true, aborted: true };
    }
    logDebug("stream", `streaming unavailable: ${error?.message}`);
    return { streamed: false, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "ANALYZE_POST") {
    // The third argument is the options object, not a bare timeout: passing
    // msg.timeoutMs there left options.apiKey undefined, so this fallback sent
    // no X-API-Key and a secured backend answered 401.
    postJson("/api/analyze_claims", msg.payload, { timeoutMs: msg.timeoutMs })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) }),
      );
    return true;
  }

  return false;
});

/**
 * Long-lived channel for a streaming analysis (#83).
 *
 * `chrome.runtime.sendMessage` cannot be used for this: it is a single
 * request/response, and progress arrives many times over 20-60 seconds. A Port
 * is bidirectional and long-lived, which is what a stream needs.
 *
 * The content script sends `{type: "analyze"}` and then receives
 * `{type: "progress"}` messages until exactly one of
 * `{type: "result"} | {type: "error"}` arrives. Disconnecting the port
 * aborts the request, which is how the "Stop analysis" button cancels.
 *
 * @type {Set<AbortController>} in-flight streams, so a disconnect can abort
 */
const activeStreams = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "aibot-analysis") return;

  let controller = null;

  port.onDisconnect.addListener(() => {
    // The user closed the tab or the page navigated away. Abort rather than
    // let a paid analysis keep running to a result nobody will read.
    controller?.abort();
    if (controller) activeStreams.delete(controller);
  });

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "analyze") return;
    if (controller) return; // already running for this port

    controller = new AbortController();
    activeStreams.add(controller);

    let result = null;
    let error = null;
    let aborted = false;

    try {
      const settings = await loadSettings();
      const streamed = await postStream("/api/analyze_claims/stream", msg.payload, {
        apiKey: settings.apiKey,
        timeoutMs: msg.timeoutMs,
        signal: controller.signal,
        onEvent: (event) => {
          if (event?.stage === "error") {
            error = String(event.message || "Analysis failed.");
            return;
          }
          if (event?.stage === "done") {
            result = event.result;
            return;
          }
          // A real stage from the backend. Relayed verbatim; the content
          // script decides what to render and never invents a stage.
          safePost(port, { type: "progress", event });
        },
      });

      if (streamed.aborted) {
        aborted = true;
      } else if (streamed.streamed) {
        if (error) throw new Error(error);
        if (result) safePost(port, { type: "result", result });
        else throw new Error("The analysis stream ended unexpectedly.");
      } else {
        // No stream available on this backend. Fall back to the request the
        // extension has always made, and say so, so the content script can
        // show "waiting" rather than stage names that are not coming.
        safePost(port, { type: "progress", event: { stage: "received" } });
        result = await postJson("/api/analyze_claims", msg.payload, {
          apiKey: settings.apiKey,
          timeoutMs: msg.timeoutMs,
        });
        safePost(port, { type: "result", result });
      }
    } catch (err) {
      if (!aborted && err?.name !== "AbortError") {
        safePost(port, { type: "error", error: String(err?.message || err) });
      }
    } finally {
      if (controller) activeStreams.delete(controller);
      controller = null;
    }
  });
});

/**
 * Post to a port that may have gone away.
 *
 * A content script whose tab is closing will throw on postMessage. That is
 * expected during teardown and must not take down the worker.
 */
function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // Port already closed.
  }
}

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

/**
 * Whether this backend has already been found not to accept telemetry.
 *
 * Recorded locally rather than inferred, so the check costs nothing on the
 * common path and the user is not left with a permanently failing request.
 *
 * @returns {Promise<boolean>}
 */
async function isTelemetryUnsupported() {
  const data = await readSync([STORAGE_KEYS.telemetryUnsupported], STORAGE_AREAS.LOCAL);
  return data[STORAGE_KEYS.telemetryUnsupported] === true;
}

/**
 * Upload a batch of aggregate counts.
 *
 * Counts only, and only when the user has opted in. The event is built by
 * lib/telemetry.js, which returns null while telemetry is off, so there is no
 * network call at all in that case rather than a call that happens to send
 * nothing.
 *
 * A 404 means this backend does not implement the endpoint. That is not a
 * transient fault, so it is remembered and the batch is not retried on every
 * alarm: a user who opted in against a self-hosted backend that has not
 * implemented telemetry would otherwise generate a failed request an hour for
 * ever. The counters keep accruing locally and the popup keeps showing them.
 *
 * @returns {Promise<boolean>} whether a batch was uploaded
 */
async function flushTelemetry() {
  const data = await readSync([
    STORAGE_KEYS.telemetryEnabled,
    STORAGE_KEYS.telemetryCounts,
  ]);
  if (data[STORAGE_KEYS.telemetryEnabled] !== true) return false;
  if (await isTelemetryUnsupported()) return false;

  const event = buildTelemetryEvent(true, data[STORAGE_KEYS.telemetryCounts]);
  // Nothing has happened since the last batch. Uploading a row of zeroes would
  // tell the backend the extension is installed and doing nothing.
  if (!hasAnythingToSend(event)) return false;

  const settings = await loadSettings();
  try {
    await postJson(TELEMETRY_PATH, event, {
      baseUrl: settings.backendUrl,
      apiKey: settings.apiKey,
      timeoutMs: 20_000,
    });
  } catch (error) {
    if (error?.status === 404) {
      // Not implemented server-side. Stop trying; keep the counts.
      await writeSync({ [STORAGE_KEYS.telemetryUnsupported]: true }, STORAGE_AREAS.LOCAL);
      logError(
        "telemetry",
        "backend does not accept telemetry uploads; uploads disabled",
      );
      return false;
    }
    // Anything else is transient. Counters are left alone so the next alarm
    // retries the same batch.
    throw error;
  }

  // Reset only on success, so a failed batch is retried on the next alarm.
  await resetPendingCounts();
  logDebug("telemetry", "uploaded aggregate counts", event.counts);
  return true;
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
chrome.alarms.create("flushTelemetry", { periodInMinutes: TELEMETRY_INTERVAL_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "flushFeedback") void flushFeedback();
  if (alarm.name === "flushTelemetry") {
    // A telemetry failure must not stop the feedback flush or vice versa.
    void flushTelemetry().catch((error) =>
      logError("telemetry", "upload deferred", { error: error?.message }),
    );
  }
});
