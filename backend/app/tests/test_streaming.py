"""Streaming analysis endpoint and real progress reporting (#83).

The central claim under test is that the SSE stages are *observed* rather than
scheduled: `searching` appears because the agent graph really ran the search
tool, and a run that never searches must not emit it. A test that only checked
"the endpoint returns 200 and some text/event-stream" would pass against a
fabricated timeline, so these tests drive a scripted graph through the real
`stream_run` code path and assert on which stages came out.
"""

import asyncio
import json
from typing import Optional

import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.prebuilt import create_react_agent

from app.agents.langchain_agent import AgentOutputError, LangChainAgent
from app.progress import (
    CONDITIONAL_STAGES,
    STAGE_CREDIBILITY,
    STAGE_DONE,
    STAGE_OCR,
    STAGE_RECEIVED,
    STAGE_SEARCHING,
    STAGE_SYNTHESIS,
    STAGE_VERIFYING,
    sse_error,
    sse_event,
    stage_for_tool,
)

#: A final assistant message that parses into a valid AgentOutput. The scripted
#: model falls back to this when its script runs out, so tests that only care
#: about which stages fired do not each have to restate a full JSON payload.
_FINAL_JSON = json.dumps(
    {
        "ai_generated_risk_score": 0.2,
        "misinformation_risk_score": 0.8,
        "verdict": "likely_false",
        "confidence": 0.7,
        "explanation": "contradicted by the sources",
    }
)


@pytest.fixture
def app_client(tmp_path, monkeypatch):
    """A test client for the real Flask app, with a temp feedback dir."""
    import dataclasses

    import app.config as config
    import app.main as main

    patched = dataclasses.replace(config.get_settings(), feedback_dir=tmp_path)
    monkeypatch.setattr(main, "get_settings", lambda: patched)
    monkeypatch.setattr("app.api.routes.get_settings", lambda: patched)
    main.app.config.update(TESTING=True)
    return main.app.test_client()


# --------------------------------------------------------------------------
# Helpers: a real compiled graph driven by a scripted model
# --------------------------------------------------------------------------


class _ScriptedModel(BaseChatModel):
    """Replays a fixed list of messages, then answers plainly.

    A real BaseChatModel because `create_react_agent` calls `bind_tools`; a
    duck-typed stand-in is rejected at graph construction.
    """

    steps: list = []
    idx: int = 0

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools, **kwargs):  # noqa: D102 - test double
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):  # noqa: D102
        i = self.idx
        self.idx += 1
        msg = self.steps[i] if i < len(self.steps) else AIMessage(content=_FINAL_JSON)
        return ChatResult(generations=[ChatGeneration(message=msg)])


def _tool_call(name, args, call_id):
    return AIMessage(
        content="", tool_calls=[{"name": name, "args": args, "id": call_id}]
    )


def _stub_tools():
    """Local stand-ins carrying the real tools' names, so no network is used.

    The name is the only thing the stage mapping keys on, so keeping the real
    names keeps the test meaningful: `web_search_llm` really does get invoked,
    it just returns a canned payload instead of calling a search API.
    """
    from langchain_core.tools import tool

    @tool
    def web_search_llm(claim_text: str, top_k: int = 5) -> dict:
        """Stub standing in for the real search tool."""
        return {"claim_text": claim_text, "selected": []}

    @tool
    def credibility_llm(sources: list) -> dict:
        """Stub standing in for the real credibility tool."""
        return {"items": []}

    @tool
    def numeric_verify(
        claim_text: str, expected_result: Optional[float] = None
    ) -> dict:
        """Stub standing in for the real numeric verification tool."""
        return {"claim_text": claim_text, "finding": {"score": 0.0}}

    return [web_search_llm, credibility_llm, numeric_verify]


def _build_agent(steps):
    agent = create_react_agent(
        model=_ScriptedModel(steps=list(steps)),
        tools=_stub_tools(),
        prompt="sys",
    )
    LangChainAgent.reset_shared_agent()
    return agent


def _run_stream(steps):
    """Drive the real stream_run and collect the stages it yields."""
    from app.schemas.agent_io import ClaimInput

    agent = _build_agent(steps)
    runner = LangChainAgent()
    # Bypass the process-wide cache so this agent is the one that runs.
    runner._get_agent = lambda: agent  # noqa: SLF001 - deliberate test seam

    async def collect():
        stages = []
        result = None
        async for stage, value in runner.stream_run(ClaimInput(claims=["a claim"])):
            if stage is None and not isinstance(value, str):
                result = value
                continue
            stages.append((stage, value))
        return stages, result

    return asyncio.run(collect())


# --------------------------------------------------------------------------
# Stage provenance
# --------------------------------------------------------------------------


