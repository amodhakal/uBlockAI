"""Generate the extension icons.

The committed icons are produced by this script rather than hand-drawn, so they
are reproducible and reviewable as code instead of being opaque binaries.

    python3 scripts/make_icons.py

Requires Pillow. Output: frontend/extension/icons/icon-{16,48,128}.png
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = REPO_ROOT / "frontend" / "extension" / "icons"

SIZES = (16, 48, 128)

# Matches the popup and placeholder palette so the toolbar icon does not look
# like a different product.
BACKGROUND = (20, 22, 26, 255)
ACCENT = (77, 171, 247, 255)
FOREGROUND = (230, 232, 236, 255)


def _rounded_mask(size: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    # A 22% corner radius reads as a rounded square without looking like a
    # circle at 16px.
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    return mask


def _draw_icon(size: int) -> Image.Image:
    scale = 4  # supersample, then downscale for clean edges
    s = size * scale

    image = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BACKGROUND)

    # A block ring with a diagonal slash. This is the "prohibited" mark, which is
    # the clearest possible glyph at 16px and needs no text to read.
    cx = cy = s / 2
    outer = s * 0.34
    inner = s * 0.245
    draw.ellipse([cx - outer, cy - outer, cx + outer, cy + outer], outline=ACCENT, width=max(1, int(s * 0.055)))
    draw.ellipse([cx - inner, cy - inner, cx + inner, cy + inner], outline=ACCENT, width=max(1, int(s * 0.045)))

    # Slash across the ring.
    half = outer * 0.92
    dx = half * math.cos(math.radians(45))
    dy = half * math.sin(math.radians(45))
    draw.line([cx - dx, cy - dy, cx + dx, cy + dy], fill=FOREGROUND, width=max(1, int(s * 0.07)))
    r = s * 0.035
    draw.ellipse([cx - dx - r, cy - dy - r, cx - dx + r, cy - dy + r], fill=FOREGROUND)
    draw.ellipse([cx + dx - r, cy + dy - r, cx + dx + r, cy + dy + r], fill=FOREGROUND)

    image = image.resize((size, size), Image.LANCZOS)
    image.putalpha(Image.composite(image.getchannel("A"), Image.new("L", (size, size), 0), _rounded_mask(size)))
    return image


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT_DIR / f"icon-{size}.png"
        _draw_icon(size).save(path, "PNG", optimize=True)
        print(f"wrote {path.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
