/**
 * Streaming analysis progress (#83).
 *
 * A full agent run takes 20-60 seconds. The interface used to render nothing at
 * all for that whole window, so a slow analysis and a dead backend looked
 * identical and the only visible option was to reload and lose the work.
 *
 * The stages here mirror the backend's SSE contract in app/progress.py. Two
 * properties matter and are enforced by the tests:
 *
 * 1. No invented progress. A stage only appears when the backend actually sent
 *    it. Nothing here advances on a timer, so the UI cannot claim the backend
 *    is "searching sources" while it is doing something else entirely. The
 *    one thing shown before any event arrives is an explicit "connecting"
 *    state, which is a statement about the client, not about the server.
 *
 * 2. The backend may skip stages. `searching` and `credibility` are emitted
 *    only when the agent genuinely called those tools, so a run that answers
 *    from the caption alone never emits them. TERMINAL_STAGES and isTerminal
 *    exist so the client treats the list as a set that may have gaps rather
 *    than a checklist that must be completed in order.
 */

/** Stages the backend can emit. Keep in sync with backend/app/progress.py. */
export const STAGES = Object.freeze({
  RECEIVED: "received",
  DECODING: "decoding",
  OCR: "ocr",
  SEARCHING: "searching",
  CREDIBILITY: "credibility",
  VERIFYING: "verifying",
  SYNTHESIS: "synthesis",
  DONE: "done",
  ERROR: "error",
});

/** Presentation order. Conditional stages are commonly absent. */
export const STAGE_ORDER = Object.freeze([
  STAGES.RECEIVED,
  STAGES.DECODING,
  STAGES.OCR,
  STAGES.SEARCHING,
  STAGES.CREDIBILITY,
  STAGES.VERIFYING,
  STAGES.SYNTHESIS,
  STAGES.DONE,
]);

/** Stages that may never arrive: the agent decides whether it needs them. */
export const CONDITIONAL_STAGES = Object.freeze([
  STAGES.SEARCHING,
  STAGES.CREDIBILITY,
  STAGES.VERIFYING,
]);

/** No further events can follow these. */
export const TERMINAL_STAGES = Object.freeze([STAGES.DONE, STAGES.ERROR]);

/** Short labels. These describe what the server said it is doing. */
const STAGE_LABELS = Object.freeze({
  [STAGES.RECEIVED]: "Request received",
  [STAGES.DECODING]: "Reading the post",
  [STAGES.OCR]: "Extracting text from images",
  [STAGES.SEARCHING]: "Searching for sources",
  [STAGES.CREDIBILITY]: "Checking source credibility",
  [STAGES.VERIFYING]: "Verifying numbers",
  [STAGES.SYNTHESIS]: "Weighing the evidence",
  [STAGES.DONE]: "Done",
  [STAGES.ERROR]: "Analysis failed",
});

/** @param {string} stage @returns {string} */
export function stageLabel(stage) {
  return STAGE_LABELS[stage] || String(stage || "");
}

/** @param {string} stage @returns {boolean} */
export function isTerminal(stage) {
  return TERMINAL_STAGES.includes(stage);
}

/** @param {string} stage @returns {boolean} */
export function isConditional(stage) {
  return CONDITIONAL_STAGES.includes(stage);
}

/**
 * The initial state. `connecting` is deliberately separate from `received`: it
 * is the only thing shown before any server event, and it describes the client
 * (request sent, awaiting first byte) rather than pretending to know what the
 * server is doing.
 *
 * @param {number} [now]
 * @returns {{connecting: boolean, seen: string[], current: string|null, error: string, done: boolean, result: object|null, startedAt: number}}
 */
export function initialProgress(now = 0) {
  return {
    connecting: true,
    seen: [],
    current: null,
    error: "",
    done: false,
    result: null,
    startedAt: now,
  };
}

/**
 * Apply one SSE event to the progress state.
 *
 * Unknown stages are recorded in `seen` but do not set `current`, so a newer
 * backend that adds a stage cannot leave the UI looking stuck on it.
 *
 * @param {object} state previous state
 * @param {{stage?: string, message?: string, result?: object}} event
 * @returns {object} a new state; the input is not mutated
 */
export function applyStage(state, event) {
  const next = { ...state, seen: [...state.seen] };
  const stage = event?.stage;

  if (!stage) return next;

  // The first event of any kind proves the connection is live.
  next.connecting = false;

  if (!next.seen.includes(stage)) next.seen.push(stage);

  if (stage === STAGES.ERROR) {
    next.error = String(event?.message || "Analysis failed.");
    next.done = true;
    next.current = null;
    return next;
  }

  if (stage === STAGES.DONE) {
    next.done = true;
    next.current = null;
    next.result = event?.result && typeof event.result === "object" ? event.result : null;
    return next;
  }

  // A late event after a terminal one is ignored: the run is over, and letting
  // it move `current` would restart a finished progress list.
  if (state.done) return next;

  // An unknown stage is recorded but does not become `current`. A newer
  // backend can add a stage this client cannot render, and making it current
  // would leave every earlier row showing as active with nothing marked done.
  if (!STAGE_ORDER.includes(stage)) return next;

  next.current = stage;
  return next;
}

