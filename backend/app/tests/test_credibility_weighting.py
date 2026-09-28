"""Deterministic credibility-tier weighting (#85).

The tier still comes from the model; the weight attached to it, and the
arithmetic that uses that weight, do not.
"""

import pytest

from app.agents.langchain_agent import (
    MAX_CORRECTION,
    apply_credibility_weighting,
    weighted_support,
)
from app.schemas.agent_io import AgentOutput, EvidenceInput
from app.tools.credibility_tool import (
    TIER_WEIGHTS,
    rate_sources,
    weight_for_tier,
)


def _output(evidence, score=0.5):
    return AgentOutput(
        ai_generated_risk_score=0.1,
        misinformation_risk_score=score,
        verdict="mixed",
        confidence=0.5,
        evidence=evidence,
    )


def _evidence(tier, supporting, claim_id=0):
    return EvidenceInput(
        claim_id=claim_id,
        source_url="https://example.com",
        source_credibility=tier,
        supporting=supporting,
    )


# --------------------------------------------------------------------------
# The tier -> weight mapping
# --------------------------------------------------------------------------


def test_tier_weights_are_the_documented_numbers():
    assert TIER_WEIGHTS == {"high": 1.0, "medium": 0.5, "low": 0.2}


@pytest.mark.parametrize(
    "tier,expected",
    [
        ("high", 1.0),
        ("medium", 0.5),
        ("low", 0.2),
        ("HIGH", 1.0),
        ("  Medium  ", 0.5),
    ],
)
def test_known_tiers_map_to_their_weight(tier, expected):
    assert weight_for_tier(tier) == expected


@pytest.mark.parametrize("tier", [None, "", "excellent", "unrated", "0.9"])
def test_unrated_tiers_weigh_nothing(tier):
    # An invented tier must not borrow credibility from "high".
    assert weight_for_tier(tier) == 0.0


def test_rater_output_gains_weights_and_aggregates():
    rated = rate_sources(
        {
            "items": [
                {"url": "https://a.gov", "domain": "a.gov", "tier": "high"},
                {"url": "https://b.com", "domain": "b.com", "tier": "low"},
            ]
        }
    )
    assert [item.weight for item in rated.items] == [1.0, 0.2]
    assert rated.tier_counts == {"high": 1, "low": 1}
    assert rated.mean_weight == pytest.approx(0.6)


def test_aggregates_ignore_unrated_items():
    rated = rate_sources(
        {
            "items": [
                {"url": "https://a.gov", "domain": "a.gov", "tier": "high"},
                {"url": "https://b.com", "domain": "b.com", "tier": "excellent"},
            ]
        }
    )
    assert rated.mean_weight == pytest.approx(1.0)
    assert rated.items[1].weight == 0.0


def test_nothing_rated_means_no_mean():
    assert rate_sources({"items": []}).mean_weight is None


def test_malformed_items_are_dropped_not_guessed():
    rated = rate_sources(
        {
            "items": [
                {"domain": "a.gov", "tier": "high"},  # no url
                {"url": "not a url", "domain": "x", "tier": "high"},
                "nonsense",
                {"url": "https://ok.com", "domain": "ok.com", "tier": "medium"},
            ]
        }
    )
    assert [item.domain for item in rated.items] == ["ok.com"]


# --------------------------------------------------------------------------
# Weighted support
# --------------------------------------------------------------------------


def test_a_high_tier_source_outweighs_two_low_tier_ones():
    evidence = [
        _evidence("high", True),
        _evidence("low", False),
        _evidence("low", False),
    ]
    # 1.0 / (1.0 + 0.2 + 0.2) -- one credible source is most of the weight.
    assert weighted_support(evidence) == pytest.approx(1 / 1.4)


def test_unrated_evidence_cannot_dilute_the_denominator():
    evidence = [
        _evidence("high", True),
        _evidence("excellent", False),
        _evidence(None, True),
    ]
    assert weighted_support(evidence) == pytest.approx(1.0)


def test_no_rated_evidence_is_none_not_zero():
    assert weighted_support([]) is None
    assert weighted_support([_evidence("excellent", False)]) is None
    # Rating without a stance is not support either.
    assert (
        weighted_support([EvidenceInput(claim_id=0, source_credibility="high")]) == 0.0
    )


# --------------------------------------------------------------------------
# The post-processed score
# --------------------------------------------------------------------------


def test_the_score_moves_toward_contradicting_evidence():
    result = apply_credibility_weighting(_output([_evidence("high", False)], score=0.2))
    # Everything rated contradicts the claim, so the score rises, but only
    # within the correction cap.
    assert result.misinformation_risk_score > 0.2
    assert result.misinformation_risk_score <= 0.2 + MAX_CORRECTION
    assert result.credibility_weighted_support == pytest.approx(0.0)


def test_the_score_falls_when_only_credible_sources_support_the_claim():
    result = apply_credibility_weighting(_output([_evidence("high", True)], score=0.8))
    assert result.misinformation_risk_score < 0.8
    assert result.credibility_weighted_support == pytest.approx(1.0)


def test_the_correction_is_capped():
    # All low-credibility support against a maximal score: the cap holds.
    result = apply_credibility_weighting(
        _output([_evidence("low", True), _evidence("low", True)], score=1.0)
    )
    assert result.misinformation_risk_score == pytest.approx(1.0 - MAX_CORRECTION)


def test_the_score_stays_in_range():
    result = apply_credibility_weighting(
        _output([_evidence("high", False)], score=0.99)
    )
    assert 0.0 <= result.misinformation_risk_score <= 1.0


def test_a_tier_free_evidence_set_leaves_the_score_untouched():
    original = _output([_evidence("excellent", True)], score=0.42)
    result = apply_credibility_weighting(original)
    assert result.misinformation_risk_score == 0.42
    assert result.credibility_weighted_support is None
    # No audit line: nothing was adjusted.
    assert result.reasoning_chain == []


def test_the_adjustment_is_recorded_in_the_reasoning_chain():
    result = apply_credibility_weighting(_output([_evidence("high", False)], score=0.2))
    assert any("weighted support" in step for step in result.reasoning_chain)


def test_the_model_cannot_claim_its_own_weighting():
    """A model-supplied support value is overwritten, not trusted."""
    output = _output([_evidence("high", False)], score=0.2)
    output.credibility_weighted_support = 0.99
    result = apply_credibility_weighting(output)
    assert result.credibility_weighted_support == pytest.approx(0.0)


def test_the_verdict_and_other_scores_are_not_touched():
    result = apply_credibility_weighting(_output([_evidence("high", False)], score=0.2))
    assert result.verdict.value == "mixed"
    assert result.ai_generated_risk_score == 0.1
    assert result.confidence == 0.5
