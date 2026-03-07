import json
import re
from typing import Any, Dict, List, Optional
import os
import httpx
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from app.agents.prompts import WEB_SEARCH_TOOL_PROMPT


_DDG_URL = "https://duckduckgo.com/html/"
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Agent/1.0"

llm = ChatOpenAI(model="gpt-5-main", temperature=0)


def ddg_search(query: str, top_k: int = 5):
    import requests

    r = requests.post(
        _DDG_URL, data={"q": query}, headers={"User-Agent": _UA}, timeout=12
    )
    r.raise_for_status()
    html = r.text
    link_re = re.compile(
        r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', re.IGNORECASE
    )
    snippet_re = re.compile(
        r'<a[^>]+class="result__snippet"[^>]*>(.*?)</a>|<div[^>]+class="result__snippet"[^>]*>(.*?)</div>',
        re.IGNORECASE,
    )

    links = link_re.findall(html)
    snippets = snippet_re.findall(html)

    results: List[Dict[str, str]] = []
    for i, (url, title) in enumerate(links):
        if len(results) >= top_k:
            break

        title = re.sub("<.*?>", "", title).strip()
        snippet = ""
        if i < len(snippets):
            snippet_raw = snippets[i][0] or snippets[i][1] or ""
            snippet = re.sub("<.*?>", "", snippet_raw).strip()
        results.append({"url": url, "title": title, "snippet": snippet})
    return results


BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"


async def brave_search(query: str, top_k: int = 5) -> List[Dict[str, str]]:
    api_key = os.getenv("BRAVE_API_KEY")
    if not api_key:
        raise RuntimeError("Missing BRAVE_API_KEY env var")

    headers = {
        "Accept": "application/json",
        "X-Subscription-Token": api_key,
        "User-Agent": _UA,
    }
    params = {
        "q": query,
        "count": min(top_k, 10),
        "safesearch": "moderate",
    }

    async with httpx.AsyncClient(timeout=12.0) as client:
        r = await client.get(BRAVE_SEARCH_URL, headers=headers, params=params)

    print("Brave status:", r.status_code, "query:", query)
    if r.status_code == 429:
        return []

    r.raise_for_status()
    data = r.json()

    items = []
    for res in (data.get("web", {}) or {}).get("results", [])[:top_k]:
        url = res.get("url")
        title = res.get("title") or ""
        snippet = res.get("description") or ""
        if url:
            items.append({"url": url, "title": title, "snippet": snippet})
    return items


async def _llm_plan_selection(
    claim_text: str, prior_queries: List[str], search_results: List[Dict]
) -> Dict[str, Any]:
    messages = [
        {"role": "system", "content": WEB_SEARCH_TOOL_PROMPT},
        {
            "role": "user",
            "content": json.dumps(
                {
                    "claim_text": claim_text,
                    "prior_queries": prior_queries,
                    "search_results": search_results,
                }
            ),
        },
    ]

    response = await llm.ainvoke(messages)
    content = response.content

    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        data = {
            "queries": [claim_text[:120]],
            "selected": [],
            "notes": ["JSON parse failed"],
        }

    return data


@tool
async def web_search_llm(
    claim_text: str, top_k: int = 5, prior_queries: Optional[List[str]] = None
) -> Dict[str, Any]:
    """
    LLM-assisted web search: generates queries to search on web, retrieves results, selects best evidence candidates from snippets.

    Args:
        claim_text: The claim to search for
        top_k: Number of results to retrieve (default 5)
        prior_queries: List of queries already tried

    Returns:
        Dict with queries, selected results, and notes
    """
    prior_queries = prior_queries or []

    if not claim_text:
        return {"queries": [], "selected": [], "notes": ["missing claim text"]}

    plan = await _llm_plan_selection(claim_text, prior_queries, [])
    queries = plan.get("queries", [])

    if not queries:
        queries = [claim_text[:120]]

    print(f"Generated queries: {queries}")

    queries = queries[:2]
    merged: Dict[str, Dict[str, str]] = {}

    for q in queries:
        try:
            results = await brave_search(q, top_k=top_k)
        except Exception as e:
            print(f"Brave search failed, falling back to DuckDuckGo: {e}")
            results = ddg_search(q, top_k)

        for item in results:
            merged[item["url"]] = item

    results = list(merged.values())

    selection = await _llm_plan_selection(claim_text, prior_queries, results)

    selection["queries"] = queries
    selection.setdefault("notes", [])
    selection["notes"].append(f"retrieved_results={len(results)}")
    print(f"Final selection: {selection}")

    return selection
