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

    import app.config as config

    config.reset_settings_cache()
    yield config.get_settings()
    config.reset_settings_cache()
