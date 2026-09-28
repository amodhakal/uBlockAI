/**
 * Streaming analysis progress (#83).
 *
 * The assertions that matter are the negative ones. A progress UI that can
 * claim the backend is "searching sources" when it is not is worse than no
 * progress UI at all, because it manufactures confidence about work that never
 * happened. So these tests pin that a stage appears only when the backend sent
 * it, that a stage the backend skipped is simply absent rather than shown as
 * "skipped", and that the non-streaming path never borrows server stage names.
 *
 * Uses linkedom so these run in Node. Run with: npm test
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";

import { parseHTML } from "linkedom";

import {
  CONDITIONAL_STAGES,
  STAGES,
  STAGE_ORDER,
  TERMINAL_STAGES,
  applyStage,
  buildProgressPanel,
  fallbackStages,
  initialProgress,
  isConditional,
  isStreamResponse,
  isTerminal,
  parseSSE,
  stageLabel,
} from "./progress.js";

let dom;

before(() => {
  dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  globalThis.document = dom.document;
  globalThis.HTMLElement = dom.HTMLElement;
  globalThis.Node = dom.Node;
});

/** Drive the state machine over a list of stage names. */
function run(stages, events = []) {
  let state = initialProgress();
  for (let i = 0; i < stages.length; i += 1) {
    state = applyStage(state, { stage: stages[i], ...(events[i] || {}) });
  }
  return state;
}

// --------------------------------------------------------------------------
// No invented progress
// --------------------------------------------------------------------------

test("nothing is shown before the first event arrives", () => {
  const state = initialProgress();
  assert.equal(state.connecting, true);
  assert.deepEqual(state.seen, []);
  assert.equal(state.current, null);

  const el = buildProgressPanel(state);
  // The only line is the client-side connecting note, which makes no claim
  // about what the server is doing.
  const rows = el.querySelectorAll("li.aibot-progress-item");
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /Connecting to the analysis backend/);
  for (const stage of STAGE_ORDER) {
    assert.doesNotMatch(el.textContent, new RegExp(stageLabel(stage)));
  }
});

test("a stage is rendered only after the backend sends it", () => {
  const el = buildProgressPanel(run([STAGES.RECEIVED, STAGES.DECODING]));
  const labels = Array.from(el.querySelectorAll(".aibot-progress-label")).map(
    (n) => n.textContent,
  );
  assert.deepEqual(labels, [stageLabel(STAGES.RECEIVED), stageLabel(STAGES.DECODING)]);
  assert.equal(el.querySelector("[data-stage=searching]"), null);
  assert.equal(el.querySelector("[data-stage=synthesis]"), null);
});

test("a stage the backend skipped is absent, not shown as skipped", () => {
  // The agent answered from the caption and never searched.
  const state = run([
    STAGES.RECEIVED,
    STAGES.DECODING,
    STAGES.OCR,
    STAGES.SYNTHESIS,
    STAGES.DONE,
  ]);
  const el = buildProgressPanel(state);
  assert.equal(el.querySelector("[data-stage=searching]"), null);
  assert.equal(el.querySelector("[data-stage=credibility]"), null);
  // And nothing asserts that a search was considered and declined.
  assert.doesNotMatch(el.textContent, /skipped/i);
  assert.doesNotMatch(el.textContent, /not needed/i);
  assert.equal(el.querySelectorAll("li.aibot-progress-item").length, 5);
});

test("every stage the backend does send is rendered", () => {
  const all = [...STAGE_ORDER];
  const el = buildProgressPanel(run(all));
  for (const stage of all) {
    assert.ok(el.querySelector(`[data-stage=${stage}]`), `missing row for ${stage}`);
  }
});

test("only the newest non-terminal stage is marked active", () => {
  const state = run([STAGES.RECEIVED, STAGES.DECODING, STAGES.OCR]);
  const el = buildProgressPanel(state);
  assert.equal(el.querySelectorAll(".aibot-progress-active").length, 1);
  assert.equal(el.querySelector(".aibot-progress-active").dataset.stage, STAGES.OCR);
  // Earlier stages are complete, not active.
  assert.equal(
    el
      .querySelector(`[data-stage=${STAGES.RECEIVED}]`)
      .className.includes("aibot-progress-complete"),
    true,
  );
});

