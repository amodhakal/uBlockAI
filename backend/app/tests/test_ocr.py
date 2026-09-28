"""OCR heuristics and the OCR grid."""

import pytest

from app.post_classifier import (
    _build_ocr_variants,
    _extract_best_text_from_image,
    _is_grayscale,
    _is_media_container_url,
    _is_reasonable_ocr_line,
    _line_quality_score,
    _ocr_text_score,
    extract_post_text_for_llm,
    resolve_video_poster,
)
from app.tools.web_search_tool import parse_ddg_html


# --------------------------------------------------------------------------
# Video poster frames
# --------------------------------------------------------------------------


def test_resolve_video_poster_accepts_an_allowlisted_frame():
    assert resolve_video_poster("https://scontent.cdninstagram.com/v/t51/p.jpg") == [
        "https://scontent.cdninstagram.com/v/t51/p.jpg"
    ]


def test_resolve_video_poster_accepts_an_extensionless_frame():
    """Real poster URLs often carry no file extension, and rejecting those
    would send most Reels back to the login-walled scrape."""
    assert resolve_video_poster("https://scontent.cdninstagram.com/frame?id=1")


@pytest.mark.parametrize(
    "poster",
    [
        "",
        "   ",
        "https://evil.example/frame.jpg",  # host not on the allowlist
        "https://instagram.com.evil.net/frame.jpg",  # lookalike registrable domain
        "http://169.254.169.254/latest/meta-data/",  # link-local
        "javascript:alert(1)",  # non-http scheme
        "file:///etc/passwd",
        "https://scontent.cdninstagram.com/reel.mp4",  # a container, not a frame
        "https://scontent.cdninstagram.com/" + "a" * 3000,  # oversized
    ],
)
def test_resolve_video_poster_rejects_unsafe_or_unusable(poster):
    assert resolve_video_poster(poster) == []


def test_is_media_container_url_matches_containers_only():
    assert _is_media_container_url("https://cdn.example/a.MP4")
    assert _is_media_container_url("https://cdn.example/audio.m4a")
    assert not _is_media_container_url("https://cdn.example/a.mp4/frame.jpg")
    assert not _is_media_container_url("https://cdn.example/frame.jpg")


def test_a_usable_poster_replaces_the_scrape(monkeypatch):
    """The poster is what gets OCR'd; the post page is never fetched."""
    seen = {}

    def fake_ocr(image_urls, ocr_profile="fast"):
        seen["urls"] = image_urls
        return ("frame text", [])

    def boom(*_args, **_kwargs):
        raise AssertionError("scraped the post even though a poster was supplied")

    monkeypatch.setattr("app.post_classifier._extract_ocr_text", fake_ocr)
    monkeypatch.setattr("app.post_classifier._extract_image_urls", boom)

    result = extract_post_text_for_llm(
        post_url="https://www.instagram.com/reel/ABC/",
        caption="a caption",
        poster_url="https://scontent.cdninstagram.com/v/t51/p.jpg",
    )
    assert seen["urls"] == ["https://scontent.cdninstagram.com/v/t51/p.jpg"]
    assert "frame text" in result["llm-input-text"]


def test_an_unusable_poster_falls_back_to_the_scrape(monkeypatch):
    seen = {}

    def fake_extract(post_url, max_images=3):
        seen["post_url"] = post_url
        return ["https://scontent.cdninstagram.com/scraped.jpg"]

    monkeypatch.setattr("app.post_classifier._extract_image_urls", fake_extract)
    monkeypatch.setattr(
        "app.post_classifier._extract_ocr_text",
        lambda urls, ocr_profile="fast": ("", []),
    )

    extract_post_text_for_llm(
        post_url="https://www.instagram.com/reel/ABC/",
        poster_url="https://evil.example/frame.jpg",
    )
    assert seen["post_url"] == "https://www.instagram.com/reel/ABC/"


# --------------------------------------------------------------------------
# Grayscale detection drives the grid size
# --------------------------------------------------------------------------


class _FakeImage:
    """Minimal stand-in so the tests do not require Pillow image loading."""

    def __init__(self, extrema_result):
        self._extrema = extrema_result

    def convert(self, _mode):
        return self

    def getextrema(self):
        return self._extrema


@pytest.mark.parametrize(
    "extrema,expected",
    [
        (((0, 255), (0, 255), (0, 255)), True),  # grayscale
        (((10, 10), (200, 200), (30, 30)), False),  # solid colour
        (((0, 255), (0, 0), (0, 0)), False),  # half black, half red
        (((0, 255), (0, 255), (0, 128)), False),  # tinted
    ],
)
def test_is_grayscale(extrema, expected):
    assert _is_grayscale(_FakeImage(extrema)) is expected


def test_fast_profile_keeps_two_variants():
    from PIL import Image

    image = Image.new("RGB", (40, 20), (128, 128, 128))
    assert [name for name, _ in _build_ocr_variants(image, "fast")] == [
        "autocontrast",
        "thresholded",
    ]


def test_accurate_profile_drops_channel_variants_for_grayscale():
    from PIL import Image

    grey = Image.new("RGB", (40, 20), (128, 128, 128))
    names = [name for name, _ in _build_ocr_variants(grey, "accurate")]
    assert names == ["autocontrast", "thresholded", "inverted"]


