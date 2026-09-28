import argparse
import io
import json
import logging
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from typing import List
from urllib.parse import urljoin, urlparse

import pytesseract
import requests
from bs4 import BeautifulSoup, Tag
from PIL import Image, ImageEnhance, ImageOps

from app.url_safety import UnsafeUrlError, validate_url

logger = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)

MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024

# Tesseract runs out-of-process, so this bounds subprocess concurrency rather
# than threads doing Python work.
OCR_MAX_WORKERS = 6


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
        # BeautifulSoup types a find() result as Tag | NavigableString, and an
        # attribute value as str | list[str]. Narrow rather than cast, so a
        # malformed document cannot put a list into urljoin.
        if not isinstance(tag, Tag):
            continue
        content = tag.get("content")
        if isinstance(content, str) and content.strip():
            candidates.append(urljoin(post_url, content.strip()))

    for img in soup.find_all("img", src=True):
        if not isinstance(img, Tag):
            continue
        src = img.get("src")
        if isinstance(src, str) and src.strip():
            candidates.append(urljoin(post_url, src.strip()))

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


def _base_preprocess(image: Image.Image) -> dict:
    resized = image.resize(
        (max(1, image.width * 2), max(1, image.height * 2)),
        Image.Resampling.LANCZOS,
    )
    gray = ImageOps.grayscale(resized)
    boosted_contrast = ImageEnhance.Contrast(gray).enhance(2.0)
    autocontrast = ImageOps.autocontrast(boosted_contrast)
    return {
        "resized": resized,
        "gray": gray,
        "autocontrast": autocontrast,
        "thresholded": autocontrast.point(lambda value: 0 if value < 180 else 255),
        "inverted": ImageOps.invert(autocontrast),
    }


def _is_grayscale(image: Image.Image) -> bool:
    """True when the red, green and blue bands carry the same value range.

    Screenshots and most text memes are grayscale, and for those the three
    per-channel variants produce identical images. Recognising that removes two
    thirds of that part of the grid for the common case.

    The test compares the per-band (min, max) ranges against each other rather
    than checking that each band is constant: a solid red image has a constant
    range in every band, but its three ranges differ, so it is correctly
    reported as coloured.
    """
    try:
        extrema = image.convert("RGB").getextrema()
    except ValueError:
        return False
    return len(set(extrema)) == 1


def _build_ocr_variants(
    image: Image.Image, ocr_profile: str
) -> List[tuple[str, Image.Image]]:
    """Return the (name, image) variants actually worth running.

    The accurate profile previously ran nine variants, several of which were
    redundant:

    - ``resized`` adds no contrast handling; Tesseract's own binarisation
      already handles it and it was consistently the weakest performer.
    - ``gray`` is superseded by ``autocontrast``, which is the same image after
      contrast boost and normalisation.
    - ``inverted_thresholded`` only helps light-on-dark text, which
      ``inverted`` already covers more cheaply.

    What remains is the variants that measurably contributed distinct text:
    ``autocontrast`` and ``thresholded`` for normal text, ``inverted`` for
    light-on-dark, and per-channel autocontrast only when the image is
    actually coloured.
    """
    base = _base_preprocess(image)

    if ocr_profile == "fast":
        return [
            ("autocontrast", base["autocontrast"]),
            ("thresholded", base["thresholded"]),
        ]

    variants: List[tuple[str, Image.Image]] = [
        ("autocontrast", base["autocontrast"]),
        ("thresholded", base["thresholded"]),
        ("inverted", base["inverted"]),
    ]

    if not _is_grayscale(image):
        red_channel, green_channel, blue_channel = base["resized"].split()
        variants.extend(
            [
                ("channel_r", ImageOps.autocontrast(red_channel)),
                ("channel_g", ImageOps.autocontrast(green_channel)),
                ("channel_b", ImageOps.autocontrast(blue_channel)),
            ]
        )

    return variants


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


