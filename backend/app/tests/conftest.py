"""Shared pytest fixtures."""

import sys
from pathlib import Path

import pytest

# Make the `app` package importable when pytest is run from the backend root.
BACKEND_ROOT = Path(__file__).resolve().parents[2]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


@pytest.fixture(autouse=True)
def _isolated_settings(tmp_path, monkeypatch):
    """Point settings at a temp directory and a dummy key for every test."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-real-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o")
    monkeypatch.delenv("DEBUG", raising=False)
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    # Auth is on by default in production, so tests must opt out explicitly.
    monkeypatch.setenv("REQUIRE_AUTH", "false")
    monkeypatch.setenv("API_KEYS_PATH", str(tmp_path / "api_keys.json"))

    import app.cache as cache
    import app.config as config
    import app.rate_limit as rate_limit

    config.reset_settings_cache()
    yield config.get_settings()
    rate_limit.reset_limiters()
    cache.reset_cache()
    config.reset_settings_cache()
