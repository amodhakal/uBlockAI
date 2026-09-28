"""Web search tooling.

Retrieval is provider-first (Brave) with a DuckDuckGo HTML fallback. Both paths
are fully async: the previous implementation issued a blocking ``requests.post``
from inside an async tool, freezing the entire event loop for up to 12 seconds
per query.
"""

import asyncio
import json
import re
import urllib.parse
from typing import Any, Dict, List, Optional

import httpx
from bs4 import BeautifulSoup
from langchain_core.tools import tool

from app.agents.prompts import WEB_SEARCH_TOOL_PROMPT
from app.config import get_settings

_DDG_URL = "https://duckduckgo.com/html/"
BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"

REQUEST_TIMEOUT_SECONDS = 12.0
# The planner rarely produces more than a couple of useful queries; capping
# keeps the fan-out bounded.
MAX_CONCURRENT_QUERIES = 3
MAX_QUERIES_PER_CLAIM = 3


class SearchRateLimitedError(RuntimeError):
    """The search provider rejected the request with HTTP 429.

    Distinct from "no results". A rate limit means we do not know whether
    evidence exists, so callers must not treat it as a negative finding.
    """


class SearchUnavailableError(RuntimeError):
    """All configured search providers failed."""


def _get_llm():
    from app.llm import get_chat_model

    return get_chat_model(timeout=60.0)


# --------------------------------------------------------------------------
# DuckDuckGo HTML fallback
# --------------------------------------------------------------------------

def parse_ddg_html(html: str, top_k: int = 5) -> List[Dict[str, str]]:
    """Parse DuckDuckGo's HTML endpoint into result dicts.

    Each result's snippet is read from within that result's own container.
    Previously the links and snippets were extracted with two independent
    regexes over the whole document and then paired by list index, so any
    extra or missing snippet silently shifted every subsequent pairing and
    attached the wrong text to the wrong result.
    """
    soup = BeautifulSoup(html, "html.parser")
    results: List[Dict[str, str]] = []

    for node in soup.select("div.result, div.web-result"):
        anchor = node.select_one("a.result__a")
        if anchor is None:
            continue
        href = anchor.get("href")
        if not href:
            continue

        url = _unwrap_ddg_redirect(href)
        title = _clean_text(anchor.get_text(" ", strip=True))
        snippet_node = node.select_one(
            ".result__snippet, .result__excerpt, div.result__excerpt"
        )
        snippet = (
            _clean_text(snippet_node.get_text(" ", strip=True))
            if snippet_node
            else ""
        )

        if not url or not title:
            continue
        results.append({"url": url, "title": title, "snippet": snippet})
        if len(results) >= top_k:
            break

    return results


def _unwrap_ddg_redirect(href: str) -> str:
    """DuckDuckGo wraps results in a /l/?uddg=<encoded> redirect."""
    if not href.startswith("//duckduckgo.com/l/") and "/l/?" not in href:
        return href
    parsed = urllib.parse.urlparse(href if href.startswith("http") else f"https:{href}")
    target = urllib.parse.parse_qs(parsed.query).get("uddg")
    return target[0] if target else href


def _clean_text(value: Optional[str]) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip()


async def ddg_search(query: str, top_k: int = 5) -> List[Dict[str, str]]:
    """Query DuckDuckGo's HTML endpoint without blocking the event loop."""
    async with httpx.AsyncClient(
        timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=True
    ) as client:
        response = await client.post(
            _DDG_URL,
            data={"q": query},
            headers={"User-Agent": _UA},
        )
    if response.status_code == 429:
        raise SearchRateLimitedError("DuckDuckGo rate-limited the request")
    response.raise_for_status()
    return parse_ddg_html(response.text, top_k=top_k)


# --------------------------------------------------------------------------
# Brave (primary provider)
# --------------------------------------------------------------------------

async def brave_search(query: str, top_k: int = 5) -> List[Dict[str, str]]:
    """Query the Brave Search API, raising on throttling instead of hiding it."""
    settings = get_settings()
    if not settings.brave_api_key:
        raise SearchUnavailableError("BRAVE_API_KEY is not configured")

    headers = {
        "Accept": "application/json",
        "X-Subscription-Token": settings.brave_api_key,
        "User-Agent": _UA,
    }
    params = {"q": query, "count": min(top_k, 10), "safesearch": "moderate"}

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        response = await client.get(
            BRAVE_SEARCH_URL, headers=headers, params=params
        )

    if response.status_code == 429:
        raise SearchRateLimitedError("Brave Search rate-limited the request")

    response.raise_for_status()
    data = response.json()

    items: List[Dict[str, str]] = []
    for res in (data.get("web", {}) or {}).get("results", [])[:top_k]:
        url = res.get("url")
        if url:
            items.append(
                {
                    "url": url,
                    "title": res.get("title") or "",
                    "snippet": res.get("description") or "",
                }
            )
    return items


