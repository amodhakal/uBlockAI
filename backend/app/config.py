"""Centralized, validated application configuration.

Every tunable the backend needs is resolved here once, at call time, so that:

- Importing any module never depends on the environment being set up. LLM
  clients used to be constructed at module import time, which meant a missing
  ``OPENAI_API_KEY`` produced a raw ``openai.OpenAIError`` from deep inside the
  SDK before any friendly validation could run.
- The model id lives in one place instead of being hardcoded in four modules.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

APP_DIR = Path(__file__).resolve().parent
BACKEND_DIR = APP_DIR.parent
ENV_PATH = APP_DIR / ".env"

# Load .env before reading anything, but never override a real environment
# variable: in production the environment wins over the file.
load_dotenv(ENV_PATH)

DEFAULT_OPENAI_MODEL = "gpt-4o"
DEFAULT_OCR_PROFILE = "fast"
DEFAULT_MAX_IMAGES = 3


class ConfigurationError(RuntimeError):
    """Raised when required configuration is missing or malformed."""


def _read_int(name: str, default: int, *, minimum: int = 1) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer, got {raw!r}") from exc
    if value < minimum:
        raise ConfigurationError(f"{name} must be >= {minimum}, got {value}")
    return value


def _read_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be a number, got {raw!r}") from exc


def _read_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    """Immutable snapshot of backend configuration."""

    openai_api_key: str
    openai_model: str
    openai_temperature: float
    brave_api_key: str | None
    debug: bool
    default_ocr_profile: str
    max_images: int
    feedback_dir: Path
    allowed_origins: tuple[str, ...] = ()
    api_keys_path: Path | None = None
    require_auth: bool = True
    analyze_rate_limit: int = 20
    feedback_rate_limit: int = 60
    rate_window_seconds: int = 60
    # Analysis cache. 0 disables it; the default of one hour is long enough to
    # absorb the re-flags, retries and re-renders of a single post without
    # serving a verdict about content that has since changed.
    cache_ttl_seconds: int = 3600
    cache_max_entries: int = 256

    def require_api_key(self) -> str:
        if not self.openai_api_key:
            raise ConfigurationError(
                "OPENAI_API_KEY environment variable is not set. "
                f"Set it in the environment or in {ENV_PATH}."
            )
        return self.openai_api_key


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Build and cache the settings snapshot.

    A missing ``OPENAI_API_KEY`` does not raise here; it raises when a client is
    actually requested via :meth:`Settings.require_api_key`. That keeps import
    side-effect free while still failing loudly and clearly at the point of use.
    """
    origins_raw = os.getenv("ALLOWED_ORIGINS", "")
    allowed_origins = tuple(
        origin.strip() for origin in origins_raw.split(",") if origin.strip()
    )

    return Settings(
        openai_api_key=(os.getenv("OPENAI_API_KEY") or "").strip(),
        openai_model=(os.getenv("OPENAI_MODEL") or DEFAULT_OPENAI_MODEL).strip(),
        openai_temperature=_read_float("OPENAI_TEMPERATURE", 0.0),
        brave_api_key=(os.getenv("BRAVE_API_KEY") or "").strip() or None,
        debug=_read_bool("DEBUG", False),
        default_ocr_profile=(os.getenv("OCR_PROFILE") or DEFAULT_OCR_PROFILE).strip(),
        max_images=_read_int("MAX_IMAGES", DEFAULT_MAX_IMAGES),
        feedback_dir=APP_DIR / "feedback",
        allowed_origins=allowed_origins,
        api_keys_path=(
            Path(os.environ["API_KEYS_PATH"]) if os.getenv("API_KEYS_PATH") else None
        ),
        # Fail closed: an unauthenticated analysis endpoint is a billing
        # incident. Operators can disable auth explicitly for local work.
        require_auth=_read_bool("REQUIRE_AUTH", True),
        analyze_rate_limit=_read_int("ANALYZE_RATE_LIMIT", 20, minimum=1),
        feedback_rate_limit=_read_int("FEEDBACK_RATE_LIMIT", 60, minimum=1),
        rate_window_seconds=_read_int("RATE_WINDOW_SECONDS", 60, minimum=1),
        # minimum=0: zero TTL is the documented way to turn the cache off.
        cache_ttl_seconds=_read_int("CACHE_TTL_SECONDS", 3600, minimum=0),
        cache_max_entries=_read_int("CACHE_MAX_ENTRIES", 256, minimum=0),
    )


def reset_settings_cache() -> None:
    """Drop the cached settings. Used by tests that patch the environment."""
    get_settings.cache_clear()
