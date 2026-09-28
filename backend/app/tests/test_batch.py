"""The batch analysis endpoint (#74)."""

import base64
import hashlib
import io

import pytest

from app import cache as cache_module
from app.agents.langchain_agent import AgentOutputError
from app.rate_limit import InMemoryRateLimiter


def _png(fill: int = 0) -> str:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), (fill, fill, fill)).save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _item(caption: str, **overrides) -> dict:
    data = base64.b64decode(_png())
    item = {
        "url": "https://www.instagram.com/p/abc/",
        "caption": caption,
        "request_id": f"req-{caption}",
        "images": [
            {
                "mime_type": "image/png",
                "data_base64": _png(),
                "content_sha256": hashlib.sha256(data).hexdigest(),
            }
        ],
    }
    item.update(overrides)
    return item


@pytest.fixture()
def client(monkeypatch):
    """A test client with a scripted agent and an isolated cache."""
    import app.config as config
    import app.main as main
    import app.rate_limit as rate_limit
    from app.schemas.agent_io import AgentOutput

    seen: list[str] = []

    class _StubAgent:
        def __init__(self, api_key=None):
            pass

        async def run(self, claim_input):
            caption = (claim_input.context.caption if claim_input.context else "") or ""
            seen.append(caption)
            if "boom" in caption:
                raise AgentOutputError("the model produced nothing usable")
            return AgentOutput(
                ai_generated_risk_score=0.1,
                misinformation_risk_score=0.9,
                verdict="likely_false",
                confidence=0.8,
                reasoning_chain=[f"checked {caption}"],
            )

    monkeypatch.setattr("app.api.routes.LangChainAgent", _StubAgent)
    monkeypatch.setattr(
        "app.post_classifier._extract_best_text_from_image", lambda *a, **k: ""
    )
    monkeypatch.setattr("app.post_classifier._extract_image_urls", lambda *a, **k: [])
    config.reset_settings_cache()
    cache_module.reset_cache()
    rate_limit.reset_limiters()
    main.app.config.update(TESTING=True)
    yield main.app.test_client(), seen
    cache_module.reset_cache()
    rate_limit.reset_limiters()
    config.reset_settings_cache()


# --------------------------------------------------------------------------
# The contract
# --------------------------------------------------------------------------


def test_every_item_gets_its_own_result(client):
    http, seen = client
    response = http.post(
        "/api/analyze_batch",
        json={"items": [_item("one"), _item("two"), _item("three")]},
    )

    assert response.status_code == 200
    results = response.get_json()["results"]
    assert [entry["request_id"] for entry in results] == [
        "req-one",
        "req-two",
        "req-three",
    ]
    assert [entry["index"] for entry in results] == [0, 1, 2]
    assert all(entry["status"] == "ok" for entry in results)
    assert all(entry["result"]["verdict"] == "likely_false" for entry in results)
    assert seen == ["one", "two", "three"]


def test_an_item_without_a_request_id_gets_one_from_its_position(client):
    http, _ = client
    item = _item("one")
    item.pop("request_id")
    results = http.post("/api/analyze_batch", json={"items": [item]}).get_json()[
        "results"
    ]
    assert results[0]["request_id"] == "batch-0"


def test_one_bad_item_does_not_discard_the_good_ones(client):
    """The extension needs the eight verdicts it can get, not a 400."""
    http, _ = client
    bad_image = _item("bad")
    bad_image["images"][0]["content_sha256"] = "0" * 64

    results = http.post(
        "/api/analyze_batch",
        json={"items": [_item("good1"), bad_image, _item("good2")]},
    ).get_json()["results"]

    assert [entry["status"] for entry in results] == ["ok", "invalid", "ok"]
    assert results[1]["index"] == 1
    assert results[1]["request_id"] == "req-bad"
    # The message names the rule and never the payload.
    assert "content hash" in results[1]["error"]
    assert "0" * 64 not in results[1]["error"]


def test_a_server_side_failure_is_reported_per_item(client):
    http, _ = client
    results = http.post(
        "/api/analyze_batch", json={"items": [_item("ok"), _item("boom")]}
    ).get_json()["results"]
    assert [entry["status"] for entry in results] == ["ok", "error"]
    # The generic message, not the agent's internals.
    assert results[1]["error"] == "Analysis failed due to an internal error."
    assert "nothing usable" not in results[1]["error"]


def test_a_duplicate_inside_one_batch_is_served_from_the_cache(client):
    http, seen = client
    response = http.post(
        "/api/analyze_batch", json={"items": [_item("same"), _item("same")]}
    )
    results = response.get_json()["results"]
    assert [entry["cache"] for entry in results] == ["MISS", "HIT"]
    assert len(seen) == 1


def test_the_cache_header_is_hit_only_when_every_item_was(client):
    http, _ = client
    fresh = http.post("/api/analyze_batch", json={"items": [_item("a")]})
    assert fresh.headers["X-Cache"] == "MISS"
    warm = http.post("/api/analyze_batch", json={"items": [_item("a")]})
    assert warm.headers["X-Cache"] == "HIT"


# --------------------------------------------------------------------------
# Bounds and cost
# --------------------------------------------------------------------------


def test_more_than_ten_items_is_rejected(client):
    http, seen = client
    response = http.post(
        "/api/analyze_batch", json={"items": [_item(f"c{i}") for i in range(11)]}
    )
    assert response.status_code == 400
    assert seen == []


def test_an_empty_batch_is_rejected(client):
    http, _ = client
    assert http.post("/api/analyze_batch", json={"items": []}).status_code == 400


def test_a_malformed_item_rejects_the_whole_request(client):
    """Item shape is schema-level, so it is a 400 rather than a per-item error."""
    http, _ = client
    response = http.post("/api/analyze_batch", json={"items": [{"caption": "no url"}]})
    assert response.status_code == 400


def test_a_batch_costs_one_token_per_item():
    """Batching must not be cheaper per analysis than the single endpoint."""
    limiter = InMemoryRateLimiter(limit=20, window_seconds=60)
    assert limiter.check("tok:analyze", units=1).remaining == 19
    assert limiter.check("tok:analyze", units=10).remaining == 9
    assert limiter.check("tok:analyze", units=10).allowed is False


def test_a_batch_over_the_budget_is_refused_before_any_work(client):
    import app.rate_limit as rate_limit

    http, seen = client
    # Auth is off in tests, so the caller is the anonymous identity.
    rate_limit.get_limiter("analyze").check("anonymous:analyze", units=19)

    response = http.post("/api/analyze_batch", json={"items": [_item("a"), _item("b")]})

    assert response.status_code == 429
    # Refused up front: the agent never ran, so nothing was spent.
    assert seen == []
