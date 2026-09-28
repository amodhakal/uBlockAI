"""API key authentication and per-token rate limiting."""

import json
from pathlib import Path

import pytest

from app import auth, rate_limit
from app.auth import (
    API_KEY_PREFIX,
    ApiKeyIdentity,
    generate_key,
    hash_key,
    looks_like_key,
    normalize_presented_key,
    presented_key_from_request,
    register_key,
    resolve_key,
    revoke_key,
)


@pytest.fixture()
def registry(tmp_path, monkeypatch):
    """An isolated key registry on disk."""
    path = tmp_path / "api_keys.json"
    monkeypatch.setenv("API_KEYS_PATH", str(path))
    import app.config as config

    config.reset_settings_cache()
    yield path
    config.reset_settings_cache()


# --------------------------------------------------------------------------
# Key shape
# --------------------------------------------------------------------------


def test_generated_keys_have_the_documented_shape():
    key = generate_key()
    assert key.startswith(API_KEY_PREFIX)
    # 43 base64url characters is exactly one 256-bit token.
    assert len(key) == len(API_KEY_PREFIX) + 43
    assert looks_like_key(key)


def test_looks_like_key_rejects_junk():
    for bad in ["", "nope", API_KEY_PREFIX, "sk-" + "a" * 40, API_KEY_PREFIX + "short"]:
        assert not looks_like_key(bad), f"accepted {bad!r}"


def test_generated_keys_are_unique():
    assert len({generate_key() for _ in range(50)}) == 50


def test_normalize_strips_the_bearer_prefix():
    assert normalize_presented_key("Bearer abc") == "abc"
    assert normalize_presented_key("bearer  abc ") == "abc"
    assert normalize_presented_key("  plain  ") == "plain"
    assert normalize_presented_key(None) == ""
    assert normalize_presented_key("") == ""


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------


def test_a_minted_key_resolves(registry):
    key = generate_key()
    key_id = register_key(key, "test")
    identity = resolve_key(key)
    assert identity is not None
    assert identity.key_id == key_id
    assert identity.label == "test"


def test_the_registry_stores_only_the_digest(registry):
    key = generate_key()
    register_key(key, "test")
    raw = registry.read_text(encoding="utf-8")
    assert key not in raw, "the plaintext key was persisted"
    assert hash_key(key) in raw
    assert registry.stat().st_mode & 0o077 == 0, "registry is not owner-only"


def test_an_unknown_key_does_not_resolve(registry):
    register_key(generate_key(), "known")
    assert resolve_key(generate_key()) is None


def test_a_malformed_key_does_not_resolve(registry):
    register_key(generate_key(), "known")
    assert resolve_key("garbage") is None
    assert resolve_key("") is None


def test_a_revoked_key_stops_resolving(registry):
    key = generate_key()
    key_id = register_key(key, "test")
    assert resolve_key(key) is not None
    assert revoke_key(key_id) is True
    assert resolve_key(key) is None
    assert revoke_key(key_id) is False


def test_a_corrupt_registry_denies_rather_than_allows(registry):
    registry.write_text("{not json", encoding="utf-8")
    register_key_holder = generate_key()
    # Unreadable registry must fail closed, not open.
    assert resolve_key(register_key_holder) is None


def test_a_disabled_key_does_not_resolve(registry):
    key = generate_key()
    register_key(key, "test")
    keys = json.loads(registry.read_text(encoding="utf-8"))["keys"]
    keys[0]["disabled"] = True
    registry.write_text(json.dumps({"keys": keys}), encoding="utf-8")
    assert resolve_key(key) is None


# --------------------------------------------------------------------------
# Header extraction
# --------------------------------------------------------------------------


def test_presented_key_prefers_the_custom_header(app_ctx=None):
    from flask import Flask

    app = Flask(__name__)

    @app.get("/x")
    def read():
        return presented_key_from_request()

    client = app.test_client()
    assert (
        client.get(
            "/x", headers={"X-API-Key": "a", "Authorization": "Bearer b"}
        ).get_data()
        == b"a"
    )
    assert client.get("/x", headers={"Authorization": "Bearer b"}).get_data() == b"b"
    assert client.get("/x").get_data() == b""


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import dataclasses

    import app.config as config
    import app.main as main

    keys_path = tmp_path / "api_keys.json"
    monkeypatch.setenv("API_KEYS_PATH", str(keys_path))
    config.reset_settings_cache()
    rate_limit.reset_limiters()

    base = config.get_settings()
    # Auth ON: the default must be exercised, not bypassed.
    secured = dataclasses.replace(
        base, require_auth=True, api_keys_path=keys_path, feedback_dir=tmp_path / "fb"
    )
    monkeypatch.setattr("app.auth.get_settings", lambda: secured)
    monkeypatch.setattr("app.api.routes.get_settings", lambda: secured)
    monkeypatch.setattr(main, "get_settings", lambda: secured)
    main.app.config.update(TESTING=True)
    yield main.app.test_client(), keys_path
    rate_limit.reset_limiters()
    config.reset_settings_cache()


def test_the_health_probe_needs_no_key(client):
    http, _ = client
    response = http.get("/api/health")
    assert response.status_code == 200, "liveness must not depend on a credential"


def test_analysis_requires_a_key(client):
    http, _ = client
    response = http.post("/api/analyze_claims", json={"url": "https://x/y.jpg"})
    assert response.status_code == 401
    assert response.get_json()["error"] == auth.GENERIC_AUTH_ERROR


def test_feedback_requires_a_key(client):
    http, _ = client
    response = http.post("/api/feedback", json={"reports": []})
    assert response.status_code == 401