def test_stage_for_tool_maps_only_the_tools_we_can_name():
    assert stage_for_tool("web_search_llm") == STAGE_SEARCHING
    assert stage_for_tool("credibility_llm") == STAGE_CREDIBILITY
    assert stage_for_tool("numeric_verify") == STAGE_VERIFYING
    # Unknown and missing names must not become a stage.
    assert stage_for_tool("some_future_tool") is None
    assert stage_for_tool(None) is None
    assert stage_for_tool("") is None


def test_tool_stages_are_marked_conditional():
    # A client that treats these as a required checklist will wait forever for
    # a search that the agent decided it did not need.
    assert STAGE_SEARCHING in CONDITIONAL_STAGES
    assert STAGE_CREDIBILITY in CONDITIONAL_STAGES
    assert STAGE_VERIFYING in CONDITIONAL_STAGES
    assert STAGE_RECEIVED not in CONDITIONAL_STAGES


# --------------------------------------------------------------------------
# The stages are real
# --------------------------------------------------------------------------


def test_searching_is_emitted_only_because_the_tool_actually_ran():
    from app.schemas.agent_io import ClaimInput  # noqa: F401 - documents the input shape

    steps = [_tool_call("web_search_llm", {"claim_text": "a claim"}, "1")]
    stages, result = _run_stream(steps)

    seen = [s for s, _ in stages if s]
    assert STAGE_SEARCHING in seen, "the search tool ran, so the stage must appear"
    assert result is not None


def test_a_run_that_never_searches_does_not_claim_to_have_searched():
    steps = []
    stages, result = _run_stream(steps)

    seen = [s for s, _ in stages if s]
    assert STAGE_SEARCHING not in seen, (
        "no search tool ran; emitting the stage would be a fabricated progress event"
    )
    assert result is not None


def test_every_conditional_stage_is_driven_by_a_real_tool_call():
    steps = [
        _tool_call("web_search_llm", {"claim_text": "a claim"}, "1"),
        _tool_call("credibility_llm", {"sources": []}, "2"),
        _tool_call("numeric_verify", {"claim_text": "a claim"}, "3"),
    ]
    stages, _ = _run_stream(steps)

    seen = {s for s, _ in stages if s}
    assert STAGE_SEARCHING in seen
    assert STAGE_CREDIBILITY in seen
    assert STAGE_VERIFYING in seen


def test_synthesis_is_emitted_when_the_agent_commits_to_an_answer():
    steps = [_tool_call("web_search_llm", {"claim_text": "a claim"}, "1")]
    stages, result = _run_stream(steps)

    seen = [s for s, _ in stages if s]
    assert STAGE_SYNTHESIS in seen
    # It must come after the tool stage, or it is not reporting anything real.
    assert seen.index(STAGE_SYNTHESIS) > seen.index(STAGE_SEARCHING)
    assert result is not None


def test_stream_run_yields_the_same_output_as_run():
    """The streaming path must not weaken the answer it produces."""
    from app.schemas.agent_io import ClaimInput

    def _fresh_runner():
        # A fresh scripted model per run: it is stateful, so reusing one would
        # make the second run answer from a different script than the first.
        agent = _build_agent([AIMessage(content=_FINAL_JSON)])
        runner = LangChainAgent()
        runner._get_agent = lambda: agent  # noqa: SLF001
        return runner

    plain = asyncio.run(_fresh_runner().run(ClaimInput(claims=["a claim"])))

    async def collect():
        out = None
        async for stage, value in _fresh_runner().stream_run(
            ClaimInput(claims=["a claim"])
        ):
            if stage is None and not isinstance(value, str):
                out = value
        return out

    streamed = asyncio.run(collect())

    assert streamed is not None
    assert streamed.verdict == plain.verdict
    assert streamed.misinformation_risk_score == plain.misinformation_risk_score
    assert streamed.explanation == plain.explanation
    assert streamed.ai_generated_risk_score == plain.ai_generated_risk_score


def test_stream_run_raises_when_the_agent_yields_nothing_usable():
    from app.schemas.agent_io import ClaimInput

    agent = _build_agent([AIMessage(content="")])
    runner = LangChainAgent()
    runner._get_agent = lambda: agent  # noqa: SLF001

    async def collect():
        async for _ in runner.stream_run(ClaimInput(claims=["a claim"])):
            pass

    with pytest.raises(AgentOutputError):
        asyncio.run(collect())


# --------------------------------------------------------------------------
# SSE wire format
# --------------------------------------------------------------------------


def test_sse_event_has_a_named_event_and_a_json_data_line():
    frame = sse_event(STAGE_SEARCHING, tool="web_search_llm")
    assert frame.startswith("event: searching\n")
    body = frame.split("data: ", 1)[1]
    # The trailing blank line is what makes the SSE spec dispatch the frame.
    assert frame.endswith("\n\n")
    payload = json.loads(body.strip())
    assert payload["stage"] == STAGE_SEARCHING
    assert payload["tool"] == "web_search_llm"


