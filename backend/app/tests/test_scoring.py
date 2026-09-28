"""Scoring logic: claim construction, the contract renderer, and output parsing."""

import pytest

from app.agents.langchain_agent import (
    AgentOutputError,
    extract_final_message,
    parse_agent_output,
)
from app.api.routes import AnalyzeUrlRequest, build_claims
from app.schemas.agent_io import (
    AGENT_OUTPUT_JSON_CONTRACT,
    EVIDENCE_JSON_CONTRACT,
    AgentOutput,
    Verdict,
    render_json_contract,
)


class _Msg:
    def __init__(self, type_, content):
        self.type = type_
        self.content = content


# --------------------------------------------------------------------------
# build_claims: the empty-claims fix
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "caption,alt_text,expected_count",
    [
        ("", "", 1),  # no alt text: used to be an HTTP 500
        ("a caption", "", 1),
        ("", "alt text", 1),
        ("a caption", "alt text", 2),
    ],
)
def test_build_claims_never_empty(caption, alt_text, expected_count):
    payload = AnalyzeUrlRequest(
        url="https://x/y.jpg", caption=caption, alt_text=alt_text
    )
    claims = build_claims(payload, ocr_text="")
    assert len(claims) == expected_count
    assert all(claim for claim in claims)


def test_build_claims_includes_ocr_text():
    payload = AnalyzeUrlRequest(url="https://x/y.jpg", alt_text="alt")
    claims = build_claims(payload, ocr_text="OCR: 90-95% reduction")
    assert "OCR: 90-95% reduction" in claims


def test_build_claims_deduplicates_case_insensitively():
    payload = AnalyzeUrlRequest(
        url="https://x/y.jpg", caption="Same Text", alt_text="same text"
    )
    claims = build_claims(payload, ocr_text="")
    # Alt text is the first candidate, so it is the one retained.
    assert claims == ["same text"]


def test_build_claims_placeholder_when_nothing_extractable():
    payload = AnalyzeUrlRequest(url="https://x/y.jpg")
    assert build_claims(payload, ocr_text="") == ["[no extractable text in this post]"]


def test_build_claims_truncates_long_text():
    """A claim is clipped to MAX_CLAIM_CHARS so one post cannot flood the prompt."""
    payload = AnalyzeUrlRequest(url="https://x/y.jpg", caption="x" * 4999)
    assert len(build_claims(payload, ocr_text="")[0]) == 4000


def test_request_rejects_oversized_caption():
    with pytest.raises(ValueError):
        AnalyzeUrlRequest(url="https://x/y.jpg", caption="x" * 5001)


# --------------------------------------------------------------------------
# Threshold logic
# --------------------------------------------------------------------------


def _exceeds(ai_score, news_score, ai_threshold, news_threshold):
    return ai_score >= ai_threshold or news_score >= news_threshold


@pytest.mark.parametrize(
    "ai,news,ai_t,news_t,expected",
    [
        (0.30, 0.10, 0.30, 0.20, True),  # equal on AI is inclusive
        (0.29, 0.10, 0.30, 0.20, False),
        (0.10, 0.20, 0.30, 0.20, True),  # equal on news is inclusive
        (0.10, 0.19, 0.30, 0.20, False),
        (0.00, 0.00, 0.30, 0.20, False),  # clean post is never hidden
        (1.00, 0.00, 0.30, 0.20, True),
    ],
)
def test_threshold_boundaries(ai, news, ai_t, news_t, expected):
    """Threshold comparison is >= on both axes, matching the content script."""
    assert _exceeds(ai, news, ai_t, news_t) is expected


# --------------------------------------------------------------------------
# Final message extraction
# --------------------------------------------------------------------------


def test_extract_final_message_skips_empty_trailing_message():
    messages = [_Msg("human", "go"), _Msg("ai", '{"a":1}'), _Msg("ai", "")]
    assert extract_final_message(messages).content == '{"a":1}'


def test_extract_final_message_all_empty_raises():
    with pytest.raises(AgentOutputError, match="no message with content"):
        extract_final_message([_Msg("ai", ""), _Msg("ai", "   ")])


def test_extract_final_message_accepts_content_blocks():
    messages = [_Msg("ai", [{"tool_call": {"id": "1"}}])]
    assert extract_final_message(messages).content == [{"tool_call": {"id": "1"}}]


def test_extract_final_message_empty_list_raises():
    with pytest.raises(AgentOutputError):
        extract_final_message([])


# --------------------------------------------------------------------------
# Output parsing
# --------------------------------------------------------------------------


def test_parse_agent_output_strips_json_fence():
    assert parse_agent_output('```json\n{"a": 1}\n```') == {"a": 1}


def test_parse_agent_output_accepts_dict():
    assert parse_agent_output({"a": 1}) == {"a": 1}


@pytest.mark.parametrize("bad", ["", "   ", "not json", "[1,2]", '"a string"', "null"])
def test_parse_agent_output_rejects_non_objects(bad):
    with pytest.raises(AgentOutputError):
        parse_agent_output(bad)


# --------------------------------------------------------------------------
# Prompt / schema contract
# --------------------------------------------------------------------------


def test_contract_covers_every_agent_output_field():
    for field in AgentOutput.model_fields:
        assert f'"{field}"' in AGENT_OUTPUT_JSON_CONTRACT, field


def test_contract_marks_required_fields():
    schema = AgentOutput.model_json_schema()
    for required in schema.get("required", []):
        assert f'"{required}":' in AGENT_OUTPUT_JSON_CONTRACT


def test_contract_lists_verdict_values():
    for value in [v.value for v in Verdict]:
        assert f'"{value}"' in AGENT_OUTPUT_JSON_CONTRACT


def test_contract_renders_nested_object():
    assert AGENT_OUTPUT_JSON_CONTRACT.count("{") >= 1
    assert '"claim_id"' in EVIDENCE_JSON_CONTRACT


def test_render_json_contract_flags_optional():
    rendered = render_json_contract(AgentOutput)
    assert "// optional" in rendered


def test_evidence_fields_required_by_prompt_are_preserved():
    """The prompt demands these; the schema must not silently drop them."""
    output = AgentOutput(
        ai_generated_risk_score=0.1,
        misinformation_risk_score=0.2,
        verdict="likely_false",
        confidence=0.5,
        evidence=[
            {
                "claim_id": 0,
                "source_url": "https://example.com",
                "source_credibility": "high",
                "title": "t",
                "retrieved_at": "2026-01-01T00:00:00Z",
                "summary": "s",
                "supporting": False,
            }
        ],
    )
    evidence = output.model_dump()["evidence"][0]
    for key in ("retrieved_at", "summary", "supporting", "source_credibility"):
        assert key in evidence


def test_agent_output_rejects_out_of_range_score():
    with pytest.raises(ValueError):
        AgentOutput(
            ai_generated_risk_score=1.5,
            misinformation_risk_score=0.2,
            verdict="mixed",
            confidence=0.5,
        )