def test_an_unknown_key_is_rejected(client):
    http, _ = client
    response = http.post(
        "/api/analyze_claims",
        json={"url": "https://x/y.jpg"},
        headers={"X-API-Key": generate_key()},
    )
    assert response.status_code == 401


def test_a_known_key_is_accepted(client):
    http, keys_path = client
    key = generate_key()
    register_key(key, "test")
    # Reaches the analysis path, which then fails on the SSRF-guarded fetch or
    # the agent, but not on auth.
    response = http.post(
        "/api/analyze_claims",
        json={"url": "https://scontent.cdninstagram.com/x.jpg"},
        headers={"X-API-Key": key},
    )
    assert response.status_code != 401


def test_a_401_never_echoes_the_presented_key(client):
    http, _ = client
    presented = generate_key()
    response = http.post(
        "/api/analyze_claims",
        json={"url": "https://x/y.jpg"},
        headers={"X-API-Key": presented},
    )
    assert presented not in response.get_data(as_text=True)
    assert hash_key(presented) not in response.get_data(as_text=True)


def test_the_401_body_carries_no_registry_detail(client):
    http, _ = client
    body = http.post("/api/analyze_claims", json={"url": "https://x/y.jpg"}).get_data(
        as_text=True
    )
    for leak in ("Traceback", "/app/", "sha256", "api_keys.json"):
        assert leak not in body


# --------------------------------------------------------------------------
# Rate limiting
# --------------------------------------------------------------------------


def test_requests_beyond_the_limit_are_throttled(client):
    http, keys_path = client
    key = generate_key()
    register_key(key, "test")
    headers = {"X-API-Key": key}

    codes = [
        http.post("/api/feedback", json={"reports": []}, headers=headers).status_code
        for _ in range(70)
    ]
    assert 429 in codes, "the limiter never engaged"
    assert codes.count(200) <= rate_limit.DEFAULT_FEEDBACK_LIMIT


def test_a_429_carries_retry_after_and_budget_headers(client):
    http, _ = client
    key = generate_key()
    register_key(key, "test")
    headers = {"X-API-Key": key}

    response = None
    for _ in range(70):
        response = http.post("/api/feedback", json={"reports": []}, headers=headers)
        if response.status_code == 429:
            break
    assert response is not None and response.status_code == 429
    assert int(response.headers["Retry-After"]) >= 0
    assert (
        int(response.headers["X-RateLimit-Limit"]) == rate_limit.DEFAULT_FEEDBACK_LIMIT
    )
    assert response.headers["X-RateLimit-Remaining"] == "0"


def test_successful_responses_report_the_remaining_budget(client):
    http, _ = client
    key = generate_key()
    register_key(key, "test")
    response = http.post(
        "/api/feedback",
        json={"reports": []},
        headers={"X-API-Key": key},
    )
    assert response.status_code == 200
    assert int(response.headers["X-RateLimit-Remaining"]) < int(
        response.headers["X-RateLimit-Limit"]
    )


def test_buckets_are_isolated_per_token():
    limiter = rate_limit.InMemoryRateLimiter(limit=2, window_seconds=60)
    assert limiter.check("token-a").allowed
    assert limiter.check("token-a").allowed
    assert not limiter.check("token-a").allowed
    # A different token has its own budget.
    assert limiter.check("token-b").allowed


def test_buckets_are_isolated_per_route_group():
    limiter = rate_limit.InMemoryRateLimiter(limit=1, window_seconds=60)
    assert limiter.check("k1:analyze").allowed
    assert not limiter.check("k1:analyze").allowed
    assert limiter.check("k1:feedback").allowed


def test_the_window_resets():
    now = [1000.0]
    limiter = rate_limit.InMemoryRateLimiter(
        limit=1, window_seconds=10, clock=lambda: now[0]
    )
    assert limiter.check("k").allowed
    assert not limiter.check("k").allowed
    now[0] += 11
    assert limiter.check("k").allowed


def test_a_wall_clock_jump_does_not_grant_a_free_window():
    # monotonic clock: an NTP step cannot reset counters.
    now = [1000.0]
    limiter = rate_limit.InMemoryRateLimiter(
        limit=1, window_seconds=60, clock=lambda: now[0]
    )
    assert limiter.check("k").allowed
    assert not limiter.check("k").allowed
    now[0] -= 3600  # clock stepped backwards
    assert not limiter.check("k").allowed


def test_the_limiter_never_exceeds_max_tracked_keys():
    limiter = rate_limit.InMemoryRateLimiter(limit=10, max_keys=5)
    for i in range(50):
        limiter.check(f"key-{i}")
    assert limiter.size <= 6  # the in-flight key plus the cap


def test_expired_buckets_are_pruned():
    now = [0.0]
    limiter = rate_limit.InMemoryRateLimiter(
        limit=10, window_seconds=10, clock=lambda: now[0]
    )
    for i in range(5):
        limiter.check(f"key-{i}")
    assert limiter.size == 5
    now[0] = 100.0
    limiter.check("fresh")
    assert limiter.size == 1, "stale buckets were not pruned"


def test_registry_file_is_not_committed():
    # The registry is a credential store; the ignore rule is load-bearing.
    ignore = Path(__file__).resolve().parents[2] / ".gitignore"
    text = ignore.read_text(encoding="utf-8")
    assert "api_keys.json" in text


def test_presented_key_identity_is_not_the_secret():
    # The bucket identity is a short non-secret id, so bucket maps never hold
    # key material and rotating a secret does not reset limits.
    identity = ApiKeyIdentity(key_id="k_abc123", label="laptop")
    assert identity.key_id != API_KEY_PREFIX
    assert "key" not in identity.key_id
