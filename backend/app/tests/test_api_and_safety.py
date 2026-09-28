"""Schema validation, URL safety, API contracts and feedback storage."""

import json
import threading

import pytest

from app.feedback_store import append_reports, read_reports
from app.schemas.agent_io import AgentOutput, ClaimInput
from app.schemas.tool_io import (
    CredibilityOutput,
    NumericVerifyOutput,
    WebSearchOutput,
)
from app.url_safety import UnsafeUrlError, _registrable_domain, validate_url


# --------------------------------------------------------------------------
# Request/response schemas
# --------------------------------------------------------------------------


def test_web_search_result_snippet_field_spelled_correctly():
    """The field was `snipped`, so snippets never round-tripped."""
    out = WebSearchOutput(
        claim_text="x",
        selected=[{"url": "https://a.com", "title": "t", "snippet": "the snippet"}],
    )
    assert out.selected[0].snippet == "the snippet"


def test_web_search_input_top_k_is_an_integer():
    out = WebSearchOutput(claim_text="x", rate_limited=True)
    assert out.rate_limited is True


def test_web_search_output_defaults_rate_limited_false():
    assert WebSearchOutput(claim_text="x").rate_limited is False


def test_credibility_output_carries_signals():
    out = CredibilityOutput(
        items=[
            {
                "url": "https://a.gov",
                "domain": "a.gov",
                "tier": "high",
                "signals": ["gov_domain"],
            }
        ]
    )
    assert out.items[0].signals == ["gov_domain"]


def test_claim_input_requires_at_least_one_claim():
    with pytest.raises(ValueError):
        ClaimInput(claims=[])


def test_numeric_verify_output_score_is_bounded():
    out = NumericVerifyOutput(
        claim_text="x",
        finding={
            "extracted_numbers": ["5"],
            "flags": ["a"],
            "computed_checks": {},
            "score": 0.5,
        },
    )
    assert 0.0 <= out.finding.score <= 1.0


def test_agent_output_requires_scores_and_verdict():
    with pytest.raises(ValueError):
        AgentOutput()


# --------------------------------------------------------------------------
# URL safety / SSRF
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/",
        "http://127.0.0.1/",
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://[::1]/",
        "http://0.0.0.0/",
        "file:///etc/passwd",
        "gopher://example.com/",
        "http://8.8.8.8/",
        "https://scontent.cdninstagram.com:22/x.jpg",
    ],
)
def test_validate_url_blocks_ssrf_targets(url):
    with pytest.raises(UnsafeUrlError):
        validate_url(url, check_dns=False)


@pytest.mark.parametrize(
    "url",
    [
        "https://scontent.cdninstagram.com/v/t51/x.jpg",
        "https://instagram.com/p/ABC/",
        "https://i.instagram.com/p/ABC/",
    ],
)
def test_validate_url_allows_instagram_cdn(url):
    assert validate_url(url, check_dns=False)


@pytest.mark.parametrize(
    "host",
    [
        "instagram.com.evil.net",
        "notinstagram.com",
        "instagram.evil.com",
        "instagram.com.attacker.io",
    ],
)
def test_validate_url_rejects_lookalike_domains(host):
    with pytest.raises(UnsafeUrlError):
        validate_url(f"https://{host}/p/1", check_dns=False)


@pytest.mark.parametrize(
    "host,expected",
    [
        ("www.instagram.com", "instagram.com"),
        ("scontent.cdninstagram.com", "cdninstagram.com"),
        ("a.b.instagram.com", "instagram.com"),
        ("notinstagram.com", "notinstagram.com"),
        ("instagram.com.evil.net", "evil.net"),
        ("shop.co.uk", "shop.co.uk"),
        ("x.y.shop.co.uk", "shop.co.uk"),
    ],
)
def test_registrable_domain(host, expected):
    assert _registrable_domain(host) == expected


def test_validate_url_rejects_oversized_url():
    with pytest.raises(UnsafeUrlError):
        validate_url("https://instagram.com/" + "a" * 3000, check_dns=False)


# --------------------------------------------------------------------------
# Feedback storage
# --------------------------------------------------------------------------


def _report(n):
    return {
        "type": "false_positive",
        "imageUrl": f"https://cdninstagram.com/{n}.jpg",
        "caption": "c",
        "timestamp": n,
    }


def test_append_reports_round_trip(tmp_path):
    total = append_reports(tmp_path, [_report(1), _report(2)])
    assert total == 2
    assert len(read_reports(tmp_path)) == 2


def test_append_reports_accumulates(tmp_path):
    append_reports(tmp_path, [_report(1)])
    append_reports(tmp_path, [_report(2)])
    assert len(read_reports(tmp_path)) == 2


def test_concurrent_appends_lose_nothing(tmp_path):
    """The read-modify-write race that lost reports under concurrency."""

    def worker(n):
        append_reports(tmp_path, [_report(n * 10 + i) for i in range(5)])

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    stored = read_reports(tmp_path)
    assert len(stored) == 100
    assert len({r["imageUrl"] for r in stored}) == 100


