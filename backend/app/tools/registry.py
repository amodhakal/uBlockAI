from typing import Any, Dict, List
from langchain_core.tools import tool
from app.tools.web_search_tool import web_search_llm
from app.tools.credibility_tool import credibility_llm
from app.tools.numeric_verify import numeric_verify


def get_tool_definitions() -> List[Dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "web_search_llm",
                "description": "LLM-assisted web search: generates queries to search on web, retrieves results, selects best evidence candidates from snippets.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "claim_text": {"type": "string"},
                        "top_k": {"type": "integer", "minimum": 1, "maximum": 10},
                        "prior_queries": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["claim_text"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "credibility_llm",
                "description": "LLM-based credibility tiering for sources using url/title/snippet.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "sources": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "url": {"type": "string"},
                                    "title": {"type": "string"},
                                    "snippet": {"type": "string"},
                                },
                                "required": ["url"],
                            },
                        }
                    },
                    "required": ["sources"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "numeric_verify",
                "description": "Verify numeric claims by checking if calculations are correct.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "claim_text": {"type": "string"},
                        "expected_result": {"type": "number"},
                    },
                    "required": ["claim_text"],
                },
            },
        },
    ]


def get_langchain_tools() -> List:
    return [web_search_llm, credibility_llm, numeric_verify]
