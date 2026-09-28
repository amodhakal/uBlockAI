import argparse
import io
import json
import logging
import re
from typing import List
from urllib.parse import urljoin, urlparse

import pytesseract
import requests
from bs4 import BeautifulSoup
from PIL import Image, ImageEnhance, ImageOps

from app.url_safety import UnsafeUrlError, validate_url

logger = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)

MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024


def _session() -> requests.Session:
    sess = requests.Session()
    sess.headers.update({"User-Agent": USER_AGENT})
    return sess


def _is_image_url(url: str) -> bool:
    parsed = urlparse(url)
    return bool(re.search(r"\.(png|jpe?g|webp|bmp)$", parsed.path.lower()))


def _is_allowed_image_candidate(url: str) -> bool:
    """Whether a discovered image URL is on an allowed CDN.

    The check used to be the substring ``"instagram" in candidate``, which
    matched any URL containing those characters anywhere. A host such as
    ``instagram.com.evil.net`` or ``notinstagram.com`` passed, and so did a
    query string carrying the word. The host is now parsed and compared against
    the allowlist as a registrable domain.
    """
    try:
        validate_url(url)
    except UnsafeUrlError:
        return False
    return True


def _extract_image_urls(post_url: str, max_images: int = 3) -> List[str]:
    # Validate before any network access. post_url is client-supplied, so this
    # is the boundary that stops the backend being used to reach internal
    # addresses and cloud metadata endpoints.
    post_url = validate_url(post_url)

    if _is_image_url(post_url):
        return [post_url]

    sess = _session()
    response = sess.get(post_url, timeout=15)
    response.raise_for_status()

    content_type = response.headers.get("content-type", "").lower()
    if content_type.startswith("image/"):
        return [post_url]

    soup = BeautifulSoup(response.text, "html.parser")
    candidates: List[str] = []

    for attr in [("property", "og:image"), ("name", "twitter:image")]:
        tag = soup.find("meta", attrs={attr[0]: attr[1]})
        if tag and tag.get("content"):
            candidates.append(urljoin(post_url, tag["content"]))

    for img in soup.find_all("img", src=True):
        candidates.append(urljoin(post_url, img["src"]))

    seen = set()
    image_urls: List[str] = []
    for candidate in candidates:
        if candidate in seen:
            continue
        if not _is_allowed_image_candidate(candidate):
            logger.debug("skipping image candidate outside allowlist")
            continue
        seen.add(candidate)
        image_urls.append(candidate)
        if len(image_urls) >= max_images:
            break

    return image_urls


def _download_image(url: str) -> Image.Image:
    # Re-validate: this URL came out of a remote document, so it is attacker
    # influenced even when post_url itself was well formed.
    url = validate_url(url)
    sess = _session()
    response = sess.get(url, timeout=15, stream=True)
    response.raise_for_status()

    declared = response.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_DOWNLOAD_BYTES:
        raise ValueError(f"image exceeds {MAX_DOWNLOAD_BYTES} bytes")

    chunks: List[bytes] = []
    total = 0
    for chunk in response.iter_content(chunk_size=64 * 1024):
        total += len(chunk)
        if total > MAX_DOWNLOAD_BYTES:
            raise ValueError(f"image exceeds {MAX_DOWNLOAD_BYTES} bytes")
        chunks.append(chunk)

    return Image.open(io.BytesIO(b"".join(chunks))).convert("RGB")


def _preprocess_for_ocr(image: Image.Image, ocr_profile: str) -> List[Image.Image]:
    resized = image.resize(
        (max(1, image.width * 2), max(1, image.height * 2)),
        Image.Resampling.LANCZOS,
    )
    gray = ImageOps.grayscale(resized)
    boosted_contrast = ImageEnhance.Contrast(gray).enhance(2.0)
    autocontrast = ImageOps.autocontrast(boosted_contrast)
    thresholded = autocontrast.point(lambda value: 0 if value < 180 else 255)
    if ocr_profile == "fast":
        return [autocontrast, thresholded]

    inverted = ImageOps.invert(autocontrast)
    inverted_thresholded = inverted.point(lambda value: 0 if value < 180 else 255)
    red_channel, green_channel, blue_channel = resized.split()
    return [
        resized,
        gray,
        autocontrast,
        thresholded,
        inverted,
        inverted_thresholded,
        ImageOps.autocontrast(red_channel),
        ImageOps.autocontrast(green_channel),
        ImageOps.autocontrast(blue_channel),
    ]


def _ocr_psm_modes(ocr_profile: str) -> tuple[str, ...]:
    if ocr_profile == "fast":
        return ("--psm 6",)
    return ("--psm 6", "--psm 11")


def _ocr_text_score(text: str) -> int:
    stripped = text.strip()
    if not stripped:
        return 0
    alnum_count = sum(char.isalnum() for char in stripped)
    word_count = len(re.findall(r"[A-Za-z0-9]{2,}", stripped))
    non_empty_lines = len([line for line in stripped.splitlines() if line.strip()])
    return alnum_count + (word_count * 3) + non_empty_lines


