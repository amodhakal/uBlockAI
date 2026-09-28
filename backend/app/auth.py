"""API key authentication.

The analysis endpoint costs real money per call and had no authentication at
all, so anyone who learned the URL could drive the LLM bill.

Design notes
------------
* Keys are ``ubk_`` + 43 base64url characters, which is exactly one
  ``secrets.token_urlsafe(32)``. The prefix makes keys recognisable in logs and
  config, and lets obviously-malformed values be rejected before any hashing.
* Only the SHA-256 of a key is persisted. The plaintext exists once, at mint
  time, in the CLI output. A stolen registry file does not yield working keys.
* The rate-limit bucket identity is the key's short non-secret ``id``, not the
  key itself, so bucket maps never contain key material and rotating a secret
  does not reset its limits.
* ``/api/health`` stays unauthenticated: an orchestrator cannot hold an API key,
  and liveness must not depend on credential validity.
"""

from __future__ import annotations

import functools
import hashlib
import hmac
import json
import logging
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, NamedTuple, Optional


from flask import Response, g, request
from werkzeug.exceptions import HTTPException

from app.config import get_settings

logger = logging.getLogger(__name__)

API_KEY_PREFIX = "ubk_"
API_KEY_HEADER = "X-API-Key"
AUTH_HEADER = "Authorization"
BEARER_PREFIX = "Bearer "
GENERIC_AUTH_ERROR = "Missing or invalid API key."

# Endpoints reachable without a key.
AUTH_EXEMPT_PATHS: frozenset[str] = frozenset({"/api/health"})


class Unauthorized(HTTPException):
    """401 with a generic description.

    Raised rather than calling abort() so the WWW-Authenticate challenge can be
    attached, and so the reason is a typed exception rather than a string.
    """

    code = 401

    def __init__(self, description: str = GENERIC_AUTH_ERROR):
        super().__init__(description=description)
        self.response = Response(
            json.dumps({"error": description}),
            status=401,
            mimetype="application/json",
            headers={"WWW-Authenticate": 'ApiKey realm="uBlockAI"'},
        )


class ApiKeyIdentity(NamedTuple):
    """The resolved owner of a presented key."""

    key_id: str
    label: str


def normalize_presented_key(raw: Optional[str]) -> str:
    """Strip an Authorization bearer prefix and surrounding whitespace."""
    if not raw:
        return ""
    value = raw.strip()
    if value.lower().startswith(BEARER_PREFIX.lower()):
        value = value[len(BEARER_PREFIX) :].strip()
    return value


def presented_key_from_request() -> str:
    """Read the presented key, preferring the unambiguous custom header.

    ``X-API-Key`` wins over ``Authorization`` so a client that sets both is
    unambiguous. Returns "" when neither is present.
    """
    direct = request.headers.get(API_KEY_HEADER)
    if direct and direct.strip():
        return direct.strip()
    return normalize_presented_key(request.headers.get(AUTH_HEADER))


def hash_key(raw_key: str) -> str:
    """Lowercase hex SHA-256 of the key."""
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def generate_key() -> str:
    """Mint a new key. The plaintext is returned once and never stored."""
    return f"{API_KEY_PREFIX}{secrets.token_urlsafe(32)}"


def looks_like_key(raw_key: str) -> bool:
    """Cheap shape check, applied before any hashing."""
    return (
        raw_key.startswith(API_KEY_PREFIX) and len(raw_key) > len(API_KEY_PREFIX) + 16
    )


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------


def _registry_path() -> Path:
    configured = getattr(get_settings(), "api_keys_path", None)
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parent / "api_keys.json"


def load_registry() -> List[Dict[str, Any]]:
    path = _registry_path()
    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        logger.error("api key registry at %s is unreadable: %s", path, exc)
        return []
    keys = data.get("keys") if isinstance(data, dict) else None
    return keys if isinstance(keys, list) else []


def save_registry(keys: List[Dict[str, Any]]) -> None:
    path = _registry_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump({"keys": keys}, handle, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    # The registry is a credential store: keep it owner-only.
    os.chmod(path, 0o600)


def register_key(raw_key: str, label: str) -> str:
    """Store a key's digest. Returns the new key id."""
    keys = load_registry()
    key_id = f"k_{secrets.token_hex(6)}"
    keys.append(
        {
            "id": key_id,
            "sha256": hash_key(raw_key),
            "label": label,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "disabled": False,
        }
    )
    save_registry(keys)
    return key_id


def revoke_key(key_id: str) -> bool:
    keys = load_registry()
    remaining = [k for k in keys if k.get("id") != key_id]
    if len(remaining) == len(keys):
        return False
    save_registry(remaining)
    return True


def resolve_key(raw_key: str) -> Optional[ApiKeyIdentity]:
    """Look up a presented key. Returns None for unknown or disabled keys.

    The digest comparison uses compare_digest so a future refactor to a linear
    scan cannot introduce a timing oracle.
    """
    if not looks_like_key(raw_key):
        return None
    presented = hash_key(raw_key)
    for entry in load_registry():
        stored = entry.get("sha256")
        if not stored:
            continue
        if hmac.compare_digest(str(stored), presented):
            if entry.get("disabled"):
                return None
            return ApiKeyIdentity(str(entry.get("id", "")), str(entry.get("label", "")))
    return None


# --------------------------------------------------------------------------
# View guard
# --------------------------------------------------------------------------


def require_api_key(view: Callable) -> Callable:
    """Reject requests without a valid key.

    Applied as a decorator so a new route cannot be added to the public surface
    by omission the way these two were.
    """

    @functools.wraps(view)
    async def wrapper(*args: Any, **kwargs: Any):
        settings = get_settings()
        if not settings.require_auth:
            g.api_identity = ApiKeyIdentity("anonymous", "auth-disabled")
            return await view(*args, **kwargs)

        if request.path in AUTH_EXEMPT_PATHS:
            return await view(*args, **kwargs)

        presented = presented_key_from_request()
        identity = resolve_key(presented) if presented else None

        if identity is None:
            # Never say which part was wrong, and never echo what was presented.
            logger.warning(
                "rejected unauthenticated request path=%s presented=%s",
                request.path,
                "none" if not presented else "invalid",
            )
            # Never say which part was wrong, and never echo what was
            # presented. main.py's HTTPException handler renders the generic
            # description as JSON.
            raise Unauthorized(GENERIC_AUTH_ERROR)

        g.api_identity = identity
        return await view(*args, **kwargs)

    return wrapper


def current_identity() -> ApiKeyIdentity:
    """The authenticated identity for this request, or anonymous."""
    return getattr(g, "api_identity", None) or ApiKeyIdentity("anonymous", "unknown")
