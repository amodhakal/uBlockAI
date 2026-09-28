"""Shared factory for LLM clients.

Four independent ``ChatOpenAI`` instances were previously constructed across
``agents/langchain_agent.py``, ``tools/web_search_tool.py`` and
``tools/credibility_tool.py`` (twice), each pinning its own copy of the model
name and API key. Changing the model meant editing four files and missing one
silently left the app running against a different model than intended.

Clients are now built on first use through a single cached factory, so nothing
touches the OpenAI SDK at import time.
"""

from __future__ import annotations

from functools import lru_cache

from langchain_openai import ChatOpenAI
from pydantic import SecretStr

from app.config import get_settings


@lru_cache(maxsize=8)
def _build_chat_model(
    model: str, temperature: float, api_key: str, timeout: float | None
) -> ChatOpenAI:
    return ChatOpenAI(
        model=model,
        temperature=temperature,
        # SecretStr so the key is not rendered by repr() or logged if the
        # client object is ever printed.
        api_key=SecretStr(api_key),
        timeout=timeout,
        max_retries=2,
    )


def get_chat_model(
    *,
    model: str | None = None,
    temperature: float | None = None,
    timeout: float | None = None,
    api_key: str | None = None,
) -> ChatOpenAI:
    """Return a cached ``ChatOpenAI`` client.

    Defaults come from :mod:`app.config`, so the model id and key are defined
    in exactly one place. Callers that need a different model (for example a
    cheaper planning pass) can pass one explicitly.
    """
    settings = get_settings()
    resolved_key = (api_key or "").strip() or settings.require_api_key()
    return _build_chat_model(
        model or settings.openai_model,
        settings.openai_temperature if temperature is None else temperature,
        resolved_key,
        timeout,
    )


def reset_client_cache() -> None:
    """Drop cached clients. Used by tests that patch the environment."""
    _build_chat_model.cache_clear()
