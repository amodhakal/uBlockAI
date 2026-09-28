"""Validation of client-supplied inline image bytes (#68).

The extension sends the bytes instead of a URL the backend has to scrape, so
this is the only gate on untrusted, attacker-chosen data that reaches Pillow.
"""

import base64
import hashlib
import io

import pytest
from PIL import Image

from app.image_bytes import (
    MAX_BASE64_CHARS,
    ImageRejected,
    decode_inline_images,
)


def _encode(image: Image.Image, fmt: str = "PNG") -> str:
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _inline(
    image: Image.Image, fmt: str = "PNG", mime_type: str = "image/png", **overrides
):
    data = _encode(image, fmt=fmt)
    payload = {
        "mime_type": mime_type,
        "data_base64": data,
        "content_sha256": hashlib.sha256(base64.b64decode(data)).hexdigest(),
        "width": image.width,
        "height": image.height,
    }
    payload.update(overrides)
    return payload


# --------------------------------------------------------------------------
# The happy path
# --------------------------------------------------------------------------


def test_valid_png_is_decoded_and_hashed():
    image = Image.new("RGB", (8, 4), (10, 20, 30))
    decoded = decode_inline_images([_inline(image)])

    assert len(decoded) == 1
    decoded_image, digest = decoded[0]
    assert (decoded_image.width, decoded_image.height) == (8, 4)
    assert digest == hashlib.sha256(base64.b64decode(_encode(image))).hexdigest()


def test_order_is_preserved():
    images = [Image.new("RGB", (4, 4), (i, i, i)) for i in (1, 2, 3)]
    decoded = decode_inline_images([_inline(img) for img in images])
    assert [img.width for img, _ in decoded] == [4, 4, 4]
    assert [digest for _, digest in decoded] == [
        hashlib.sha256(base64.b64decode(_encode(img))).hexdigest() for img in images
    ]


def test_batch_over_the_limit_is_rejected():
    image = Image.new("RGB", (4, 4), (0, 0, 0))
    with pytest.raises(ImageRejected):
        decode_inline_images([_inline(image)] * 4)


# --------------------------------------------------------------------------
# Rejections: everything here is attacker-controlled input
# --------------------------------------------------------------------------


def test_non_base64_payload_is_rejected():
    with pytest.raises(ImageRejected):
        decode_inline_images(
            [_inline(Image.new("RGB", (4, 4)), data_base64="not base64!!")]
        )


def test_magic_bytes_must_match_the_declared_type():
    # A real PNG announced as a JPEG: the hash still matches, the bytes do not.
    png = _inline(Image.new("RGB", (4, 4)), mime_type="image/jpeg")
    with pytest.raises(ImageRejected):
        decode_inline_images([png])


def test_webp_must_carry_the_webp_riff_tag():
    image = Image.new("RGB", (4, 4))
    data = _encode(image, fmt="PNG")
    payload = {
        "mime_type": "image/webp",
        "data_base64": data,
        "content_sha256": hashlib.sha256(base64.b64decode(data)).hexdigest(),
    }
    with pytest.raises(ImageRejected):
        decode_inline_images([payload])


def test_content_hash_must_match_the_bytes():
    payload = _inline(Image.new("RGB", (4, 4)))
    payload["content_sha256"] = "0" * 64
    with pytest.raises(ImageRejected):
        decode_inline_images([payload])


def test_declared_dimensions_must_match_the_image():
    payload = _inline(Image.new("RGB", (8, 8)))
    payload["width"] = 9
    with pytest.raises(ImageRejected):
        decode_inline_images([payload])


def test_oversized_base64_is_rejected_before_decoding():
    payload = _inline(Image.new("RGB", (4, 4)))
    payload["data_base64"] = "A" * (MAX_BASE64_CHARS + 1)
    with pytest.raises(ImageRejected):
        decode_inline_images([payload])


def test_png_header_claiming_a_giant_image_is_rejected():
    """A 1x1 PNG with the IHDR dimensions patched to something absurd."""
    image = Image.new("RGB", (1, 1))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    raw = bytearray(buffer.getvalue())
    ihdr = raw.index(b"IHDR")
    raw[ihdr + 4 : ihdr + 8] = (60000).to_bytes(4, "big")
    raw[ihdr + 8 : ihdr + 12] = (60000).to_bytes(4, "big")
    # Fix the zlib payload is not possible cheaply, so this must fail as
    # "unreadable" or "too large" -- never as an accepted giant image.
    data = base64.b64encode(bytes(raw)).decode("ascii")
    payload = {
        "mime_type": "image/png",
        "data_base64": data,
        "content_sha256": hashlib.sha256(bytes(raw)).hexdigest(),
    }
    with pytest.raises(ImageRejected):
        decode_inline_images([payload])


def test_malformed_content_hash_is_rejected():
    payload = _inline(Image.new("RGB", (4, 4)))
    payload["content_sha256"] = "xyz"
    with pytest.raises(ImageRejected):
        decode_inline_images([payload])


# --------------------------------------------------------------------------
# Supplied bytes must actually replace the scrape
# --------------------------------------------------------------------------


def test_supplied_images_skip_the_scrape_entirely(monkeypatch):
    from app import post_classifier

    def _explode(*_args, **_kwargs):
        raise AssertionError("the scrape path must not run when bytes are supplied")

    monkeypatch.setattr(post_classifier, "_extract_image_urls", _explode)
    monkeypatch.setattr(
        post_classifier, "_extract_best_text_from_image", lambda *_a, **_k: "OCR TEXT"
    )

    result = post_classifier.extract_post_text_for_llm(
        post_url="https://www.instagram.com/p/whatever/",
        caption="a caption",
        alt_text="",
        images=[(Image.new("RGB", (4, 4)), "a" * 64)],
    )

    assert "OCR TEXT" in result["llm-input-text"]
    assert "a caption" in result["llm-input-text"]


def test_ocr_failure_on_one_image_is_reported_but_not_fatal(monkeypatch):
    from app import post_classifier

    def _boom(_image, **_kwargs):
        raise RuntimeError("tesseract exploded")

    monkeypatch.setattr(post_classifier, "_extract_best_text_from_image", _boom)

    result = post_classifier.extract_post_text_for_llm(
        post_url="https://www.instagram.com/p/whatever/",
        caption="",
        images=[(Image.new("RGB", (4, 4)), "b" * 64)],
    )

    assert result["llm-input-text"] == ""
    assert "ocr-errors" in result
