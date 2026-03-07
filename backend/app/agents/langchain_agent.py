import json
from typing import Any, Dict, List, Optional, Literal
from langgraph.prebuilt import create_react_agent
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, ValidationError
from app.agents.prompts import SYSTEM_PROMPT
from app.schemas.agent_io import AgentContext, AgentOutput, ClaimInput, Verdict
from app.tools.registry import get_langchain_tools
from app.tools.web_search_tool import web_search_llm
from app.tools.credibility_tool import credibility_llm


llm = ChatOpenAI(model="gpt-5-main", temperature=0)


class LangChainAgent:
    def __init__(self, api_key: str = "", model_name: str = "gpt-5-main"):
        self.model_name = model_name
        self._llm = ChatOpenAI(model=model_name, temperature=0)
        self._agent = None

    def _get_agent(self):
        if self._agent is None:
            tools = get_langchain_tools()
            self._agent = create_react_agent(
                model=self._llm, tools=tools, state_modifier=SYSTEM_PROMPT
            )
        return self._agent

    async def run(
        self, inp: ClaimInput, assistant_id: Optional[str] = None
    ) -> AgentOutput:
        agent = self._get_agent()

        message_payload = {
            "claims": inp.claims,
        }
        if inp.context:
            message_payload["context"] = inp.context.model_dump()

        print(f"Input payload: {message_payload}")

        initial_input = {
            "messages": [("user", json.dumps(message_payload, default=str))]
        }

        result = await agent.ainvoke(initial_input)

        messages = result.get("messages", [])

        final_message = None
        for msg in reversed(messages):
            if hasattr(msg, "type") and msg.type == "ai":
                final_message = msg
                break
            elif isinstance(msg, dict):
                content = msg.get("content", "")
                if content and isinstance(content, str):
                    try:
                        json.loads(content)
                        final_message = msg
                        break
                    except json.JSONDecodeError:
                        continue

        if final_message is None:
            raise RuntimeError("Agent returned no content")

        raw_content = (
            final_message.content
            if hasattr(final_message, "content")
            else final_message.get("content", "")
        )

        if isinstance(raw_content, str):
            try:
                data = json.loads(raw_content)
            except json.JSONDecodeError:
                raise RuntimeError(
                    f"Agent output is not valid JSON: {raw_content[:500]}"
                )
        elif isinstance(raw_content, dict):
            data = raw_content
        else:
            raise RuntimeError(f"Unexpected agent output type: {type(raw_content)}")

        data.setdefault("tool_rounds", 1)

        try:
            return AgentOutput(**data)
        except ValidationError as e:
            raise RuntimeError(
                f"Agent output failed schema validation:\n{e}\nOutput:\n{json.dumps(data, indent=2)}"
            )