/**
 * Stages for the non-streaming path.
 *
 * When the backend has no stream endpoint the client still has a 20-60 second
 * wait to get through. These are the only labels it may use, and they are all
 * statements about what the client is doing (request sent, waiting for a
 * reply), never about server-side work. That distinction is why this is not
 * just STAGE_ORDER.
 */
export const fallbackStages = Object.freeze([
  { stage: STAGES.RECEIVED, label: "Request sent" },
  { stage: null, label: "Waiting for the analysis backend (this can take a minute)" },
]);

/**
 * Parse a chunk of `text/event-stream` text into events.
 *
 * A hand-rolled parser rather than `EventSource`, because the request is a POST
 * with a JSON body and `EventSource` can only issue GETs. Frames are separated
 * by a blank line; a partial frame at the end of a chunk is returned as
 * `remainder` so the caller can prepend it to the next chunk.
 *
 * @param {string} text
 * @returns {{events: object[], remainder: string}}
 */
export function parseSSE(text) {
  const events = [];
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const frames = normalized.split("\n\n");
  const remainder = frames.pop() || "";

  for (const frame of frames) {
    const event = parseFrame(frame);
    if (event) events.push(event);
  }
  return { events, remainder };
}

/** @param {string} frame @returns {object|null} */
function parseFrame(frame) {
  let stage;
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue; // comment / keepalive
    if (line.startsWith("event:")) {
      stage = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;

  let payload;
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch {
    // A frame the client cannot parse is dropped rather than half-applied.
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  // The event name is authoritative; fall back to the payload's own stage.
  return stage && !payload.stage ? { ...payload, stage } : payload;
}

/**
 * Build the progress panel.
 *
 * Renders only stages the backend actually sent, plus an explicit connecting
 * line while the first byte is outstanding. textContent throughout: stage
 * labels are server strings and must not become markup.
 *
 * @param {object} state progress state from initialProgress/applyStage
 * @param {{postKey?: string, onCancel?: () => void, stages?: object[]}} [options]
 *   `stages` overrides the rendered list, which is how the non-streaming path
 *   shows its own wording through the same renderer.
 * @returns {HTMLElement}
 */
export function buildProgressPanel(state, options = {}) {
  const root = document.createElement("div");
  root.className = "aibot-progress";
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  if (options.postKey) root.dataset.postKey = options.postKey;

  const heading = document.createElement("p");
  heading.className = "aibot-progress-heading";
  heading.textContent = state.error
    ? "Analysis failed"
    : state.done
      ? "Analysis complete"
      : "Checking this post…";
  root.append(heading);

  const list = document.createElement("ol");
  list.className = "aibot-progress-list";

  if (Array.isArray(options.stages)) {
    for (const entry of options.stages) {
      list.append(
        progressRow(entry.label, entry.stage ? "complete" : "pending", true, entry.stage),
      );
    }
  } else {
    if (state.connecting && !state.error) {
      list.append(progressRow("Connecting to the analysis backend…", "pending", true));
    }
    // Only what the server reported, in presentation order. A missing
    // conditional stage is never rendered as a skipped placeholder, because
    // "skipped" is a claim about work that was considered and declined.
    for (const stage of STAGE_ORDER) {
      if (!state.seen.includes(stage)) continue;
      list.append(
        progressRow(
          stageLabel(stage),
          state.current === stage ? "active" : "complete",
          false,
          stage,
        ),
      );
    }
  }

  root.append(list);

  if (state.error) {
    const errNode = document.createElement("p");
    errNode.className = "aibot-progress-error";
    errNode.textContent = state.error;
    root.append(errNode);
  }

  if (!state.done && typeof options.onCancel === "function") {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "aibot-progress-cancel";
    cancel.textContent = "Stop analysis";
    cancel.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      options.onCancel();
    });
    root.append(cancel);
  }

  return root;
}

/**
 * @param {string} label
 * @param {"pending"|"active"|"complete"} status
 * @param {boolean} plain
 * @param {string} [stage]
 * @returns {HTMLElement}
 */
function progressRow(label, status, plain, stage) {
  const row = document.createElement("li");
  row.className = `aibot-progress-item aibot-progress-${status}`;
  if (stage) row.dataset.stage = stage;

  const marker = document.createElement("span");
  marker.className = "aibot-progress-marker";
  marker.setAttribute("aria-hidden", "true");
  // A text marker rather than a spinner: legible without animation, and it
  // respects prefers-reduced-motion for free.
  marker.textContent = status === "complete" ? "✓" : status === "active" ? "…" : "·";

  const text = document.createElement("span");
  text.className = "aibot-progress-label";
  text.textContent = label;

  if (plain) {
    row.classList.add("aibot-progress-pending");
    marker.textContent = "";
  }

  row.append(marker, text);
  return row;
}

/** The endpoint the client posts to for the streaming variant. */
export const STREAM_PATH = "/api/analyze_claims/stream";

/**
 * Whether a response looks like a usable SSE stream.
 *
 * A backend without the streaming endpoint answers 404 with JSON, and a proxy
 * in the way may answer 200 with HTML. Both must fall back rather than be fed
 * to the SSE parser, which would otherwise sit waiting for a stream that will
 * never come and time out 45 seconds later.
 *
 * @param {Response} response
 * @returns {boolean}
 */
export function isStreamResponse(response) {
  if (!response || !response.ok) return false;
  const type = String(response.headers?.get?.("Content-Type") || "");
  return type.toLowerCase().includes("text/event-stream");
}
