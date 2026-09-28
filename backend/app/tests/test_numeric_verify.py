"""numeric_verify: flag matching, range scoring, and expected_result."""

import pytest

from app.tools.numeric_verify import numeric_verify


def _run(claim, **kwargs):
    return numeric_verify.invoke({"claim_text": claim, **kwargs})


# --------------------------------------------------------------------------
# expected_result was mistyped and unused
# --------------------------------------------------------------------------


def test_expected_result_mismatch_is_detected():
    finding = _run("The death rate fell to 12 per 100000.", expected_result=40.0)[
        "finding"
    ]
    assert "expected_result_mismatch" in finding["flags"]
    assert finding["computed_checks"]["closest_claim_value"] == 12.0
    assert finding["computed_checks"]["delta"] == 28.0


def test_expected_result_match_produces_no_flag():
    finding = _run("The death rate fell to 40 per 100000.", expected_result=40.0)[
        "finding"
    ]
    assert "expected_result_mismatch" not in finding["flags"]


def test_expected_result_omitted_is_fine():
    finding = _run("The death rate fell to 12 per 100000.")["finding"]
    assert "expected_result" not in finding["computed_checks"]


# --------------------------------------------------------------------------
# Substring matching produced false positives
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "claim,flag",
    [
        ("It is always dangerous.", "contains_absolute_or_guarantee_language"),
        ("It is guaranteed safe.", "contains_absolute_or_guarantee_language"),
        ("There is no risk at all.", "contains_absolute_or_guarantee_language"),
        ("This will never happen.", "contains_absolute_or_guarantee_language"),
        ("Growth was 100% this year.", "contains_absolute_or_guarantee_language"),
    ],
)
def test_absolute_language_is_flagged(claim, flag):
    assert flag in _run(claim)["finding"]["flags"]


@pytest.mark.parametrize(
    "claim",
    [
        "It is almost always safe.",  # hedge inverts the meaning
        "It is nearly never true.",
        "We scored 1100% on the test.",  # "100%" appears as a substring
    ],
)
def test_hedges_and_substrings_do_not_false_positive(claim):
    assert (
        "contains_absolute_or_guarantee_language" not in _run(claim)["finding"]["flags"]
    )


def test_out_of_range_percent_flagged():
    assert "percent_out_of_range" in _run("Rates hit 150%.")["finding"]["flags"]


def test_in_range_percent_not_flagged():
    assert "percent_out_of_range" not in _run("Rates hit 15%.")["finding"]["flags"]


# --------------------------------------------------------------------------
# Ranges were computed and then discarded
# --------------------------------------------------------------------------


def test_implausibly_strong_effect_range_is_scored():
    finding = _run("Reduces your cancer risk by 90-95% according to the study.")[
        "finding"
    ]
    assert "implausibly_strong_effect_range" in finding["flags"]
    assert finding["computed_checks"]["ranges"] == [[90.0, 95.0]]
    assert finding["score"] > 0


def test_implausibly_wide_range_is_scored():
    finding = _run("Cuts emissions by 10 to 80 percent.")["finding"]
    assert "implausible_range_width" in finding["flags"]
    assert finding["computed_checks"]["range_spans"] == [70.0]
    assert finding["score"] > 0


def test_ordinary_range_is_not_flagged():
    finding = _run("Costs range from 5 to 8 dollars per month.")["finding"]
    assert "implausible_range_width" not in finding["flags"]
    assert "implausibly_strong_effect_range" not in finding["flags"]
    assert finding["computed_checks"]["ranges"] == [[5.0, 8.0]]


def test_reversed_range_is_normalized():
    finding = _run("Somewhere between 80 and 90 percent of users agreed.")["finding"]
    assert finding["computed_checks"]["ranges"] == [[80.0, 90.0]]


# --------------------------------------------------------------------------
# Currency plus urgency
# --------------------------------------------------------------------------


def test_large_currency_with_urgency_flagged():
    assert (
        "currency_with_urgency_pattern"
        in _run("Claim your $5,000 refund today, limited time offer.")["finding"][
            "flags"
        ]
    )


def test_small_amount_not_flagged():
    assert (
        "currency_with_urgency_pattern"
        not in _run("The fee is $5 per month.")["finding"]["flags"]
    )


# --------------------------------------------------------------------------
# Scoring shape
# --------------------------------------------------------------------------


def test_clean_claim_scores_zero():
    assert _run("The meeting is on Tuesday at 3pm.")["finding"]["score"] == 0.0


def test_score_is_bounded():
    worst = _run(
        "100% guaranteed, never fails, no risk, $9,999 today urgent, 10 to 99 percent"
    )
    assert 0.0 <= worst["finding"]["score"] <= 1.0


def test_more_flag_categories_score_higher():
    """Score scales with distinct flag categories, not phrase hits."""
    mild = _run("This always works.")["finding"]
    worse = _run(
        "This always works, costs $9,999 today, and cuts emissions by 10 to 80 percent."
    )["finding"]
    assert set(worse["flags"]) > set(mild["flags"])
    assert worse["score"] > mild["score"]


def test_repeated_phrase_does_not_inflate_score():
    """The same flag category is counted once regardless of how many phrases hit."""
    once = _run("This always works.")["finding"]
    thrice = _run("This always, always, and always works.")["finding"]
    assert thrice["flags"] == once["flags"]
    assert thrice["score"] == once["score"]