def _line_quality_score(line: str) -> int:
    alpha_count = sum(char.isalpha() for char in line)
    digit_count = sum(char.isdigit() for char in line)
    symbol_count = sum(not char.isalnum() and not char.isspace() for char in line)
    word_count = len(re.findall(r"[A-Za-z]{2,}", line))
    return (alpha_count * 2) + digit_count + (word_count * 3) - (symbol_count * 2)


def _is_reasonable_ocr_line(line: str) -> bool:
    stripped = line.strip()
    if len(stripped) < 6:
        return False
    alpha_count = sum(char.isalpha() for char in stripped)
    if alpha_count < 4:
        return False
    symbol_count = sum(not char.isalnum() and not char.isspace() for char in stripped)
    if symbol_count > max(4, len(stripped) // 4):
        return False
    return _line_quality_score(stripped) >= 12


def _extract_best_text_from_image(image: Image.Image, ocr_profile: str) -> str:
    candidates: List[str] = []
    for processed in _preprocess_for_ocr(image, ocr_profile=ocr_profile):
        for psm_mode in _ocr_psm_modes(ocr_profile):
            text = pytesseract.image_to_string(processed, config=psm_mode).strip()
            if text:
                candidates.append(text)
    if not candidates:
        return ""
    merged_lines: List[str] = []
    seen_normalized: set[str] = set()
    scored_candidates = sorted(candidates, key=_ocr_text_score, reverse=True)
    for candidate in scored_candidates:
        for raw_line in candidate.splitlines():
            line = raw_line.strip()
            if not _is_reasonable_ocr_line(line):
                continue
            normalized = re.sub(r"[^a-z0-9]", "", line.lower())
            if len(normalized) < 4 or normalized in seen_normalized:
                continue
            seen_normalized.add(normalized)
            merged_lines.append(line)
            if len(merged_lines) >= 12:
                return "\n".join(merged_lines)
    if merged_lines:
        return "\n".join(merged_lines)
    return scored_candidates[0]


def _extract_ocr_text(image_urls: List[str], ocr_profile: str) -> tuple[str, List[str]]:
    chunks: List[str] = []
    errors: List[str] = []
    for image_url in image_urls:
        try:
            image = _download_image(image_url)
            text = _extract_best_text_from_image(image, ocr_profile=ocr_profile)
            if text.strip():
                chunks.append(text.strip())
        except Exception as exc:
            errors.append(f"{image_url} -> {type(exc).__name__}: {exc}")
            logger.warning("OCR failed for image: %s", errors[-1])
            continue
    return "\n".join(chunks), errors


def extract_post_text_for_llm(
    post_url: str,
    caption: str = "",
    alt_text: str = "",
    max_images: int = 3,
    ocr_profile: str = "fast",
) -> dict[str, str]:
    if ocr_profile not in {"fast", "accurate"}:
        raise ValueError("ocr_profile must be either 'fast' or 'accurate'")
    image_urls = _extract_image_urls(post_url, max_images=max_images)
    ocr_text, _ = _extract_ocr_text(image_urls, ocr_profile=ocr_profile)
    llm_input_parts = [caption.strip(), alt_text.strip(), ocr_text.strip()]
    llm_input_text = "\n\n".join(part for part in llm_input_parts if part)

    return {
        "llm-input-text": llm_input_text,
        "caption": caption,
        "alt-text": alt_text,
    }


def get_image_data(
    post_url: str,
    caption: str = "",
    alt_text: str = "",
    max_images: int = 3,
    ocr_profile: str = "fast",
    include_caption: bool = True,
) -> str:
    """Run the OCR extraction and return the result as pretty-printed JSON.

    When ``include_caption`` is false the caption is still reported back in its
    own field but is left out of the combined ``llm-input-text`` payload.
    """
    result = extract_post_text_for_llm(
        post_url=post_url,
        caption=caption,
        alt_text=alt_text,
        max_images=max_images,
        ocr_profile=ocr_profile,
    )
    if not include_caption:
        combined = result.get("llm-input-text", "")
        stripped_caption = caption.strip()
        if stripped_caption and combined.startswith(stripped_caption):
            combined = combined[len(stripped_caption) :].lstrip("\n")
        result["llm-input-text"] = combined
    return json.dumps(result, indent=2, ensure_ascii=False)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Extract OCR text from a social post for LLM parsing."
    )
    parser.add_argument("--url", required=True, help="Post URL or direct image URL")
    parser.add_argument("--caption", default="", help="Post caption text")
    parser.add_argument("--alt-text", default="", help="Post alt-text")
    parser.add_argument("--max-images", type=int, default=3, help="Max images to OCR")
    parser.add_argument(
        "--ocr-profile",
        choices=["fast", "accurate"],
        default="fast",
        help="OCR pass profile: fast is quicker with fewer OCR variants; accurate runs more variants",
    )
    parser.add_argument(
        "--include-caption",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "Include the caption in the combined llm-input-text payload. "
            "Enabled by default; pass --no-include-caption to omit it."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    print(
        get_image_data(
            post_url=args.url,
            caption=args.caption,
            alt_text=args.alt_text,
            max_images=args.max_images,
            ocr_profile=args.ocr_profile,
            include_caption=args.include_caption,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())