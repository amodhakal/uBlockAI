"""Tool registry.

The JSON tool definitions below are generated from the LangChain ``@tool``
objects themselves. Previously the descriptions and parameter schemas were
hand-copied here, guaranteeing they would drift from the docstrings the model
actually sees. Deriving them means there is exactly one definition per tool.
"""

from typing import Any, Dict, List

from app.tools.web_search_tool import web_search_llm
from app.tools.credibility_tool import credibility_llm
from app.tools.numeric_verify import numeric_verify

_LANGCHAIN_TOOLS = [web_search_llm, credibility_llm, numeric_verify]


def get_langchain_tools() -> List:
    """Return the LangChain tool objects bound to the ReAct agent."""
    return list(_LANGCHAIN_TOOLS)


def _tool_to_function_def(lc_tool) -> Dict[str, Any]:
    """Convert a LangChain tool into an OpenAI-style function definition."""
    args_schema = getattr(lc_tool, "args_schema", None)
    parameters: Dict[str, Any]
    if args_schema is not None and hasattr(args_schema, "model_json_schema"):
        schema = args_schema.model_json_schema()
        parameters = {
            "type": "object",
            "properties": schema.get("properties", {}),
        }
        if schema.get("required"):
            parameters["required"] = schema["required"]
    else:
        parameters = {"type": "object", "properties": {}}

    return {
        "type": "function",
        "function": {
            "name": lc_tool.name,
            "description": (lc_tool.description or "").strip(),
            "parameters": parameters,
        },
    }


def get_tool_definitions() -> List[Dict[str, Any]]:
    """Return OpenAI-style function definitions, derived from the tools."""
    return [_tool_to_function_def(t) for t in _LANGCHAIN_TOOLS]