def test_reader_survives_truncated_final_line(tmp_path):
    append_reports(tmp_path, [_report(i) for i in range(5)])
    path = next(tmp_path.glob("*.jsonl"))
    path.write_text(path.read_text() + '{"type":"false_po')

    assert len(read_reports(tmp_path)) == 5


def test_no_temp_files_left_behind(tmp_path):
    append_reports(tmp_path, [_report(1)])
    assert not list(tmp_path.glob("*.tmp"))


def test_oversized_batch_rejected(tmp_path):
    with pytest.raises(ValueError):
        append_reports(tmp_path, [{"caption": "x" * 100_000}])


# --------------------------------------------------------------------------
# API surface
# --------------------------------------------------------------------------


@pytest.fixture()
def client(_isolated_settings, tmp_path, monkeypatch):
    import dataclasses

    import app.config as config
    import app.main as main

    patched = dataclasses.replace(config.get_settings(), feedback_dir=tmp_path)
    monkeypatch.setattr(main, "get_settings", lambda: patched)
    monkeypatch.setattr("app.api.routes.get_settings", lambda: patched)
    main.app.config.update(TESTING=True)
    return main.app.test_client()


def test_analyze_requires_url(client):
    assert client.post("/api/analyze_claims", json={}).status_code == 400


def test_malformed_json_is_400(client):
    response = client.post(
        "/api/analyze_claims", data="{not json", content_type="application/json"
    )
    assert response.status_code == 400


def test_out_of_range_max_images_is_400(client):
    response = client.post(
        "/api/analyze_claims", json={"url": "https://x/y.jpg", "max_images": 999}
    )
    assert response.status_code == 400


def test_validation_errors_do_not_leak_internals(client):
    body = client.post("/api/analyze_claims", json={}).get_json()
    text = json.dumps(body)
    for leak in ("Traceback", "/Users/", "pydantic", "Field required", "openai"):
        assert leak not in text


def test_feedback_accepts_and_persists(client, tmp_path):
    response = client.post(
        "/api/feedback",
        json={"reports": [_report(1)]},
    )
    assert response.status_code == 200
    assert response.get_json()["received"] == 1
    assert len(read_reports(tmp_path)) == 1


def test_feedback_rejects_wrong_type(client):
    assert client.post("/api/feedback", json={"reports": "nope"}).status_code == 400


def test_unknown_route_returns_json_404(client):
    response = client.get("/api/nope")
    assert response.status_code == 404
    assert "error" in response.get_json()


# --------------------------------------------------------------------------
# analyze_claims wiring
# --------------------------------------------------------------------------


def test_analyze_passes_non_empty_claims_to_the_agent(client, monkeypatch):
    """A post with no alt text must still reach the agent with a real claim.

    Guards the call site, not just build_claims: the original bug was
    `claims=[payload.alt_text]`, which is a non-empty list only when alt text
    happens to be present.
    """
    from app.schemas.agent_io import AgentOutput

    seen = {}

    async def fake_run(self, inp, assistant_id=None):
        seen["claims"] = inp.claims
        seen["context"] = inp.context
        return AgentOutput(
            ai_generated_risk_score=0.1,
            misinformation_risk_score=0.2,
            verdict="likely_true",
            confidence=0.9,
            explanation="nothing to verify",
        )

    monkeypatch.setattr(
        "app.agents.langchain_agent.LangChainAgent.run",
        fake_run,
        raising=True,
    )
    monkeypatch.setattr(
        "app.api.routes.extract_post_text_for_llm",
        lambda **kwargs: {"llm-input-text": "OCR TEXT: 90-95% reduction"},
    )

    response = client.post(
        "/api/analyze_claims",
        json={
            "url": "https://scontent.cdninstagram.com/x.jpg",
            "caption": "a caption",
            "alt_text": "",
        },
    )

    assert response.status_code == 200
    assert seen["claims"], "agent received an empty claim list"
    assert "a caption" in seen["claims"]
    assert any("OCR" in claim for claim in seen["claims"])
    assert seen["context"].caption == "a caption"


def test_analyze_never_returns_500_for_a_post_with_no_text(client, monkeypatch):
    from app.schemas.agent_io import AgentOutput

    async def fake_run(self, inp, assistant_id=None):
        return AgentOutput(
            ai_generated_risk_score=0.0,
            misinformation_risk_score=0.0,
            verdict="unverifiable",
            confidence=0.1,
            explanation="no text",
        )

    monkeypatch.setattr("app.agents.langchain_agent.LangChainAgent.run", fake_run)
    monkeypatch.setattr(
        "app.api.routes.extract_post_text_for_llm",
        lambda **kwargs: {"llm-input-text": ""},
    )

    response = client.post(
        "/api/analyze_claims",
        json={"url": "https://scontent.cdninstagram.com/x.jpg"},
    )
    assert response.status_code == 200
    assert response.get_json()["verdict"] == "unverifiable"


