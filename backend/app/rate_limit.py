"""Per-token rate limiting.

The thing being protected is LLM spend per request, and one analysis is a
multi-second blocking call. A burst of concurrent requests from a single token
already destroys the budget, so what needs bounding is request *count* over a
coarse interval rather than sub-second smoothness. A fixed window does that with
O(1) memory per key and no timers.

Why not a token bucket: its burst parameter is the actual risk here, since a
bucket would *permit* a burst of N expensive calls by design. Wrong shape.

Why not a sliding window: exact, but O(limit) memory per key and a list
insert/evict per request, to buy precision nobody needs.

The classic fixed-window boundary burst (up to 2x the limit across a window
edge) is acceptable precisely because a single window already permits `limit`
expensive calls, and the default limit is set at a level that can be lost twice.

State is per-process, guarded by a threading.Lock. The views run on one event
loop per worker process, so the lock is not strictly needed for the async path,
but the OCR work runs through asyncio.to_thread and any future sync view would
re-enter. It is free.

The honest limitation: with ``workers x threads`` worker threads, the effective
global limit is that multiple of the per-process limit. That is acceptable at
this scale and is stated in the gunicorn startup log rather than hidden.
"""

from __future__ import annotations

import functools
import logging
import threading
import time
from dataclasses import dataclass
from typing import Callable, Dict, Optional

from flask import g
from werkzeug.exceptions import HTTPException

from app.auth import current_identity

logger = logging.getLogger(__name__)

# Requests per window, per token, per route group.
DEFAULT_ANALYZE_LIMIT = 20
DEFAULT_FEEDBACK_LIMIT = 60
DEFAULT_WINDOW_SECONDS = 60

# Upper bound on tracked buckets, as a guard against unbounded growth.
MAX_TRACKED_KEYS = 4096

# Rate-limit headers, also exposed to the browser via CORS.
HEADER_LIMIT = "X-RateLimit-Limit"
HEADER_REMAINING = "X-RateLimit-Remaining"
HEADER_RESET = "X-RateLimit-Reset"
HEADER_RETRY_AFTER = "Retry-After"

GENERIC_RATE_LIMIT_ERROR = "Rate limit exceeded."

# Route groups, so a token cannot spend its analysis budget on feedback or
# vice versa. The single and batch analysis endpoints deliberately share one
# group: otherwise batch is a straight multiplier on cost.
ROUTE_GROUPS: Dict[str, int] = {
    "analyze": DEFAULT_ANALYZE_LIMIT,
    "feedback": DEFAULT_FEEDBACK_LIMIT,
}


class RateLimitExceeded(HTTPException):
    """429 with the standard budget headers.

    Raised rather than calling abort() with response_headers, because
    werkzeug's RetryAfter overrides __init__ and does not accept it, so the
    headers were silently impossible to attach that way.
    """

    code = 429

    def __init__(self, retry_after: int, limit: int, remaining: int = 0):
        super().__init__(description=GENERIC_RATE_LIMIT_ERROR)
        self.retry_after = retry_after
        self.limit = limit
        self.remaining = remaining
        self.response = None


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    limit: int
    remaining: int
    reset_after: int

    def headers(self) -> Dict[str, str]:
        return {
            HEADER_LIMIT: str(self.limit),
            HEADER_REMAINING: str(self.remaining),
            HEADER_RESET: str(self.reset_after),
        }


@dataclass
class _Bucket:
    count: int
    window_start: float


class InMemoryRateLimiter:
    """Fixed-window counter, per bucket."""

    def __init__(
        self,
        limit: int,
        window_seconds: int = DEFAULT_WINDOW_SECONDS,
        max_keys: int = MAX_TRACKED_KEYS,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.limit = limit
        self.window_seconds = window_seconds
        self.max_keys = max_keys
        self._clock = clock
        self._buckets: Dict[str, _Bucket] = {}
        self._lock = threading.Lock()

    def check(self, bucket: str, limit: Optional[int] = None) -> RateLimitDecision:
        effective_limit = self.limit if limit is None else limit
        now = self._clock()

        with self._lock:
            self.prune_expired(now)

            entry = self._buckets.get(bucket)
            if entry is None or (now - entry.window_start) >= self.window_seconds:
                entry = _Bucket(count=0, window_start=now)
                self._buckets[bucket] = entry
                if len(self._buckets) > self.max_keys:
                    self._evict_oldest_locked()

            entry.count += 1
            reset_after = max(0, int(self.window_seconds - (now - entry.window_start)))
            allowed = entry.count <= effective_limit
            remaining = max(0, effective_limit - entry.count)

        return RateLimitDecision(
            allowed=allowed,
            limit=effective_limit,
            remaining=remaining,
            reset_after=reset_after,
        )

    def prune_expired(self, now: Optional[float] = None) -> int:
        """Drop buckets whose window has closed. Caller must hold the lock."""
        if now is None:
            now = self._clock()
        stale = [
            key
            for key, entry in self._buckets.items()
            if (now - entry.window_start) >= self.window_seconds
        ]
        for key in stale:
            del self._buckets[key]
        return len(stale)

    def _evict_oldest_locked(self) -> None:
        if not self._buckets:
            return
        oldest = min(self._buckets, key=lambda k: self._buckets[k].window_start)
        del self._buckets[oldest]

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()

    @property
    def size(self) -> int:
        return len(self._buckets)


# One limiter per route group, since the limits differ.
_LIMITERS: Dict[str, InMemoryRateLimiter] = {}


def get_limiter(group: str) -> InMemoryRateLimiter:
    limiter = _LIMITERS.get(group)
    if limiter is None:
        limiter = InMemoryRateLimiter(ROUTE_GROUPS.get(group, DEFAULT_ANALYZE_LIMIT))
        _LIMITERS[group] = limiter
    return limiter


def reset_limiters() -> None:
    """Drop all limiter state. Used by tests."""
    for limiter in _LIMITERS.values():
        limiter.reset()


def require_rate_limit(group: str) -> Callable:
    """Bound a route by the calling token's budget for ``group``."""

    def decorator(view: Callable) -> Callable:
        @functools.wraps(view)
        async def wrapper(*args, **kwargs):
            limiter = get_limiter(group)
            identity = current_identity()
            bucket = f"{identity.key_id}:{group}"
            decision = limiter.check(bucket)
            g.rate_limit = decision

            if not decision.allowed:
                logger.warning(
                    "rate limit exceeded group=%s key_id=%s limit=%d",
                    group,
                    identity.key_id,
                    decision.limit,
                )
                raise RateLimitExceeded(
                    retry_after=decision.reset_after,
                    limit=decision.limit,
                    remaining=decision.remaining,
                )
            return await view(*args, **kwargs)

        return wrapper

    return decorator


def current_decision() -> Optional[RateLimitDecision]:
    return getattr(g, "rate_limit", None)