def test_accurate_profile_keeps_channel_variants_for_colour():
    from PIL import Image

    colour = Image.new("RGB", (40, 20), (10, 200, 30))
    names = [name for name, _ in _build_ocr_variants(colour, "accurate")]
    assert {"channel_r", "channel_g", "channel_b"} <= set(names)


# --------------------------------------------------------------------------
# Text scoring
# --------------------------------------------------------------------------


def test_ocr_text_score_ranks_denser_text_higher():
    dense = _ocr_text_score("The rate fell by 90 percent last year in every region")
    sparse = _ocr_text_score("a b c")
    assert dense > sparse


def test_ocr_text_score_empty_is_zero():
    assert _ocr_text_score("   ") == 0


# --------------------------------------------------------------------------
# Line quality heuristics
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "line,expected",
    [
        ("The death rate fell by 90 percent", True),
        ("abc", False),  # too short
        ("1234", False),  # no letters
        ("@@@ ### $$$ %%% ^^^", False),  # symbol-dense
        ("||a b c d||", False),  # symbol-dense
    ],
)
def test_is_reasonable_ocr_line(line, expected):
    assert _is_reasonable_ocr_line(line) is expected


def test_line_quality_score_penalises_symbols():
    clean = _line_quality_score("Scientists reported a new finding")
    noisy = _line_quality_score("!!!@@@###$$$%%%^^^&&&")
    assert clean > noisy


# --------------------------------------------------------------------------
# Line merging
# --------------------------------------------------------------------------


def test_extract_best_text_deduplicates_and_caps(monkeypatch):
    """Repeated variants must not produce repeated lines, and output is capped."""
    from PIL import Image

    lines = [f"Claim number {i} is stated here" for i in range(20)]
    calls = {"n": 0}

    def fake_run(_processed, _psm):
        calls["n"] += 1
        return "\n".join(lines)

    monkeypatch.setattr("app.post_classifier._run_ocr", fake_run)
    image = Image.new("RGB", (40, 20), (128, 128, 128))
    text = _extract_best_text_from_image(image, ocr_profile="accurate")

    out_lines = text.splitlines()
    assert len(out_lines) == 12
    assert len(set(out_lines)) == 12
    assert calls["n"] == 6


def test_extract_best_text_empty_when_nothing_returned(monkeypatch):
    from PIL import Image

    monkeypatch.setattr("app.post_classifier._run_ocr", lambda *_: "")
    image = Image.new("RGB", (40, 20), (128, 128, 128))
    assert _extract_best_text_from_image(image, ocr_profile="fast") == ""


def test_ocr_grid_runs_in_parallel(monkeypatch):
    """The grid must fan out rather than run one combination at a time."""
    import threading
    import time

    from PIL import Image

    active = {"max": 0, "now": 0}
    lock = threading.Lock()

    def slow_run(_processed, _psm):
        with lock:
            active["now"] += 1
            active["max"] = max(active["max"], active["now"])
        time.sleep(0.05)
        with lock:
            active["now"] -= 1
        return "Claim number 1 is stated here"

    monkeypatch.setattr("app.post_classifier._run_ocr", slow_run)
    image = Image.new("RGB", (40, 20), (128, 128, 128))
    _extract_best_text_from_image(image, ocr_profile="accurate")
    assert active["max"] > 1, "OCR combinations did not run concurrently"


# --------------------------------------------------------------------------
# Search result parsing
# --------------------------------------------------------------------------


def test_parse_ddg_html_pairs_snippet_with_its_own_result():
    html = """
    <div class="result">
      <a class="result__a" href="https://a.com/1">First</a>
      <a class="result__snippet">Snippet for the FIRST result.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://b.com/2">Second</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://c.com/3">Third</a>
      <a class="result__snippet">Snippet for the THIRD result.</a>
    </div>
    """
    results = parse_ddg_html(html)
    by_title = {r["title"]: r for r in results}
    assert by_title["First"]["snippet"] == "Snippet for the FIRST result."
    # The result with no snippet must not shift the next one onto itself.
    assert by_title["Second"]["snippet"] == ""
    assert by_title["Third"]["snippet"] == "Snippet for the THIRD result."


def test_parse_ddg_html_unwraps_redirect():
    html = (
        '<div class="result"><a class="result__a" '
        'href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.com%2Fpage">T</a></div>'
    )
    assert parse_ddg_html(html)[0]["url"] == "https://real.com/page"


def test_parse_ddg_html_respects_top_k():
    html = "".join(
        f'<div class="result"><a class="result__a" href="https://x/{i}">T{i}</a></div>'
        for i in range(10)
    )
    assert len(parse_ddg_html(html, top_k=3)) == 3


def test_parse_ddg_html_strips_markup():
    html = '<div class="result"><a class="result__a" href="https://x">A &amp; B <b>bold</b></a></div>'
    title = parse_ddg_html(html)[0]["title"]
    assert "<b>" not in title
    assert "&" in title


def test_parse_ddg_html_empty_document():
    assert parse_ddg_html("<html><body>nothing</body></html>") == []
