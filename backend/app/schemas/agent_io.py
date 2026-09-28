from __future__ import annotations
import json
from enum import Enum
from typing import Annotated, Any, Dict, List, Optional
from pydantic import BaseModel, Field, HttpUrl


class Verdict(str, Enum):
    likely_true = "likely_true"
    likely_false = "likely_false"
    mixed = "mixed"
    unverifiable = "unverifiable"


class AgentContext(BaseModel):
    caption: Optional[str] = None
    ocr_text: Optional[str] = None
    urls: Optional[List[HttpUrl]] = Field(default_factory=list)
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict)


class ClaimInput(BaseModel):
    claims: Annotated[List[str], Field(min_length=1)] = Field(
        ..., description="List of claims to assess."
    )
    context: Optional[AgentContext] = None
    request_id: Optional[str] = Field(
        default=None, description="Optional trace id from your API layer."
    )


class EvidenceInput(BaseModel):
    claim_id: int = Field(..., ge=0)
    source_url: Optional[HttpUrl] = None
    source_credibility: Optional[str] = Field(
        default=None,
        description="high|medium|low or a numeric tier if you prefer later.",
    )
    title: Optional[str] = None
    retrieved_at: Optional[str] = Field(
        default=None, description="ISO-8601 timestamp of when the source was retrieved."
    )
    summary: Optional[str] = Field(
        default=None,
        description="Short summary of what this source says about the claim.",
    )
    supporting: Optional[bool] = Field(
        default=None,
        description="True if the source supports the claim, false if it contradicts it.",
    )


class AgentOutput(BaseModel):
    ai_generated_risk_score: Annotated[float, Field(ge=0.0, le=1.0)] = Field(
        ..., description="Risk image/video/text is AI-generated"
    )
    misinformation_risk_score: Annotated[float, Field(ge=0.0, le=1.0)] = Field(
        ..., description="Risk claim is misleading or false"
    )
    verdict: Verdict = Field(..., description="Overall verdict of the claim.")
    confidence: Annotated[float, Field(ge=0.0, le=1.0)] = Field(
        ..., description="Confidence in the verdict."
    )
    reasoning_chain: List[str] = Field(
        default_factory=list, description="Step by step reasoning statements (short)"
    )
    evidence: List[EvidenceInput] = Field(
        default_factory=list, description="Evidence items used in synthesis."
    )
    uncertainties: List[str] = Field(
        default_factory=list, description="What could not be verified or was uncertain."
    )
    explanation: str = Field(
        default="",
        description="Human-readable explanation of why this post was flagged or cleared.",
    )
    tool_rounds: Annotated[int, Field(ge=0)] = Field(
        default=0,
        description="Number of tool-use rounds the agent needed. Diagnostic only.",
    )
    # Written by app.agents.langchain_agent.apply_credibility_weighting, never
    # trusted from the model: the share of total source weight that supports the
    # claim, or None when no evidence carried a usable credibility tier.
    credibility_weighted_support: Optional[float] = None


def _type_label(schema: Dict[str, Any], defs: Dict[str, Any] | None = None) -> str:
    """Human-readable type name for a JSON-schema fragment."""
    defs = defs or {}
    if "$ref" in schema:
        name = schema["$ref"].rsplit("/", 1)[-1]
        target = defs.get(name)
        if target is not None:
            if "enum" in target:
                return " | ".join(json.dumps(v) for v in target["enum"])
            if target.get("type") == "object":
                return "object"
        return name
    if "anyOf" in schema:
        inner = [t for t in schema["anyOf"] if t.get("type") != "null"]
        if len(inner) == 1:
            return _type_label(inner[0], defs)
        return " | ".join(_type_label(t, defs) for t in inner)
    if "enum" in schema:
        return " | ".join(json.dumps(v) for v in schema["enum"])
    if schema.get("type") == "array":
        return f"array<{_type_label(schema.get('items', {}), defs)}>"
    if schema.get("type") == "object":
        return "object"
    return str(schema.get("type", "any"))


def render_json_contract(model: type[BaseModel], indent: str = "  ") -> str:
    """Render a Pydantic model as a compact, prompt-friendly JSON contract.

    The prompt's "exact shape" block is generated from this rather than
    hand-written. Because both come from the same Pydantic model that validates
    the agent's real output, the documented contract and the enforced schema
    cannot drift apart.
    """
    schema = model.model_json_schema()
    defs = schema.get("$defs", {})
    required = set(schema.get("required", ()))
    lines: list[str] = ["{"]
    for name, prop in schema.get("properties", {}).items():
        label = _type_label(prop, defs)
        optional = "" if name in required else "  // optional"
        lines.append(f'{indent}"{name}": <{label}>{optional},')
    if lines[-1].endswith(","):
        lines[-1] = lines[-1][:-1]
    lines.append("}")
    return "\n".join(lines)


AGENT_OUTPUT_JSON_CONTRACT = render_json_contract(AgentOutput)
EVIDENCE_JSON_CONTRACT = render_json_contract(EvidenceInput)