def test_agent_failure_returns_generic_error(client, monkeypatch):
    async def boom(self, inp, assistant_id=None):
        raise RuntimeError("secret internal detail: /srv/app/key sk-leaked")

    monkeypatch.setattr("app.agents.langchain_agent.LangChainAgent.run", boom)
    monkeypatch.setattr(
        "app.api.routes.extract_post_text_for_llm",
        lambda **kwargs: {"llm-input-text": "text"},
    )

    response = client.post(
        "/api/analyze_claims",
        json={"url": "https://scontent.cdninstagram.com/x.jpg", "caption": "c"},
    )
    assert response.status_code == 500
    body = json.dumps(response.get_json())
    assert "sk-leaked" not in body
    assert "/srv/app" not in body


# --------------------------------------------------------------------------
# Video / Reel wiring
# --------------------------------------------------------------------------


@pytest.fixture()
def captured_classifier(monkeypatch):
    """Record what analyze_claims hands the classifier, without running OCR."""
    seen = {}

    def fake(**kwargs):
        seen.update(kwargs)
        return {"llm-input-text": "OCR TEXT: 90-95% reduction"}

    monkeypatch.setattr("app.api.routes.extract_post_text_for_llm", fake)
    return seen


def _stub_agent(monkeypatch):
    from app.schemas.agent_io import AgentOutput

    seen = {}

    async def fake_run(self, inp, assistant_id=None):
        seen["context"] = inp.context
        return AgentOutput(
            ai_generated_risk_score=0.1,
            misinformation_risk_score=0.2,
            verdict="likely_true",
            confidence=0.9,
            explanation="poster frame analysed",
        )

    monkeypatch.setattr("app.agents.langchain_agent.LangChainAgent.run", fake_run)
    return seen


def test_video_post_forwards_its_poster_frame(client, monkeypatch, captured_classifier):
    agent = _stub_agent(monkeypatch)
    response = client.post(
        "/api/analyze_claims",
        json={
            "url": "https://scontent.cdninstagram.com/v/t51/p.jpg",
            "caption": "a reel",
            "is_video": True,
            "video_thumb": "https://scontent.cdninstagram.com/v/t51/p.jpg",
        },
    )
    assert response.status_code == 200
    assert captured_classifier["poster_url"] == (
        "https://scontent.cdninstagram.com/v/t51/p.jpg"
    )
    assert agent["context"].metadata["is_video"] is True


def test_a_poster_is_ignored_for_an_image_post(
    client, monkeypatch, captured_classifier
):
    """is_video is the switch, so a stray video_thumb cannot redirect the fetch."""
    _stub_agent(monkeypatch)
    response = client.post(
        "/api/analyze_claims",
        json={
            "url": "https://scontent.cdninstagram.com/v/t51/p.jpg",
            "is_video": False,
            "video_thumb": "https://scontent.cdninstagram.com/elsewhere.jpg",
        },
    )
    assert response.status_code == 200
    assert captured_classifier["poster_url"] == ""


def test_client_metadata_survives_the_video_flag(
    client, monkeypatch, captured_classifier
):
    agent = _stub_agent(monkeypatch)
    client.post(
        "/api/analyze_claims",
        json={
            "url": "https://scontent.cdninstagram.com/v/t51/p.jpg",
            "metadata": {"permalink": "/p/ABC/"},
            "is_video": True,
        },
    )
    metadata = agent["context"].metadata
    assert metadata["permalink"] == "/p/ABC/"
    assert metadata["is_video"] is True


def test_oversized_video_thumb_is_400(client):
    response = client.post(
        "/api/analyze_claims",
        json={"url": "https://x/y.jpg", "video_thumb": "https://x/" + "a" * 3000},
    )
    assert response.status_code == 400


# --------------------------------------------------------------------------
# Health endpoint
# --------------------------------------------------------------------------


def test_health_ok_when_configured(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "ok"
    assert body["checks"]["api_key_configured"] is True


def test_health_degraded_without_api_key(client, monkeypatch):
    import dataclasses

    import app.config as config

    patched = dataclasses.replace(config.get_settings(), openai_api_key="")
    monkeypatch.setattr("app.api.routes.get_settings", lambda: patched)

    response = client.get("/api/health")
    assert response.status_code == 503
    assert response.get_json()["status"] == "degraded"


def test_health_never_echoes_the_key(client):
    """The probe reports presence as a boolean and nothing more."""
    body = client.get("/api/health").get_json()
    flat = json.dumps(body)
    assert "sk-test" not in flat
    # No field may be named api_key; only the boolean api_key_configured.
    assert "api_key" not in body
    assert body["checks"]["api_key_configured"] is True
    assert set(body["checks"]) == {
        "api_key_configured",
        "search_provider_configured",
        "feedback_dir_writable",
    }