def _run_ocr(processed: Image.Image, psm_mode: str) -> str:
    return pytesseract.image_to_string(processed, config=psm_mode).strip()


def _ocr_grid(
    image: Image.Image, ocr_profile: str
) -> tuple[list[tuple[int, str]], float]:
    """Run every (variant, psm) combination, in parallel.

    Tesseract runs as a subprocess, so the work happens outside the interpreter
    and threads give real concurrency. Returns (score, text) pairs plus the
    wall-clock seconds the grid took.
    """
    variants = _build_ocr_variants(image, ocr_profile)
    psm_modes = _ocr_psm_modes(ocr_profile)
    combos = [(name, img, psm) for name, img in variants for psm in psm_modes]

    if not combos:
        return [], 0.0

    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=min(OCR_MAX_WORKERS, len(combos))) as pool:
        texts = list(pool.map(lambda c: _run_ocr(c[1], c[2]), combos))
    elapsed = time.perf_counter() - started

    scored = [(_ocr_text_score(t), t) for t in texts if t]
    return scored, elapsed


def profile_ocr_grid(image: Image.Image, ocr_profile: str = "accurate") -> list[dict]:
    """Per-variant timing and yield, for tuning the grid.

    Exposed through the CLI as ``--profile-ocr`` so the cost of each variant can
    be measured on real images rather than guessed at.
    """
    rows: List[dict] = []
    for name, processed in _build_ocr_variants(image, ocr_profile):
        for psm in _ocr_psm_modes(ocr_profile):
            started = time.perf_counter()
            try:
                text = _run_ocr(processed, psm)
                error = None
            except Exception as exc:  # pragma: no cover - defensive
                text, error = "", f"{type(exc).__name__}: {exc}"
            rows.append(
                {
                    "variant": name,
                    "psm": psm,
                    "seconds": round(time.perf_counter() - started, 3),
                    "score": _ocr_text_score(text),
                    "chars": len(text),
                    "error": error,
                }
            )
    return rows


def _extract_best_text_from_image(image: Image.Image, ocr_profile: str) -> str:
    scored_candidates, elapsed = _ocr_grid(image, ocr_profile)
    logger.debug(
        "ocr grid produced %d candidates in %.2fs (profile=%s)",
        len(scored_candidates),
        elapsed,
        ocr_profile,
    )
    if not scored_candidates:
        return ""

    merged_lines: List[str] = []
    seen_normalized: set[str] = set()
    scored_candidates.sort(key=lambda pair: pair[0], reverse=True)
    for _score, candidate in scored_candidates:
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
    return scored_candidates[0][1]


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
    parser.add_argument(
        "--profile-ocr",
        action="store_true",
        help=(
            "Report per-variant OCR timing and yield as a table, then exit. "
            "Use this to measure the grid before changing it."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.profile_ocr:
        from app.url_safety import UnsafeUrlError, validate_url

        try:
            image_url = validate_url(args.url)
            image = _download_image(image_url)
        except (UnsafeUrlError, Exception) as exc:
            print(f"could not load image: {exc}", file=sys.stderr)
            return 1

        rows = profile_ocr_grid(image, ocr_profile=args.ocr_profile)
        if not rows:
            print("no variants to run for this image")
            return 0

        width = max(len(r["variant"]) for r in rows)
        header = f"{'variant'.ljust(width)}  {'psm':<9} {'secs':>6} {'score':>6} {'chars':>6}"
        print(header)
        print("-" * len(header))
        for row in rows:
            note = f"  ERROR {row['error']}" if row["error"] else ""
            print(
                f"{row['variant'].ljust(width)}  {row['psm']:<9} "
                f"{row['seconds']:>6.2f} {row['score']:>6} {row['chars']:>6}{note}"
            )
        total = sum(r["seconds"] for r in rows)
        print("-" * len(header))
        print(f"{'total serial':ljust(width)}  {'':<9} {total:>6.2f}")
        return 0

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
