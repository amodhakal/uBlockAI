"""LangChain ReAct agent used for claim verification.

The compiled graph is built once per process and shared across requests, rather
than being reconstructed on every call.
"""

import json
from typing import Any, Dict, List, Optional

from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent
from pydantic import ValidationError

from app.agents.prompts import SYSTEM_PROMPT
from app.schemas.agent_io import AgentOutput, ClaimInput
from app.tools.registry import get_langchain_tools

# Cap on how far back we will look for the final answer, so a pathological
# message list cannot make extraction unbounded.
_MAX_MESSAGE_SCAN = 25


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
    """
    if model is None:
        from app.llm import get_chat_model

        model = get_chat_model(timeout=90.0)
    return create_react_agent(
        model=model, tools=get_langchain_tools(), prompt=SYSTEM_PROMPT
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

    async def run(
        self, inp: ClaimInput, assistant_id: Optional[str] = None
    ) -> AgentOutput:
        agent = self._get_agent()

        message_payload: Dict[str, Any] = {"claims": inp.claims}
        if inp.context:
            message_payload["context"] = inp.context.model_dump()

        initial_input = {
            "messages": [("user", json.dumps(message_payload, default=str))]
        }

        result = await agent.ainvoke(initial_input)
        messages = result.get("messages", []) if isinstance(result, dict) else []

        final_message = extract_final_message(messages)
        data = parse_agent_output(_message_content(final_message))
        data.setdefault("tool_rounds", 1)

        try:
            return AgentOutput(**data)
        except ValidationError as exc:
            raise AgentOutputError(
                f"Agent output failed schema validation:\n{exc}\n"
                f"Output:\n{json.dumps(data, indent=2)}"
            ) from exc
