import re
from typing import Any, Dict, List, Optional

from langchain_core.tools import tool

from app.schemas.tool_io import (
    NumericVerifyInput,
    NumericVerifyOutput,
    NumericFinding,
)


_NUM_RE = re.compile(
    r"""
    (?:
        (?P<currency>\$)\s*(?P<cur_num>\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?) |
        (?P<percent>\d+(?:\.\d+)?)\s*(?P<pct_sign>%) |
        (?P<number>\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)
    )
    """,
    re.VERBOSE,
)

_RANGE_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)", re.IGNORECASE)

# Each entry is (flag name, phrase). Matching is done on whole words, because
# substring matching produced false positives: "100%" fired inside "1100%".
_ABSOLUTE_PHRASES: tuple[tuple[str, str], ...] = (
    ("contains_absolute_or_guarantee_language", "100%"),
    ("contains_absolute_or_guarantee_language", "guaranteed"),
    ("contains_absolute_or_guarantee_language", "no risk"),
    ("contains_absolute_or_guarantee_language", "always"),
    ("contains_absolute_or_guarantee_language", "never"),
)

# Hedges immediately preceding an absolute phrase defeat it: "almost always"
# and "nearly never" are the opposite of absolute claims.
_HEDGES: tuple[str, ...] = (
    "almost",
    "nearly",
    "virtually",
    "practically",
    "hardly",
    "barely",
    "rarely",
    "seldom",
    "not",
)

_URGENCY_PHRASES: tuple[str, ...] = (
    "today",
    "now",
    "urgent",
    "limited time",
    "within",
)

# A range wider than this many percentage points is implausible for a single
# cited statistic and is a common pattern in fabricated statistics.
_IMPLAUSIBLE_RANGE_SPAN = 50.0
# A range whose floor is at or above this claims an implausibly large effect.
# "reduces your risk by 90-95%" is a hallmark of fabricated health statistics.
_STRONG_EFFECT_FLOOR = 90.0
# Currency at or above this is large enough that it is worth pairing with an
# urgency cue to flag as a likely scam.
_LARGE_CURRENCY = 1_000.0


def _extract_numeric_strings(text: str) -> List[str]:
    found: List[str] = []
    for m in _NUM_RE.finditer(text):
        s = m.group(0).strip()
        if s:
            found.append(s)
    return found


def _to_float(num_str: str) -> float:
    return float(num_str.replace(",", "").replace("$", "").replace("%", "").strip())


def _contains_phrase(haystack: str, phrase: str) -> bool:
    """Whole-word phrase containment, immune to substring false positives."""
    if " " in phrase or "%" in phrase:
        # Multi-word and symbolic phrases cannot be matched on word
        # boundaries, so anchor them at least at their start.
        return re.search(rf"(?<!\w){re.escape(phrase)}(?!\w)", haystack) is not None
    return re.search(rf"\b{re.escape(phrase)}\b", haystack) is not None


def _is_hedged(text: str, phrase: str) -> bool:
    """True when a hedge word immediately precedes ``phrase``."""
    pattern = rf"(?:\b(?:{'|'.join(_HEDGES)})\s+){{1,2}}{re.escape(phrase)}\b"
    return re.search(pattern, text) is not None


def _score(
    flags: List[str],
    *,
    has_out_of_range: bool,
    has_implausible_range: bool,
    expected_mismatch: bool,
) -> float:
    """Turn detected flags into a 0..1 suspiciousness score."""
    if not flags:
        return 0.0
    score = 0.15 * len(flags)
    if has_out_of_range:
        score += 0.2
    if has_implausible_range:
        score += 0.2
    if expected_mismatch:
        score += 0.3
    return min(1.0, score)


@tool
def numeric_verify(
    claim_text: str, expected_result: Optional[float] = None
) -> Dict[str, Any]:
    """
    Verify numeric claims by checking if calculations are correct and identifying suspicious numeric patterns.

    Args:
        claim_text: The text containing the numeric claim to verify
        expected_result: Optional expected result to compare the claim's stated
            figure against. When provided and the claim states a different
            number, an expected_result_mismatch flag is raised.

    Returns:
        Dict with extracted numbers, flags, computed checks, and suspiciousness score
    """
    inp = NumericVerifyInput(claim_text=claim_text, expected_result=expected_result)
    claim = inp.claim_text

    extracted = _extract_numeric_strings(claim)
    flags: List[str] = []
    computed: Dict[str, Any] = {}

    lowered = claim.lower()

    # Flag "too precise" or absolute-certainty patterns, on word boundaries and
    # with hedges excluded, so "almost always" is not read as absolute.
    for flag_name, phrase in _ABSOLUTE_PHRASES:
        if _contains_phrase(lowered, phrase) and not _is_hedged(lowered, phrase):
            if flag_name not in flags:
                flags.append(flag_name)

    # Percent sanity checks.
    percents: List[float] = []
    for s in extracted:
        if "%" in s:
            try:
                percents.append(_to_float(s))
            except ValueError:
                continue

    has_out_of_range = any(p < 0 or p > 100 for p in percents)
    if has_out_of_range:
        flags.append("percent_out_of_range")
    if percents:
        computed["percents"] = percents

    # Detect suspicious ranges like "90-95%" / "10 to 12" and actually score
    # them. Previously the ranges were computed and then discarded unused.
    ranges: List[tuple[float, float]] = []
    for a, b in _RANGE_RE.findall(claim):
        try:
            fa, fb = float(a), float(b)
        except ValueError:
            continue
        lo, hi = min(fa, fb), max(fa, fb)
        ranges.append((lo, hi))
        if hi - lo > _IMPLAUSIBLE_RANGE_SPAN:
            flags.append("implausible_range_width")
        elif lo >= _STRONG_EFFECT_FLOOR:
            flags.append("implausibly_strong_effect_range")

    if ranges:
        computed["ranges"] = [list(r) for r in ranges]
        computed["range_spans"] = [hi - lo for lo, hi in ranges]

    # Compare the stated figure against the caller's expected value.
    expected_mismatch = False
    expected = inp.expected_result
    if expected is not None:
        numbers = [v for v in (_safe_float(s) for s in extracted) if v is not None]
        if numbers:
            closest = min(numbers, key=lambda v: abs(v - expected))
            computed["expected_result"] = expected
            computed["closest_claim_value"] = closest
            delta = abs(closest - expected)
            computed["delta"] = delta
            if delta > 1e-9:
                expected_mismatch = True
                flags.append("expected_result_mismatch")

    # Heuristic: large currency amounts mentioned with urgency often correlate
    # with scams.
    if "$" in claim and any(_contains_phrase(lowered, p) for p in _URGENCY_PHRASES):
        currency_amounts = [
            float(m.group("cur_num").replace(",", ""))
            for m in _NUM_RE.finditer(claim)
            if m.group("currency")
        ]
        if any(amount >= _LARGE_CURRENCY for amount in currency_amounts):
            flags.append("currency_with_urgency_pattern")

    out = NumericVerifyOutput(
        claim_text=claim,
        finding=NumericFinding(
            extracted_numbers=extracted,
            flags=flags,
            computed_checks=computed,
            score=_score(
                flags,
                has_out_of_range=has_out_of_range,
                has_implausible_range=any(f.startswith("implausible") for f in flags),
                expected_mismatch=expected_mismatch,
            ),
        ),
    )
    return out.model_dump()


def _safe_float(num_str: str) -> Optional[float]:
    try:
        return _to_float(num_str)
    except ValueError:
        return None