def test_sse_error_carries_the_message_and_the_stage():
    payload = json.loads(sse_error("Analysis failed.").split("data: ", 1)[1])
    assert payload["stage"] == "error"
    assert payload["message"] == "Analysis failed."


def test_done_frame_carries_the_agent_output():
    payload = json.loads(
        sse_event(STAGE_DONE, result={"verdict": "mixed"}).split("data: ", 1)[1]
    )
    assert payload["result"]["verdict"] == "mixed"


# --------------------------------------------------------------------------
# Endpoint
# --------------------------------------------------------------------------


@pytest.fixture
def stub_pipeline(monkeypatch):
    """Replace OCR and the agent so endpoint tests never touch the network.

    The frames these produce are a canned stand-in; the *provenance* of the
    stages is proved separately by the stream_run tests above, which drive the
    real graph.
    """
    import app.api.routes as routes

    async def _fake_extract(payload):
        return {"llm-input-text": "some text from the post"}

    class _FakeAgent:
        def __init__(self, *a, **k):
            pass

        async def stream_run(self, claim_input):
            from app.schemas.agent_io import AgentOutput

            yield STAGE_SEARCHING, "web_search_llm"
            yield STAGE_SYNTHESIS, None
            yield (
                None,
                AgentOutput(
                    ai_generated_risk_score=0.1,
                    misinformation_risk_score=0.9,
                    verdict="likely_false",
                    confidence=0.8,
                    explanation="contradicted",
                ),
            )

        async def run(self, claim_input):
            async for _stage, value in self.stream_run(claim_input):
                if value.__class__.__name__ == "AgentOutput":
                    return value

    monkeypatch.setattr(routes, "extract_post_context", _fake_extract)
    monkeypatch.setattr(routes, "LangChainAgent", _FakeAgent)
    return routes


def test_stream_endpoint_sets_sse_headers(app_client, stub_pipeline):
    response = app_client.post(
        "/api/analyze_claims/stream",
        json={"url": "https://example.com/post", "caption": "hello"},
    )
    assert response.status_code == 200
    assert response.mimetype == "text/event-stream"
    # Without these a proxy buffers the whole stream and the endpoint is inert.
    assert response.headers["X-Accel-Buffering"] == "no"
    assert "no-cache" in response.headers["Cache-Control"]
    assert "no-transform" in response.headers["Cache-Control"]


def test_stream_endpoint_emits_frames_in_order_and_ends_with_done(
    app_client, stub_pipeline
):
    response = app_client.post(
        "/api/analyze_claims/stream",
        json={"url": "https://example.com/post", "caption": "hello"},
    )
    body = response.get_data(as_text=True)

    names = [
        line.split("event: ", 1)[1]
        for line in body.splitlines()
        if line.startswith("event: ")
    ]
    assert names[0] == STAGE_RECEIVED
    assert STAGE_OCR in names
    assert STAGE_SEARCHING in names
    assert STAGE_SYNTHESIS in names
    assert names[-1] == STAGE_DONE

    payloads = [
        json.loads(line.split("data: ", 1)[1])
        for line in body.splitlines()
        if line.startswith("data: ")
    ]
    final = payloads[-1]
    assert final["result"]["verdict"] == "likely_false"
    assert final["result"]["misinformation_risk_score"] == 0.9


def test_stream_endpoint_rejects_a_bad_body_without_streaming(app_client):
    response = app_client.post("/api/analyze_claims/stream", json={"caption": "no url"})
    assert response.status_code == 400
    assert response.mimetype == "application/json"


def test_json_endpoint_still_exists_and_is_not_a_stream(app_client, stub_pipeline):
    """The streaming endpoint is additive; the JSON contract is untouched."""
    response = app_client.post(
        "/api/analyze_claims", json={"url": "https://example.com/post", "caption": "hi"}
    )
    assert response.status_code == 200
    assert response.mimetype == "application/json"
    # Byte-for-byte the same AgentOutput the client already parses.
    assert response.get_json()["verdict"] == "likely_false"


def test_stream_endpoint_reports_agent_failure_as_an_error_frame(
    app_client, monkeypatch
):
    import app.api.routes as routes

    async def _fake_extract(payload):
        return {"llm-input-text": "t"}

    class _FailingAgent:
        def __init__(self, *a, **k):
            pass

        async def stream_run(self, claim_input):
            raise AgentOutputError("model returned nothing usable")
            yield  # pragma: no cover - generator marker

    monkeypatch.setattr(routes, "extract_post_context", _fake_extract)
    monkeypatch.setattr(routes, "LangChainAgent", _FailingAgent)

    response = app_client.post(
        "/api/analyze_claims/stream",
        json={"url": "https://example.com/post", "caption": "hi"},
    )
    # The status line is already sent by the time the agent fails, so the
    # failure has to travel in-band as an error event.
    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "event: error" in body
    assert "AgentOutputError" not in body, "exception type must not leak"
    assert "nothing usable" not in body, "exception text must not leak"