async def _search_one(query: str, top_k: int) -> List[Dict[str, str]]:
    """Run one query against Brave, falling back to DuckDuckGo on failure."""
    try:
        return await brave_search(query, top_k=top_k)
    except SearchRateLimitedError:
        # Do not silently fall through to a second provider here: the caller
        # needs to know the result is incomplete. Surfaced by the caller.
        raise
    except Exception:
        return await ddg_search(query, top_k=top_k)


async def search_many(queries: List[str], top_k: int = 5) -> List[Dict[str, str]]:
    """Run every planned query concurrently and merge the results by URL.

    Previously these ran in a sequential for-loop, so total latency was the sum
    of every query rather than the slowest one.
    """
    unique_queries = list(dict.fromkeys(q for q in queries if q.strip()))
    if not unique_queries:
        return []

    semaphore = asyncio.Semaphore(MAX_CONCURRENT_QUERIES)

    async def _bounded(query: str) -> List[Dict[str, str]]:
        async with semaphore:
            return await _search_one(query, top_k)

    settled = await asyncio.gather(
        *(_bounded(q) for q in unique_queries), return_exceptions=True
    )

    merged: Dict[str, Dict[str, str]] = {}
    rate_limited = False
    failures: List[str] = []

    for outcome in settled:
        if isinstance(outcome, SearchRateLimitedError):
            rate_limited = True
            continue
        if isinstance(outcome, BaseException):
            failures.append(f"{type(outcome).__name__}: {outcome}")
            continue
        for item in outcome:
            merged.setdefault(item["url"], item)

    if not merged and failures and not rate_limited:
        raise SearchUnavailableError("; ".join(failures[:3]))

    _record_state(rate_limited, failures)
    return list(merged.values())


# Module-level record of the most recent search outcome, so the tool can report
# rate limiting explicitly instead of it being indistinguishable from "no
# results". Guarded by the event loop's single-threaded execution.
_LAST_SEARCH_STATE: Dict[str, Any] = {"rate_limited": False, "errors": []}


def _record_state(rate_limited: bool, errors: List[str]) -> None:
    _LAST_SEARCH_STATE["rate_limited"] = rate_limited
    _LAST_SEARCH_STATE["errors"] = errors


def last_search_state() -> Dict[str, Any]:
    return dict(_LAST_SEARCH_STATE)


# --------------------------------------------------------------------------
# LLM planning / selection
# --------------------------------------------------------------------------

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

    response = await _get_llm().ainvoke(messages)
    content = response.content

    try:
        data = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return {
            "queries": [claim_text[:120]],
            "selected": [],
            "notes": ["search planner returned unparseable output"],
        }

    if not isinstance(data, dict):
        return {
            "queries": [claim_text[:120]],
            "selected": [],
            "notes": ["search planner returned a non-object payload"],
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
        top_k: Number of results to retrieve per query (default 5)
        prior_queries: List of queries already tried

    Returns:
        Dict with queries, selected results, notes, and a rate_limited flag.
        rate_limited is true when the provider throttled us, which means the
        result set is incomplete rather than empty.
    """
    prior_queries = prior_queries or []

    if not claim_text:
        return {
            "queries": [],
            "selected": [],
            "notes": ["missing claim text"],
            "rate_limited": False,
        }

    plan = await _llm_plan_selection(claim_text, prior_queries, [])
    queries: List[str] = [
        q for q in (plan.get("queries") or []) if isinstance(q, str) and q.strip()
    ]
    if not queries:
        queries = [claim_text[:120]]
    queries = queries[:MAX_QUERIES_PER_CLAIM]

    try:
        results = await search_many(queries, top_k=top_k)
    except SearchRateLimitedError as exc:
        return {
            "queries": queries,
            "selected": [],
            "notes": [f"search rate-limited: {exc}"],
            "rate_limited": True,
        }
    except SearchUnavailableError as exc:
        return {
            "queries": queries,
            "selected": [],
            "notes": [f"all search providers failed: {exc}"],
            "rate_limited": False,
        }

    state = last_search_state()
    selection = await _llm_plan_selection(claim_text, prior_queries, results)
    selection["queries"] = queries
    selection.setdefault("notes", [])
    selection["notes"].append(f"retrieved_results={len(results)}")
    if state["rate_limited"]:
        selection["notes"].append(
            "at least one query was rate-limited; results are incomplete"
        )
    selection["rate_limited"] = state["rate_limited"]

    return selection
