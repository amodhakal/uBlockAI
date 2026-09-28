"""LangChain ReAct agent used for claim verification.

The compiled graph is built once per process and shared across requests, rather
than being reconstructed on every call.

Synthesis is finished in code, not in the prompt: see
:func:`apply_credibility_weighting`.
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent
from pydantic import ValidationError

from app.agents.prompts import SYSTEM_PROMPT
from app.progress import STAGE_SYNTHESIS, stage_for_tool
from app.schemas.agent_io import AgentOutput, ClaimInput
from app.tools.credibility_tool import weight_for_tier
from app.tools.registry import get_langchain_tools

logger = logging.getLogger(__name__)

# Cap on how far back we will look for the final answer, so a pathological
# message list cannot make extraction unbounded.
_MAX_MESSAGE_SCAN = 25

# How much of the final misinformation score the model's own judgement keeps.
# The rest comes from the credibility-weighted evidence, so a model that
# ignored its own citations is overruled and a model that followed them is not
# second-guessed.
MODEL_BLEND = 0.5

# Hard bound on that correction, in score points. The evidence moves the score;
# it does not decide the verdict, and an all-low-credibility evidence set must
# not manufacture certainty out of forum posts.
MAX_CORRECTION = 0.15


class AgentOutputError(RuntimeError):
    """The agent finished without producing a usable report."""


def _message_type(message: Any) -> str:
    if isinstance(message, dict):
        return str(message.get("type", ""))
    return str(getattr(message, "type", ""))


def _message_content(message: Any) -> Any:
    if isinstance(message, dict):
        return message.get("content")
    return getattr(message, "content", None)


def extract_final_message(messages: List[Any]) -> Any:
    """Find the last message that actually carries the agent's final answer.

    The previous implementation took the most recent message whose type was
    "ai" without checking its content. When the model emitted an AI message
    with empty or tool-call-only content, that empty message was selected and
    the subsequent json.loads raised, so an empty final message guaranteed a
    RuntimeError instead of falling back to the previous real answer.
    """
    if not messages:
        raise AgentOutputError("Agent returned no messages")

    scanned = 0
    for message in reversed(messages):
        if scanned >= _MAX_MESSAGE_SCAN:
            break
        scanned += 1

        if _message_type(message) != "ai":
            continue

        content = _message_content(message)
        if isinstance(content, str) and content.strip():
            return message
        if isinstance(content, dict) and content:
            return message
        if isinstance(content, list) and content:
            # Some providers return a list of content blocks.
            return message

    raise AgentOutputError(
        "Agent returned no message with content; the model produced only "
        "empty or tool-call-only responses"
    )


def parse_agent_output(raw_content: Any) -> Dict[str, Any]:
    """Coerce a final message payload into the agent output dict."""
    if isinstance(raw_content, str):
        stripped = raw_content.strip()
        # Tolerate ```json fences, which models emit despite instructions.
        if stripped.startswith("```"):
            stripped = stripped.strip("`")
            if stripped.lower().startswith("json"):
                stripped = stripped[4:]
            stripped = stripped.strip()
        if not stripped:
            raise AgentOutputError("Agent final message was empty")
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise AgentOutputError(
                f"Agent output is not valid JSON: {stripped[:500]}"
            ) from exc
    elif isinstance(raw_content, dict):
        data = raw_content
    else:
        raise AgentOutputError(
            f"Unexpected agent output type: {type(raw_content).__name__}"
        )

    if not isinstance(data, dict):
        raise AgentOutputError(
            f"Agent output must be a JSON object, got {type(data).__name__}"
        )
    return data


def build_agent(model: Optional[ChatOpenAI] = None) -> Any:
    """Compile the ReAct agent graph.

    The system prompt is passed as ``prompt``. The previous code used
    ``state_modifier``, which langgraph no longer accepts: on the pinned
    langgraph 1.2.12 that argument raises TypeError, so every analysis request
    failed before the agent ran.

    ``response_format`` makes the model emit an ``AgentOutput`` directly, so
    the final message is already a validated instance rather than a JSON string
    we have to parse and hope is well formed.
    """
    if model is None:
        from app.llm import get_chat_model

        model = get_chat_model(timeout=90.0)
    return create_react_agent(
        model=model,
        tools=get_langchain_tools(),
        prompt=SYSTEM_PROMPT,
        response_format=AgentOutput,
    )


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def weighted_support(evidence: List[Any]) -> Optional[float]:
    """Share of total source weight that supports the claim, or None.

    Only rated evidence counts: an item with an unrecognized or missing
    ``source_credibility`` has weight 0.0, so it cannot dilute the denominator
    and inflate the result. None means "nothing was rated", which is different
    from a support of 0.0 ("everything rated contradicts the claim") and must
    not be treated as evidence of falsehood.
    """
    total = 0.0
    supporting = 0.0
    for item in evidence:
        weight = weight_for_tier(getattr(item, "source_credibility", None))
        if weight <= 0.0:
            continue
        total += weight
        if getattr(item, "supporting", None) is True:
            supporting += weight
    if total <= 0.0:
        return None
    return supporting / total


def apply_credibility_weighting(output: AgentOutput) -> AgentOutput:
    """Recompute the misinformation score from credibility-weighted evidence.

    The prompt asks the model to weight higher-credibility sources more heavily
    and then asks it to score the claim, which leaves the arithmetic to the
    same generation that produced the evidence it is scoring. Two runs over the
    same sources can disagree, and a model that quietly ignored its citations
    looks identical to one that followed them.

    So the weighting is applied here. The model's score still leads
    (``MODEL_BLEND``); the evidence contributes the rest, bounded by
    ``MAX_CORRECTION`` so a weak evidence set can nudge the score but never
    manufacture a verdict on its own. The result, the support share and the
    correction are all written onto the output, and the correction is appended
    to the reasoning chain, because a number that moved without an audit trail
    is worse than a number that did not move.
    """
    support = weighted_support(output.evidence)
    if support is None:
        # No rated evidence: the model's score stands untouched rather than
        # being pulled toward a default.
        return output.model_copy(update={"credibility_weighted_support": None})

    original = output.misinformation_risk_score
    implied_risk = 1.0 - support
    correction = _clamp(
        (1.0 - MODEL_BLEND) * (implied_risk - original),
        low=-MAX_CORRECTION,
        high=MAX_CORRECTION,
    )
    adjusted = round(_clamp(original + correction), 4)

    rated = sum(
        1 for item in output.evidence if weight_for_tier(item.source_credibility) > 0
    )
    audit = (
        f"Credibility weighting: {rated} rated source(s), "
        f"weighted support {support:.2f}, misinformation risk "
        f"{original:.2f} -> {adjusted:.2f}"
    )
    logger.info(audit)

    return output.model_copy(
        update={
            "misinformation_risk_score": adjusted,
            "credibility_weighted_support": round(support, 4),
            "reasoning_chain": [*output.reasoning_chain, audit],
        }
    )


class LangChainAgent:
    """Thin wrapper around the shared ReAct agent.

    Instances are cheap; the underlying graph is process-wide so that a fresh
    graph is not compiled per request.
    """

    _shared_agent: Any = None
    _shared_model_name: str | None = None

    def __init__(self, api_key: str = "", model_name: str | None = None):
        self.model_name = model_name
        self._api_key = api_key

    def _get_llm(self) -> ChatOpenAI:
        from app.llm import get_chat_model

        return get_chat_model(
            model=self.model_name,
            api_key=self._api_key or None,
            timeout=90.0,
        )

    @classmethod
    def get_shared_agent(cls, model_name: str | None = None) -> Any:
        """Return the process-wide agent, compiling it on first use."""
        if cls._shared_agent is None or (
            model_name is not None and cls._shared_model_name != model_name
        ):
            from app.llm import get_chat_model

            cls._shared_agent = build_agent(
                get_chat_model(model=model_name, timeout=90.0)
            )
            cls._shared_model_name = model_name
        return cls._shared_agent

    @classmethod
    def reset_shared_agent(cls) -> None:
        """Drop the cached graph. Used by tests."""
        cls._shared_agent = None
        cls._shared_model_name = None

    def _get_agent(self) -> Any:
        return self.get_shared_agent(self.model_name)

    def _build_input(self, inp: ClaimInput) -> Dict[str, Any]:
        message_payload: Dict[str, Any] = {"claims": inp.claims}
        if inp.context:
            message_payload["context"] = inp.context.model_dump()
        return {"messages": [("user", json.dumps(message_payload, default=str))]}

    @staticmethod
    def _output_from_state(result: Dict[str, Any]) -> AgentOutput:
        """Turn a finished graph state into a validated AgentOutput.

        Shared by `run` and `stream_run` so the streaming path cannot drift
        from the JSON path: there is one implementation of "what counts as a
        usable answer", not two.
        """
        if not isinstance(result, dict):
            raise AgentOutputError(
                f"Agent returned an unexpected result type: {type(result).__name__}"
            )

        # Preferred path: langgraph's response_format hands back an
        # already-validated AgentOutput, so no JSON parsing is needed.
        structured = result.get("structured_response")
        if isinstance(structured, AgentOutput):
            return apply_credibility_weighting(structured)
        if isinstance(structured, dict):
            try:
                return apply_credibility_weighting(AgentOutput(**structured))
            except ValidationError as exc:
                raise AgentOutputError(
                    f"Agent structured response failed validation:\n{exc}"
                ) from exc

        # Fallback for when the provider could not honour response_format.
        messages = result.get("messages", [])
        final_message = extract_final_message(messages)
        data = parse_agent_output(_message_content(final_message))
        data.setdefault("tool_rounds", 1)

        try:
            return apply_credibility_weighting(AgentOutput(**data))
        except ValidationError as exc:
            raise AgentOutputError(
                f"Agent output failed schema validation:\n{exc}\n"
                f"Output:\n{json.dumps(data, indent=2)}"
            ) from exc

    async def run(
        self, inp: ClaimInput, assistant_id: Optional[str] = None
    ) -> AgentOutput:
        agent = self._get_agent()
        result = await agent.ainvoke(self._build_input(inp))
        return self._output_from_state(result)

    async def stream_run(
        self, inp: ClaimInput
    ) -> AsyncIterator[Tuple[Optional[str], Any]]:
        """Run the agent, yielding real progress as it happens (#83).

        Yields ``(stage, detail)`` tuples. The final yield is ``(None,
        AgentOutput)``; every other yield is ``(stage, detail)`` where stage is
        a value from app.progress and detail is the LangChain tool name for a
        tool stage, or None otherwise.

        The stages are observed, not scheduled:

        * a tool stage is emitted because the graph's `tools` node actually ran
          that tool, so a run that never searches never claims to have searched;
        * `synthesis` is emitted when the agent node produces a message with no
          tool calls, which is the moment the model commits to an answer
          instead of asking for another tool.

        This drives the same compiled graph as `run` via `astream`, so there is
        one agent, one prompt and one set of tools. `astream` is used rather
        than a hand-rolled callback because the graph is shared process-wide
        and requests are concurrent; subscribing to a per-request callback on a
        shared object would cross-contaminate simultaneous requests.
        """
        agent = self._get_agent()
        initial_input = self._build_input(inp)

        last_state: Optional[Dict[str, Any]] = None
        synthesis_reported = False

        async for mode, chunk in agent.astream(
            initial_input, stream_mode=["updates", "values"]
        ):
            if mode == "values":
                # Each values chunk is the full state so far. Only the last one
                # matters, and the structured response is not present on the
                # earlier ones, so this cannot be resolved early.
                if isinstance(chunk, dict):
                    last_state = chunk
                continue

            if not isinstance(chunk, dict):
                continue

            for node, update in chunk.items():
                if not isinstance(update, dict):
                    continue
                messages = update.get("messages") or []

                if node == "tools":
                    for message in messages:
                        tool_name = getattr(message, "name", None)
                        stage = stage_for_tool(tool_name)
                        if stage is not None:
                            yield stage, tool_name
                        else:
                            # A real tool round with no named stage. Yielded
                            # with a None stage so the caller can log it,
                            # rather than silently discarded.
                            yield None, tool_name

                elif node == "agent" and not synthesis_reported:
                    for message in messages:
                        if getattr(message, "tool_calls", None):
                            continue
                        content = _message_content(message)
                        if isinstance(content, str) and content.strip():
                            synthesis_reported = True
                            yield STAGE_SYNTHESIS, None
                            break

        if last_state is None:
            raise AgentOutputError("Agent produced no state to read a result from")

        yield None, self._output_from_state(last_state)