test("a late event after done does not revive the progress list", () => {
  let state = run([STAGES.RECEIVED, STAGES.DONE]);
  assert.equal(state.done, true);
  state = applyStage(state, { stage: STAGES.SEARCHING });
  assert.equal(state.current, null, "a finished run must not go back to a stage");
  assert.equal(state.done, true);
});

test("an unknown stage is recorded but does not become the current step", () => {
  // A newer backend can add a stage this client cannot render. It must not
  // strand the list: the last known-good stage stays current.
  const state = run([STAGES.RECEIVED, "some_future_stage"]);
  assert.equal(state.current, STAGES.RECEIVED);
  assert.ok(state.seen.includes("some_future_stage"));
});

test("an unknown stage first does not leave the list stuck", () => {
  const state = run(["some_future_stage"]);
  assert.equal(state.current, null, "nothing renderable has been seen yet");
  assert.deepEqual(state.seen, ["some_future_stage"]);
});

test("a malformed event is ignored rather than half-applied", () => {
  const state = run([STAGES.RECEIVED], [{}]);
  assert.equal(state.connecting, false);
  assert.deepEqual(state.seen, [STAGES.RECEIVED]);
  assert.equal(state.current, STAGES.RECEIVED);
});

// --------------------------------------------------------------------------
// Terminal states
// --------------------------------------------------------------------------

test("done carries the result and stops the spinner", () => {
  const state = run([STAGES.RECEIVED, STAGES.SYNTHESIS], [{}, {}]);
  const done = applyStage(state, { stage: STAGES.DONE, result: { verdict: "mixed" } });
  assert.equal(done.done, true);
  assert.deepEqual(done.result, { verdict: "mixed" });

  const el = buildProgressPanel(done);
  assert.equal(el.querySelector(".aibot-progress-active"), null);
  assert.match(el.querySelector(".aibot-progress-heading").textContent, /complete/i);
});

test("an error frame becomes a visible message", () => {
  const state = applyStage(initialProgress(), {
    stage: STAGES.ERROR,
    message: "Rate limited by the analysis backend.",
  });
  assert.equal(state.done, true);
  assert.equal(state.error, "Rate limited by the analysis backend.");

  const el = buildProgressPanel(state);
  assert.match(el.querySelector(".aibot-progress-error").textContent, /Rate limited/);
});

test("isTerminal and isConditional classify the stage set", () => {
  assert.equal(isTerminal(STAGES.DONE), true);
  assert.equal(isTerminal(STAGES.ERROR), true);
  assert.equal(isTerminal(STAGES.OCR), false);
  for (const stage of CONDITIONAL_STAGES) assert.equal(isConditional(stage), true);
  assert.equal(isConditional(STAGES.OCR), false);
  assert.deepEqual([...TERMINAL_STAGES], [STAGES.DONE, STAGES.ERROR]);
});

// --------------------------------------------------------------------------
// Cancellation
// --------------------------------------------------------------------------

test("a stop button is offered while running and removed once finished", () => {
  let cancelled = 0;
  const running = buildProgressPanel(run([STAGES.RECEIVED]), {
    onCancel: () => {
      cancelled += 1;
    },
  });
  const button = running.querySelector(".aibot-progress-cancel");
  assert.ok(button, "a 20-60s wait must be cancellable");
  button.dispatchEvent(new dom.window.Event("click"));
  assert.equal(cancelled, 1);

  const finished = buildProgressPanel(run([STAGES.RECEIVED, STAGES.DONE]));
  assert.equal(finished.querySelector(".aibot-progress-cancel"), null);
});

test("no stop button when no handler is wired", () => {
  const el = buildProgressPanel(run([STAGES.RECEIVED]));
  assert.equal(el.querySelector(".aibot-progress-cancel"), null);
});

// --------------------------------------------------------------------------
// The non-streaming path
// --------------------------------------------------------------------------

test("the fallback wording makes no claim about server-side work", () => {
  const el = buildProgressPanel(initialProgress(), { stages: fallbackStages });
  assert.match(el.textContent, /Request sent/);
  assert.match(el.textContent, /this can take a minute/);
  // Crucially: none of the backend's stage labels, which would be a lie here.
  for (const stage of [
    STAGES.SEARCHING,
    STAGES.CREDIBILITY,
    STAGES.OCR,
    STAGES.SYNTHESIS,
  ]) {
    assert.equal(el.querySelector(`[data-stage=${stage}]`), null);
  }
});

