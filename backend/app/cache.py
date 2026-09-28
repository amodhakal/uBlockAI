"""Content-addressed, in-process TTL cache for analysis results (#65).

The same post gets re-analyzed constantly: a user re-flags it, a feed
re-renders, the extension retries after a timeout, and the batch endpoint
(#74) re-sends a screenful. Every one of those re-runs OCR, the agent, the
web-search tool and the OpenAI call.

The key is derived from the *content* of the request rather than the URL, so a
post re-sent from a different URL still hits. Concretely it is the SHA-256 of
the normalized claim text (caption plus alt text, whitespace- and
case-normalized), the SHA-256 of every supplied image, the model id, and the
image budget. The model id is part of the key on purpose: a cached verdict
produced by a different model is not the same answer, and silently serving it
would make the model id in ``GET /api/health`` a lie.

Scope: this cache is per process. gunicorn runs several worker processes (see
``gunicorn.conf.py``) and each has its own dictionary, so a hit is only
guaranteed within a worker and the effective hit rate is roughly
1/workers for a cold deployment. That is a deliberate trade for having no
Redis dependency and no shared-state failure mode: a cache that is wrong in
one process costs duplicated work, while a shared cache that is wrong costs
wrong answers. Multi-process sharing would need a shared store, and the
per-request cost of an analysis is high enough that even a per-process hit is
worth it.
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
import time
from collections import OrderedDict
from typing import Any, Iterable, Mapping

from app.config import Settings

logger = logging.getLogger(__name__)

# Collapse every run of whitespace to a single space. The extension and the
# OCR pass both produce text that differs only in line breaks and runs of
# spaces for the same visual content, and those differences must not split the
# cache.
_WHITESPACE = re.compile(r"\s+")


def normalize_text(text: str | None) -> str:
    """Casefold and collapse whitespace so cosmetic edits do not miss."""
    if not text:
        return ""
    return _WHITESPACE.sub(" ", text).strip().casefold()


def image_digests(images: Iterable[Any] | None) -> list[str]:
    """Collect the client-computed content hashes of any inline images."""
    if not images:
        return []
    digests = []
    for image in images:
        digest = image.get("content_sha256") if isinstance(image, dict) else None
        if digest is None:
            digest = getattr(image, "content_sha256", None)
        if isinstance(digest, str) and digest:
            # Lowercased: the hash is case-insensitive hex, and the field
            # allows either case.
            digests.append(digest.lower())
    # Sorted so a reordered image list is still the same content.
    return sorted(digests)


def cache_key(
    *,
    url: str,
    caption: str | None,
    alt_text: str | None,
    images: Iterable[Any] | None,
    max_images: int,
    settings: Settings,
) -> str:
    """Build the content-addressed key for one analysis request.

    When the client supplies image bytes (#68) the key is fully content
    addressed: the same caption over the same bytes is the same question, and
    the post URL is not part of it. When it does not, the OCR text is not known
    until after the scrape, so the URL is folded into the key instead --
    otherwise two different posts with an identical caption would collide on a
    key that says nothing about their images.
    """
    parts: list[str] = [
        f"model={settings.openai_model}",
        f"max_images={max_images}",
        f"caption={normalize_text(caption)}",
        f"alt_text={normalize_text(alt_text)}",
    ]

    digests = image_digests(images)
    parts.extend(f"image={digest}" for digest in digests)
    if not digests:
        parts.append(f"url={normalize_text(url)}")

    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


class AnalysisCache:
    """A bounded, TTL'd, thread-safe key/value store.

    Bounded in both dimensions: an unbounded dict is a memory leak on a
    long-lived worker, and an entry that never expires serves a verdict about a
    post that has since been edited or deleted.
    """

    def __init__(
        self, ttl_seconds: int, max_entries: int, clock=time.monotonic
    ) -> None:
        self._ttl = ttl_seconds
        self._max_entries = max_entries
        self._clock = clock
        self._entries: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    @property
    def enabled(self) -> bool:
        return self._ttl > 0 and self._max_entries > 0

    def get(self, key: str) -> Any | None:
        """Return the cached value, or None on miss or expiry."""
        if not self.enabled:
            return None
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                self.misses += 1
                return None
            stored_at, value = entry
            if (self._clock() - stored_at) >= self._ttl:
                # Expired: drop it now so the bound is not spent on it.
                del self._entries[key]
                self.misses += 1
                return None
            # Refresh recency for the eviction order below.
            self._entries.move_to_end(key)
            self.hits += 1
            return value

    def set(self, key: str, value: Any) -> None:
        """Store a value, evicting the least recently used entry if needed."""
        if not self.enabled:
            return
        with self._lock:
            self._entries[key] = (self._clock(), value)
            self._entries.move_to_end(key)
            self._evict_locked()

    def _evict_locked(self) -> None:
        now = self._clock()
        for key in [
            k
            for k, (stored_at, _) in self._entries.items()
            if now - stored_at >= self._ttl
        ]:
            del self._entries[key]
        while len(self._entries) > self._max_entries:
            self._entries.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self.hits = 0
            self.misses = 0

    def stats(self) -> Mapping[str, int]:
        with self._lock:
            return {
                "entries": len(self._entries),
                "hits": self.hits,
                "misses": self.misses,
                "max_entries": self._max_entries,
                "ttl_seconds": self._ttl,
            }


_CACHE: AnalysisCache | None = None
_CACHE_LOCK = threading.Lock()


def get_cache(settings: Settings) -> AnalysisCache:
    """Return the process-wide cache, (re)built if the settings changed.

    Rebuilding on a settings change keeps ``CACHE_TTL_SECONDS=0`` honest: a
    test, or an operator flipping the knob, must not be served entries the
    previous configuration allowed.
    """
    global _CACHE
    ttl = settings.cache_ttl_seconds
    max_entries = settings.cache_max_entries
    with _CACHE_LOCK:
        if _CACHE is None or _CACHE._ttl != ttl or _CACHE._max_entries != max_entries:
            _CACHE = AnalysisCache(ttl_seconds=ttl, max_entries=max_entries)
            logger.info(
                "analysis cache initialized ttl=%ds max_entries=%d", ttl, max_entries
            )
        return _CACHE


def reset_cache() -> None:
    """Drop the process-wide cache. Used by tests."""
    global _CACHE
    with _CACHE_LOCK:
        _CACHE = None
