"""Server-side analysis cache: keying, TTL, bounds and the X-Cache contract (#65)."""

import base64
import dataclasses
import hashlib
import io

import pytest

from app import cache as cache_module
from app.cache import AnalysisCache, cache_key, get_cache, image_digests, normalize_text
from app.config import get_settings


class _Clock:
    """Monotonic clock the test advances by hand."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


# --------------------------------------------------------------------------
# Normalization and keying
# --------------------------------------------------------------------------


def test_normalize_text_collapses_whitespace_and_case():
    assert normalize_text("  Shark   attack\n\nin MEXICO  ") == "shark attack in mexico"


def test_normalize_text_tolerates_none():
    assert normalize_text(None) == ""


def _settings(**overrides):
    base = get_settings()
    return dataclasses.replace(base, **overrides) if overrides else base


def _key(**overrides):
    params = {
        "url": "https://www.instagram.com/p/abc/",
        "caption": "Shark attack in MEXICO",
        "alt_text": "",
        "images": None,
        "max_images": 3,
        "settings": _settings(),
    }
    params.update(overrides)
    return cache_key(**params)


def test_cosmetic_text_edits_share_a_key():
    assert _key(caption="Shark  attack\nin mexico") == _key()


def test_different_claim_text_is_a_different_key():
    assert _key(caption="Shark attack in California") != _key()


def test_a_different_model_is_a_different_key():
    # Otherwise the model id in /api/health would not describe the answers.
    assert _key(settings=_settings(openai_model="gpt-4o-mini")) != _key()


def test_a_different_image_budget_is_a_different_key():
    assert _key(max_images=5) != _key()


def test_image_digests_are_order_and_case_insensitive():
    a = {"content_sha256": "A" * 64}
    b = {"content_sha256": "b" * 64}
    assert image_digests([a, b]) == image_digests([b, a]) == ["a" * 64, "b" * 64]
    assert _key(images=[a, b]) == _key(images=[b, a])


def test_with_inline_images_the_url_is_not_part_of_the_key():
    # Same bytes and same text is the same question, whatever the permalink.
    images = [{"content_sha256": "c" * 64}]
    assert _key(url="https://example.com/a", images=images) == _key(
        url="https://example.com/b", images=images
    )


def test_without_inline_images_the_url_is_part_of_the_key():
    # The OCR text is unknown until after the scrape, so two posts that share a
    # caption but not their images must not collide.
    assert _key(url="https://example.com/a") != _key(url="https://example.com/b")


def test_changing_an_image_is_a_different_key():
    assert _key(images=[{"content_sha256": "d" * 64}]) != _key(
        images=[{"content_sha256": "e" * 64}]
    )


# --------------------------------------------------------------------------
# TTL, bounds and locking
# --------------------------------------------------------------------------


def test_a_stored_value_is_returned():
    store = AnalysisCache(ttl_seconds=60, max_entries=8)
    store.set("k", {"verdict": "likely_false"})
    assert store.get("k") == {"verdict": "likely_false"}
    assert store.stats()["hits"] == 1


def test_an_expired_entry_is_a_miss():
    clock = _Clock()
    store = AnalysisCache(ttl_seconds=60, max_entries=8, clock=clock)
    store.set("k", "v")
    clock.advance(59)
    assert store.get("k") == "v"
    clock.advance(1)
    assert store.get("k") is None
    assert store.stats()["misses"] == 1


def test_an_expired_entry_does_not_consume_capacity():
    clock = _Clock()
    store = AnalysisCache(ttl_seconds=10, max_entries=2, clock=clock)
    store.set("old", "v")
    clock.advance(11)
    store.set("a", "1")
    store.set("b", "2")
    assert store.stats()["entries"] == 2


def test_the_entry_count_is_bounded_by_evicting_the_least_recently_used():
    store = AnalysisCache(ttl_seconds=60, max_entries=2)
    store.set("a", "1")
    store.set("b", "2")
    store.get("a")  # "a" is now the most recently used, so "b" goes first
    store.set("c", "3")

    assert store.stats()["entries"] == 2
    assert store.get("b") is None
    assert store.get("a") == "1"
    assert store.get("c") == "3"


def test_a_zero_ttl_disables_the_cache():
    store = AnalysisCache(ttl_seconds=0, max_entries=8)
    assert store.enabled is False
    store.set("k", "v")
    assert store.get("k") is None


def test_concurrent_writers_do_not_lose_or_corrupt_entries():
    import threading

    store = AnalysisCache(ttl_seconds=60, max_entries=1000)
    errors: list[BaseException] = []

    def writer(offset: int) -> None:
        try:
            for i in range(200):
                store.set(f"k{offset}-{i}", i)
                assert store.get(f"k{offset}-{i}") == i
        except BaseException as exc:  # noqa: BLE001 - reported below
            errors.append(exc)

    threads = [threading.Thread(target=writer, args=(n,)) for n in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    # 8 writers x 200 keys = 1600 insertions into a 1000-entry store.
    assert store.stats()["entries"] == 1000


def test_get_cache_rebuilds_when_the_settings_change():
    cache_module.reset_cache()
    first = get_cache(_settings(cache_ttl_seconds=30))
    assert get_cache(_settings(cache_ttl_seconds=30)) is first
    # Flipping the knob must actually take effect, not reuse the old instance.
    assert get_cache(_settings(cache_ttl_seconds=0)) is not first
    cache_module.reset_cache()


# --------------------------------------------------------------------------
# The endpoint contract
# --------------------------------------------------------------------------


def _png(fill: int = 0) -> str:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), (fill, fill, fill)).save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


@pytest.fixture()
def client(monkeypatch):
    """A test client whose agent is stubbed, with the cache isolated."""
    import app.config as config
    import app.main as main
    from app.schemas.agent_io import AgentOutput

    runs = []

    class _StubAgent:
        def __init__(self, api_key=None):
            pass

        async def run(self, claim_input):
            runs.append(claim_input)
            return AgentOutput(
                ai_generated_risk_score=0.1,
                misinformation_risk_score=0.9,
                verdict="likely_false",
                confidence=0.8,
            )

    monkeypatch.setattr("app.api.routes.LangChainAgent", _StubAgent)
    monkeypatch.setattr(
        "app.post_classifier._extract_best_text_from_image", lambda *a, **k: ""
    )
    monkeypatch.setattr("app.post_classifier._extract_image_urls", lambda *a, **k: [])
    config.reset_settings_cache()
    cache_module.reset_cache()
    main.app.config.update(TESTING=True)
    yield main.app.test_client(), runs
    cache_module.reset_cache()
    config.reset_settings_cache()


def _body(client, **overrides):
    data = base64.b64decode(_png())
    body = {
        "url": "https://www.instagram.com/p/abc/",
        "caption": "Shark attack in Mexico",
        "images": [
            {
                "mime_type": "image/png",
                "data_base64": _png(),
                "content_sha256": hashlib.sha256(data).hexdigest(),
            }
        ],
    }
    body.update(overrides)
    return body


def test_a_repeat_request_is_served_from_cache(client):
    http, runs = client
    first = http.post("/api/analyze_claims", json=_body(http))
    assert first.status_code == 200
    assert first.headers["X-Cache"] == "MISS"

    second = http.post("/api/analyze_claims", json=_body(http))
    assert second.status_code == 200
    assert second.headers["X-Cache"] == "HIT"
    assert second.get_json() == first.get_json()
    # The agent ran once, not twice.
    assert len(runs) == 1


def test_a_different_image_is_not_served_from_cache(client):
    http, runs = client
    assert (
        http.post("/api/analyze_claims", json=_body(http)).headers["X-Cache"] == "MISS"
    )

    other = _png(fill=255)
    body = _body(http)
    body["images"][0] = {
        "mime_type": "image/png",
        "data_base64": other,
        "content_sha256": hashlib.sha256(base64.b64decode(other)).hexdigest(),
    }
    assert http.post("/api/analyze_claims", json=body).headers["X-Cache"] == "MISS"
    assert len(runs) == 2


def test_a_rejected_image_is_never_cached(client):
    http, runs = client
    body = _body(http)
    body["images"][0]["content_sha256"] = "0" * 64
    assert http.post("/api/analyze_claims", json=body).status_code == 400
    assert (
        http.post("/api/analyze_claims", json=_body(http)).headers["X-Cache"] == "MISS"
    )
