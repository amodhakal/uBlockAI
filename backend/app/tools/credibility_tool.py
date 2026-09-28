"""Source credibility tiering, with the numeric weighting made deterministic.

The model is still asked for a tier, because judgement about a source is not
something a lookup table can do. The *weight* that tier carries, though, used
to be a matter of prompt compliance: the system prompt said to weight
higher-credibility sources more heavily and left it there. "More heavily" is not
a number, so the same evidence could be synthesized two different ways.

The mapping from tier to weight therefore lives here, in code, and every
consumer of a tier goes through :func:`weight_for_tier`. The model cannot
influence the weight, only the tier it is derived from.
"""

import json
import logging
from collections import Counter
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse
from langchain_core.tools import tool
from pydantic import ValidationError

from app.agents.prompts import CREDIBILITY_TOOL_PROMPT
from app.schemas.tool_io import CredibilityItem, CredibilityOutput

logger = logging.getLogger(__name__)

# Tier -> weight. High is fully trusted, low is a tenth of that, and the gap
# between high and low is deliberately wide: a single low-tier source should
# not move a verdict that a high-tier source contradicts, which is exactly the
# weighting the prompt used to leave to interpretation.
TIER_WEIGHTS: Dict[str, float] = {
    "high": 1.0,
    "medium": 0.5,
    "low": 0.2,
}

# A source the rater could not place, or that arrived with a tier name outside
# the vocabulary above ("excellent", "unknown", ""). It contributes no weight:
# silently treating an unrated source as credible would let a hallucinated tier
# buy influence.
UNRATED_WEIGHT = 0.0


def weight_for_tier(tier: Optional[str]) -> float:
    """Return the numeric weight for a credibility tier.

    Unrated or unrecognized tiers weigh 0.0 and are excluded from aggregates,
    so an invented tier name cannot borrow credibility from "high".
    """
    if not tier:
        return UNRATED_WEIGHT
    return TIER_WEIGHTS.get(str(tier).strip().casefold(), UNRATED_WEIGHT)


def _get_llm():
    from app.llm import get_chat_model

    return get_chat_model(timeout=60.0)


def _domain(u: str) -> str:
    return (urlparse(u).netloc or "").lower().replace("www.", "")


def _signal_list(raw: Any) -> List[str]:
    """Coerce the model's ``signals`` field, which is sometimes a bare string."""
    if isinstance(raw, str):
        return [raw]
    if not isinstance(raw, list):
        return []
    return [str(signal) for signal in raw]


def rate_sources(data: Any) -> CredibilityOutput:
    """Turn raw rater output into validated items with weights and aggregates.

    The raw payload is whatever the model emitted: missing keys, items without
    a URL, tiers outside the vocabulary. Validating here means a downstream
    synthesizer can index ``item.weight`` without re-checking the tier, and the
    aggregate is computed once, in one place.
    """
    raw_items = []
    if isinstance(data, dict):
        candidate = data.get("items")
        if isinstance(candidate, list):
            raw_items = candidate

    validated: List[CredibilityItem] = []
    for raw in raw_items:
        if not isinstance(raw, dict) or not raw.get("url"):
            continue
        try:
            item = CredibilityItem(
                url=raw["url"],
                domain=str(raw.get("domain") or _domain(str(raw["url"]))),
                # Required: a source the rater could not place is not a source
                # with a guessed tier.
                tier=str(raw["tier"]),
                rationale=raw.get("rationale"),
                signals=_signal_list(raw.get("signals")),
            )
        except (ValidationError, KeyError, TypeError):
            # A malformed item is dropped, not guessed at: an invented domain
            # or a missing tier must not become a rated source.
            logger.debug("dropping unusable credibility item: %s", raw)
            continue
        validated.append(item.model_copy(update={"weight": weight_for_tier(item.tier)}))

    rated = [item for item in validated if item.weight > 0]
    return CredibilityOutput(
        items=validated,
        tier_counts=dict(Counter(item.tier for item in validated)),
        mean_weight=(sum(item.weight for item in rated) / len(rated))
        if rated
        else None,
    )


@tool
async def credibility_llm(sources: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    LLM-based credibility tiering for sources using url/title/snippet.

    Args:
        sources: List of sources with url, title, and snippet

    Returns:
        Dict with items containing url, domain, tier, weight, rationale and
        signals, plus tier_counts and mean_weight over the weights
    """
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

    logger.debug("rating credibility for %d sources", len(normalized))

    messages = [
        {"role": "system", "content": CREDIBILITY_TOOL_PROMPT},
        {"role": "user", "content": json.dumps({"sources": normalized})},
    ]

    response = await _get_llm().ainvoke(messages)
    content = response.content

    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        logger.warning(
            "credibility rater returned non-JSON output; treating as unrated"
        )
        data = {"items": []}

    rated = rate_sources(data)
    return rated.model_dump()
