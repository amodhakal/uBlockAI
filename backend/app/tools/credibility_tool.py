import json
from typing import Any, Dict, List
from urllib.parse import urlparse
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from app.agents.prompts import CREDIBILITY_TOOL_PROMPT


llm = ChatOpenAI(model="gpt-5-main", temperature=0)


def _domain(u: str) -> str:
    return (urlparse(u).netloc or "").lower().replace("www.", "")


@tool
async def credibility_llm(sources: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    LLM-based credibility tiering for sources using url/title/snippet.

    Args:
        sources: List of sources with url, title, and snippet

    Returns:
        Dict with items containing url, domain, tier, rationale, and signals
    """
    print("Evaluating source credibility...")

    normalized = []
    for s in sources:
        url = s.get("url")
        if not url:
            continue
        normalized.append(
            {
                "url": url,
                "domain": _domain(url),
                "title": s.get("title"),
                "snippet": s.get("snippet"),
            }
        )

    messages = [
        {"role": "system", "content": CREDIBILITY_TOOL_PROMPT},
        {"role": "user", "content": json.dumps({"sources": normalized})},
    ]

    response = await llm.ainvoke(messages)
    content = response.content

    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        data = {"items": []}

    return data
