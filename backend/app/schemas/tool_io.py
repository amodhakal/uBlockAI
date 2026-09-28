from __future__ import annotations
from typing import Annotated, Any, Dict, List, Optional
from pydantic import BaseModel, Field, HttpUrl


class WebSearchInput(BaseModel):
    claim_text: str = Field(..., min_length=1)
    # top_k is a count, not a float. It was typed as a bounded float, which
    # accepted and silently rounded values like 2.7.
    top_k: Annotated[int, Field(ge=1, le=10)] = 5
    prior_queries: List[str] = Field(default_factory=list)


class WebSearchResult(BaseModel):
    title: Optional[str] = None
    url: HttpUrl
    # Was misspelled "snipped", so the snippet never round-tripped.
    snippet: Optional[str] = None


class WebSearchOutput(BaseModel):
    claim_text: str
    queries: List[str] = Field(default_factory=list)
    selected: List[WebSearchResult] = Field(default_factory=list)
    notes: List[str] = Field(default_factory=list)
    # True when the search provider rate-limited us. Distinct from "no results":
    # callers must not treat a 429 as evidence that nothing exists.
    rate_limited: bool = False


class CredibilityItem(BaseModel):
    url: HttpUrl
    domain: str
    tier: str = Field(..., description="high|medium|low")
    rationale: Optional[str] = None
    signals: List[str] = Field(default_factory=list)
    # Numeric weight derived from ``tier`` by app.tools.credibility_tool, never
    # by the model. Synthesizers that need a number must not re-derive it.
    weight: Annotated[float, Field(ge=0.0, le=1.0)] = 0.0


class CredibilityOutput(BaseModel):
    items: List[CredibilityItem] = Field(default_factory=list)
    # Aggregates over the weights above, so a caller that only sees the
    # aggregate still knows how much credibility the source set carried.
    tier_counts: Dict[str, int] = Field(default_factory=dict)
    mean_weight: Optional[float] = Field(
        default=None,
        description="Mean numeric weight across the rated items, or None if none were rated.",
    )


class NumericVerifyInput(BaseModel):
    claim_text: str = Field(..., min_length=1)
    expected_result: Optional[float] = None


class NumericFinding(BaseModel):
    extracted_numbers: List[str] = Field(
        default_factory=list, description="Raw numeric strings found"
    )
    flags: List[str] = Field(
        default_factory=list,
        description="Issues found (unit mismatch, impossible scale, etc.).",
    )
    computed_checks: Dict[str, Any] = Field(
        default_factory=dict, description="Any computed values used for verification."
    )
    score: Annotated[float, Field(ge=0.0, le=1.0)] = Field(
        default=0.0,
        description="How suspicious the numerical component is (0=clean, 1=very suspicious).",
    )


class NumericVerifyOutput(BaseModel):
    claim_text: str
    finding: NumericFinding
