"""Structured application logging.

Debug output is opt-in. The extension's log stream and the backend's stdout
previously carried verbose traces including full request payloads, captions and
model output, which is privacy-sensitive: a user's social feed content was
being written to whatever log aggregator the host collected.

Set ``DEBUG=true`` to raise the level. ``LOG_FORMAT=json`` emits one JSON
object per line for log shipping.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from typing import Any, Dict

# Fields whose values must never appear in a log record, at any level.
REDACTED_KEYS = frozenset(
    {
        "api_key",
        "apikey",
        "authorization",
        "openai_api_key",
        "brave_api_key",
        "token",
        "secret",
        "password",
        "cookie",
        "set-cookie",
    }
)

REDACTION_PLACEHOLDER = "[redacted]"

# Longest single value rendered before truncation. Keeps a stray full document
# from filling the log.
MAX_VALUE_CHARS = 300

_configured = False


def redact(value: Any, _depth: int = 0) -> Any:
    """Recursively redact sensitive keys and bound value sizes.

    Numbers, booleans and None are returned unchanged. Coercing them to str
    would break printf-style format specs in log calls, so a line like
    ``logger.info("score=%.2f", score)`` would raise at format time.
    """
    if _depth > 6:
        return REDACTION_PLACEHOLDER

    if isinstance(value, bool) or value is None:
        return value

    if isinstance(value, (int, float)):
        return value

    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for key, item in value.items():
            if str(key).lower() in REDACTED_KEYS:
                out[str(key)] = REDACTION_PLACEHOLDER
            else:
                out[str(key)] = redact(item, _depth + 1)
        return out

    if isinstance(value, (list, tuple)):
        rendered = [redact(v, _depth + 1) for v in value]
        if len(rendered) > 25:
            return rendered[:25] + [f"... {len(rendered) - 25} more items"]
        return rendered

    text = str(value)
    if len(text) > MAX_VALUE_CHARS:
        return text[:MAX_VALUE_CHARS] + f"... [{len(text)} chars]"
    return text


class RedactingFilter(logging.Filter):
    """Redact sensitive material and bound record size.

    Applied to every record, including from third-party libraries, so a library
    that logs a request object cannot leak a key that redaction elsewhere would
    have caught.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, dict):
            record.args = redact(record.args)
        elif isinstance(record.args, tuple):
            record.args = tuple(redact(a) for a in record.args)
        elif record.args is not None:
            record.args = redact(record.args)
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging(force: bool = False) -> None:
    """Install the root log handler. Idempotent."""
    global _configured
    if _configured and not force:
        return

    debug = os.getenv("DEBUG", "").strip().lower() in {"1", "true", "yes", "on"}
    level = logging.DEBUG if debug else logging.INFO
    as_json = os.getenv("LOG_FORMAT", "").strip().lower() == "json"

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        JsonFormatter()
        if as_json
        else logging.Formatter("%(levelname)s %(name)s: %(message)s")
    )
    handler.addFilter(RedactingFilter())

    root = logging.getLogger()
    # Replace any handler we previously installed rather than stacking a second
    # one, which would duplicate every line.
    for existing in list(root.handlers):
        if getattr(existing, "_ublockai", False):
            root.removeHandler(existing)
    handler._ublockai = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    root.setLevel(level)

    # These are chatty at DEBUG and say nothing useful to us.
    for noisy in ("httpx", "httpcore", "urllib3", "openai", "openai._base_client"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _configured = True


def get_logger(name: str) -> logging.Logger:
    configure_logging()
    return logging.getLogger(name)


def debug_enabled() -> bool:
    return logging.getLogger().getEffectiveLevel() <= logging.DEBUG