test("the fallback path is still cancellable", () => {
  const el = buildProgressPanel(initialProgress(), {
    stages: fallbackStages,
    onCancel: () => {},
  });
  assert.ok(el.querySelector(".aibot-progress-cancel"));
});

// --------------------------------------------------------------------------
// SSE parsing
// --------------------------------------------------------------------------

test("parseSSE reads the frames the backend emits", () => {
  const body =
    'event: received\ndata: {"stage": "received"}\n\n' +
    'event: searching\ndata: {"stage": "searching", "tool": "web_search_llm"}\n\n' +
    'event: done\ndata: {"stage": "done", "result": {"verdict": "mixed"}}\n\n';

  const { events, remainder } = parseSSE(body);
  assert.equal(remainder, "");
  assert.deepEqual(
    events.map((e) => e.stage),
    [STAGES.RECEIVED, STAGES.SEARCHING, STAGES.DONE],
  );
  assert.equal(events[1].tool, "web_search_llm");
  assert.equal(events[2].result.verdict, "mixed");
});

test("parseSSE holds an incomplete frame until the rest arrives", () => {
  // A network chunk boundary can land mid-frame; parsing it as a complete
  // frame would drop the event.
  const first = 'event: ocr\ndata: {"stage": "ocr", "text_ch';
  const partial = parseSSE(first);
  assert.deepEqual(partial.events, []);
  assert.ok(partial.remainder.includes("text_ch"));

  const second = 'ars": 120}\n\nevent: done\ndata: {"stage":"done","result":{}}\n\n';
  const rest = parseSSE(partial.remainder + second);
  assert.deepEqual(
    rest.events.map((e) => e.stage),
    [STAGES.OCR, STAGES.DONE],
  );
  assert.equal(rest.events[0].text_chars, 120);
});

test("parseSSE ignores keepalive comments and blank frames", () => {
  const { events } = parseSSE(
    ': keepalive\n\nevent: received\ndata: {"stage": "received"}\n\n\n\n',
  );
  assert.deepEqual(
    events.map((e) => e.stage),
    [STAGES.RECEIVED],
  );
});

test("parseSSE drops a frame with unparseable JSON", () => {
  const { events } = parseSSE("event: done\ndata: {not json\n\n");
  assert.deepEqual(events, []);
});

test("parseSSE tolerates CRLF line endings", () => {
  const { events } = parseSSE('event: ocr\r\ndata: {"stage":"ocr"}\r\n\r\n');
  assert.equal(events[0].stage, STAGES.OCR);
});

test("the event name is used when the payload omits its own stage", () => {
  const { events } = parseSSE('event: synthesis\ndata: {"tool": null}\n\n');
  assert.equal(events[0].stage, STAGES.SYNTHESIS);
});

// --------------------------------------------------------------------------
// Stream detection
// --------------------------------------------------------------------------

test("isStreamResponse accepts only a real event-stream", () => {
  const withType = (type, ok = true) => ({
    ok,
    headers: { get: () => type },
  });
  assert.equal(isStreamResponse(withType("text/event-stream; charset=utf-8")), true);
  // A backend without the endpoint 404s with JSON: must fall back, not parse.
  assert.equal(isStreamResponse(withType("application/json", false)), false);
  assert.equal(isStreamResponse(withType("application/json")), false);
  // A proxy returning an HTML error page with a 200.
  assert.equal(isStreamResponse(withType("text/html")), false);
  assert.equal(isStreamResponse(null), false);
  assert.equal(isStreamResponse({ ok: true, headers: null }), false);
});

// --------------------------------------------------------------------------
// Safety
// --------------------------------------------------------------------------

test("a server-supplied stage name never becomes markup", () => {
  const state = applyStage(initialProgress(), { stage: "received" });
  const el = buildProgressPanel(state, {
    stages: [{ stage: "x", label: '<img src=x onerror="alert(1)">' }],
  });
  assert.equal(el.querySelector("img"), null);
  assert.match(el.textContent, /onerror/);
});
