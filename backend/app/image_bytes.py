"""Inline image ingestion for issue #68.

The extension sends image bytes (base64) or a content hash directly instead of
requiring the backend to re-scrape Instagram, which mostly hits login walls.

Every field here is client-controlled and reaches Pillow, so validation is
strict:

- base64 is decoded with ``validate=True`` (no silent skipping of garbage),
- the decoded bytes are checked against magic-byte signatures for the declared
  MIME type,
- the SHA-256 of the decoded bytes must match the client-supplied
  ``content_sha256`` (proves the bytes are what the extension hashed),
- Pillow verifies the payload is a real image and the pixel/dimension budget
  is enforced to bound CPU and memory.

No network fetch happens on this path, so the SSRF surface in
:mod:`app.url_safety` is never consulted for inline images.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import logging
from typing import Any, List, Sequence, Tuple

from PIL import Image

logger = logging.getLogger(__name__)


class ImageRejected(ValueError):
    """A client-supplied image failed validation. Message names the rule only."""


# ~2.7 MiB of raw bytes once decoded (base64 inflates by 4/3). Large enough for
# phone screenshots after downscaling, small enough to bound memory per request.
MAX_IMAGE_BYTES = 3 * 1024 * 1024
# Base64 chars ceiling for the same payload plus MIME framing headroom.
MAX_BASE64_CHARS = 4_000_000
# Pillow dimension cap per axis; larger images are rejected, not downscaled, so
# a malicious header cannot force a giant allocation.
MAX_DIMENSION = 4096
# Total pixel budget (~12 MP). Stops decompression-bomb style payloads whose
# dimensions are individually legal but whose area is not.
MAX_PIXELS = 4096 * 3072
# Max inline images per request (mirrors AnalyzeUrlRequest limit).
MAX_INLINE_IMAGES = 3

_ALLOWED_MIME_TYPES = ("image/jpeg", "image/png", "image/webp")

# Magic-byte prefixes per MIME type. WebP is RIFF....WEBP (bytes 0-3 RIFF,
# bytes 8-11 WEBP).
_MAGIC_PREFIXES = {
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/webp": (b"RIFF",),
}


def _check_magic(mime_type: str, raw: bytes) -> None:
    prefixes = _MAGIC_PREFIXES.get(mime_type)
    if prefixes is None:
        raise ImageRejected(f"unsupported image type {mime_type!r}")
    if mime_type == "image/webp":
        if not (raw.startswith(b"RIFF") and len(raw) >= 12 and raw[8:12] == b"WEBP"):
            raise ImageRejected("bytes do not match declared type image/webp")
        return
    if not any(raw.startswith(p) for p in prefixes):
        raise ImageRejected(f"bytes do not match declared type {mime_type}")


def _coerce_fields(item: Any) -> tuple[Any, Any, Any, Any, Any]:
    """Read the five InlineImage fields off a Pydantic model or plain dict."""
    if isinstance(item, dict):
        mime_type = item.get("mime_type")
        data_base64 = item.get("data_base64")
        content_sha256 = item.get("content_sha256")
        width = item.get("width")
        height = item.get("height")
    else:
        mime_type = getattr(item, "mime_type", None)
        data_base64 = getattr(item, "data_base64", None)
        content_sha256 = getattr(item, "content_sha256", None)
        width = getattr(item, "width", None)
        height = getattr(item, "height", None)
    return mime_type, data_base64, content_sha256, width, height


def decode_inline_images(images: Sequence[Any]) -> List[Tuple[Image.Image, str]]:
    """Decode and verify a batch of client-supplied inline images.

    Returns a list of ``(PIL image in RGB, hex digest)`` tuples in request
    order, ready for :func:`app.post_classifier.extract_text_from_images`.

    Raises :class:`ImageRejected` on the first invalid image; the message
    names the rule, never the payload.
    """
    if len(images) > MAX_INLINE_IMAGES:
        raise ImageRejected(f"too many inline images (max {MAX_INLINE_IMAGES})")

    decoded: List[Tuple[Image.Image, str]] = []
    for index, item in enumerate(images):
        mime_type, data_base64, content_sha256, width, height = _coerce_fields(item)

        if mime_type not in _ALLOWED_MIME_TYPES:
            raise ImageRejected(f"image {index}: unsupported image type")
        if not isinstance(data_base64, str) or not data_base64:
            raise ImageRejected(f"image {index}: missing image data")
        if len(data_base64) > MAX_BASE64_CHARS:
            raise ImageRejected(f"image {index}: image data too large")
        if (
            not isinstance(content_sha256, str)
            or len(content_sha256) != 64
            or any(c not in "0123456789abcdefABCDEF" for c in content_sha256)
        ):
            raise ImageRejected(f"image {index}: bad content hash")

        try:
            raw = base64.b64decode(data_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ImageRejected(f"image {index}: invalid base64 data") from exc

        if not raw:
            raise ImageRejected(f"image {index}: empty image data")
        if len(raw) > MAX_IMAGE_BYTES:
            raise ImageRejected(f"image {index}: image data too large")

        _check_magic(mime_type, raw)

        digest = hashlib.sha256(raw).hexdigest()
        if digest.lower() != content_sha256.lower():
            raise ImageRejected(f"image {index}: content hash mismatch")

        try:
            image = Image.open(io.BytesIO(raw))
            image.load()
        except Exception as exc:
            raise ImageRejected(f"image {index}: unreadable image data") from exc

        if image.width <= 0 or image.height <= 0:
            raise ImageRejected(f"image {index}: invalid image dimensions")
        if image.width > MAX_DIMENSION or image.height > MAX_DIMENSION:
            raise ImageRejected(f"image {index}: image dimensions too large")
        if image.width * image.height > MAX_PIXELS:
            raise ImageRejected(f"image {index}: image has too many pixels")

        # Declared dimensions are advisory; a mismatch means the client is
        # confused or lying, so reject rather than silently reinterpret.
        if width is not None and int(width) != image.width:
            raise ImageRejected(f"image {index}: width does not match image data")
        if height is not None and int(height) != image.height:
            raise ImageRejected(f"image {index}: height does not match image data")

        logger.debug(
            "inline image %d accepted type=%s %dx%d sha=%s",
            index,
            mime_type,
            image.width,
            image.height,
            digest[:12],
        )
        decoded.append((image.convert("RGB"), digest))

    return decoded
