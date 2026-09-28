"""Progress stages for the streaming analysis endpoint (#83).

A full agent run takes 20-60 seconds. During that window the extension used to
show nothing at all, so a slow analysis and a hung analysis were
indistinguishable and the natural user response was to reload the page and
throw the work away.

The stages below exist so the interface can say what the backend is actually
doing. That constraint drove the design: **every stage here is emitted from a
real point in the pipeline**, never on a timer and never optimistically.

Provenance of each stage, stated plainly because it is the whole point:

    received     the request body parsed and validated
    decoding     about to fetch/OCR the post text
    ocr          post text extraction finished
    searching    the agent called the web_search_llm tool
    credibility  the agent called the credibility_llm tool
    verifying    the agent called the numeric_verify tool
    synthesis    the agent produced its final message
    done         the validated AgentOutput is being returned

`searching`, `credibility` and `verifying` are driven by observed tool calls
from the agent graph, so they appear only when the agent genuinely used that
tool. A run that answers from the caption alone never emits `searching`, and
that is correct: the interface must not claim work that was not done. A
client therefore has to treat these as an unordered-ish set that may be
skipped, not a checklist it can rely on being completed.

SSE wire format (see routes.analyze_claims_stream):

    event: <stage>
    data: {"stage": "<stage>", ...}

Each event carries a `data:` JSON object with at least `stage`. Terminal
events additionally carry `result` (the AgentOutput dump) for `done`, or
`message` for `error`. A bare `data:` line with no `event:` name is treated by
the client as `message`, so the stream stays readable by a plain
`EventSource`-style parser.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

STAGE_RECEIVED = "received"
STAGE_DECODING = "decoding"
STAGE_OCR = "ocr"
STAGE_SEARCHING = "searching"
STAGE_CREDIBILITY = "credibility"
STAGE_VERIFYING = "verifying"
STAGE_SYNTHESIS = "synthesis"
STAGE_DONE = "done"
STAGE_ERROR = "error"

#: Presentation order. ``synthesis`` and ``done`` are terminal.
STAGE_ORDER = (
    STAGE_RECEIVED,
    STAGE_DECODING,
    STAGE_OCR,
    STAGE_SEARCHING,
    STAGE_CREDIBILITY,
    STAGE_VERIFYING,
    STAGE_SYNTHESIS,
    STAGE_DONE,
)

#: LangChain tool name -> progress stage. A tool absent from this map still
#: counts as a real tool round, it just does not get its own named stage.
TOOL_STAGES: Dict[str, str] = {
    "web_search_llm": STAGE_SEARCHING,
    "credibility_llm": STAGE_CREDIBILITY,
    "numeric_verify": STAGE_VERIFYING,
}

#: Stages the agent may or may not reach, depending on what it decides to do.
CONDITIONAL_STAGES = frozenset({STAGE_SEARCHING, STAGE_CREDIBILITY, STAGE_VERIFYING})


def stage_for_tool(tool_name: Optional[str]) -> Optional[str]:
    """Map a LangChain tool name to its progress stage.

    Unknown tool names return None rather than a generic "working" stage, so
    adding a tool without a stage mapping is visible here rather than silently
    producing a stage nothing ever emits.
    """
    if not tool_name:
        return None
    return TOOL_STAGES.get(tool_name)


def sse_event(stage: str, **fields: Any) -> str:
    """Render one Server-Sent Events frame.

    `event:` names the stage so a client can dispatch on it without parsing
    the payload, and `data:` carries the JSON. The trailing blank line is
    required by the SSE spec: without it the frame is never dispatched.
    """
    payload: Dict[str, Any] = {"stage": stage}
    payload.update(fields)
    return f"event: {stage}\ndata: {json.dumps(payload)}\n\n"


def sse_error(message: str) -> str:
    """Render the terminal error frame.

    The message is the generic client-facing string, never the exception text:
    exceptions here can carry internal paths and upstream API errors.
    """
    return sse_event(STAGE_ERROR, message=message)


def sse_comment(text: str = "keepalive") -> str:
    """A comment frame, used to keep proxies from closing an idle stream."""
    return f": {text}\n\n"
