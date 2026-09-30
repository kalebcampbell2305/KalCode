"""Hero layers, derived from the KalCode mascot's own pixels.

The home hero shows the KalCode mascot riding the energy stream. This script never draws the
mascot: it takes the rim-lit mascot from the brand pipeline (tooling/generate-brand-assets.py),
places it in the hero square, and derives the data layers the hero shader needs to light the art
from inside:

  orb-{1024,768,640,512,384}.{avif,webp}   the mascot in its square (poster, WebGL base texture)
  orb-fx-512.webp              lossless RGB data layer:
                                 R  thin bright structures (white top-hat)
                                 G  bright blocks and dots (difference of Gaussians)
                                 B  travel distance from the energy's entry point (under the
                                    feet), measured along the bright art first: a weighted
                                    geodesic distance where empty space costs more than lit art,
                                    so a pulse released at the feet climbs the figure
  orb-bloom-256.webp           a soft blur of the mascot's brightest light (cheap animated bloom)

Usage:  python tooling/generate-hero-layers.py   (after generate-brand-assets.py)
Output: apps/website/public/assets/hero/  (served as-is; regenerate, never edit by hand)

Geometry (normalised to the hero square; mirrored in apps/website/src/scripts/hero/meta.ts):
the feet sit centred on x 0.493 with their soles at y 0.752, just above the stream's entry point
(0.762); the head's top is at y 0.07. The square keeps the retired globe's anchor (centre y 0.5211)
so the page layout around the hero is unchanged; the feet clear the wordmark below.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from skimage.graph import MCP_Geometric

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "apps" / "website" / "public" / "assets" / "hero"
SIZE = 1024

# Placement (see module docstring). Mascot master coordinates: soles' centre and head top.
FEET_X, SOLES_Y = 0.493, 0.752
HEAD_Y = 0.07
MASTER_FEET = (610, 1056)
MASTER_TOP = 166
ENTRY = (FEET_X, 0.762)

# The eyes and the laptop's K (mascot master pixels). The energy never washes over them, so the
# face and the K stay crisp while the light moves around them.
GLYPH_BOXES_MASTER = ((512, 395, 578, 502), (677, 367, 744, 475), (790, 620, 890, 730))


def brand_pipeline():
    spec = importlib.util.spec_from_file_location("brand", ROOT / "tooling" / "generate-brand-assets.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["brand"] = module  # dataclasses resolve their module while it executes
    spec.loader.exec_module(module)
    return module


SCALE = (SOLES_Y - HEAD_Y) * SIZE / (MASTER_FEET[1] - MASTER_TOP)


def to_square(x: float, y: float) -> tuple[float, float]:
    """Mascot master pixel -> hero square pixel."""
    return FEET_X * SIZE + (x - MASTER_FEET[0]) * SCALE, SOLES_Y * SIZE + (y - MASTER_FEET[1]) * SCALE


def compose() -> Image.Image:
    """The rim-lit mascot placed in the transparent hero square."""
    brand = brand_pipeline()
    dark = brand.rim_lit(brand.mascot_cutout()[1])
    a = dark[..., 3:4] / 255
    premul = np.dstack([dark[..., :3] * a, a * 255]).astype(np.float32)
    ox, oy = to_square(0, 0)
    m = np.float32([[SCALE, 0, ox], [0, SCALE, oy]])
    placed = cv2.warpAffine(premul, m, (SIZE, SIZE), flags=cv2.INTER_AREA, borderValue=(0, 0, 0, 0))
    pa = placed[..., 3:4] / 255
    rgb = np.where(pa > 1e-3, placed[..., :3] / np.maximum(pa, 1e-3), 0)
    return Image.fromarray(np.dstack([np.clip(rgb, 0, 255), placed[..., 3:4]]).round().astype(np.uint8), "RGBA")


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def load(source: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    img = np.asarray(source).astype(np.float32) / 255
    alpha = img[..., 3]
    premul = img[..., :3] * alpha[..., None]  # the symbol as it appears on black
    return img, premul


def luminance(rgb: np.ndarray) -> np.ndarray:
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def glyph_mask(lum: np.ndarray) -> np.ndarray:
    """The eyes' and the K's own bright pixels inside the glyph boxes, grown past their glow."""
    n = lum.shape[0]
    boxes = np.zeros((n, n), np.uint8)
    for x0, y0, x1, y1 in GLYPH_BOXES_MASTER:
        (sx0, sy0), (sx1, sy1) = to_square(x0, y0), to_square(x1, y1)
        boxes[int(sy0) : int(sy1), int(sx0) : int(sx1)] = 1
    flat = cv2.morphologyEx((lum > 0.6).astype(np.uint8), cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    grown = cv2.dilate(flat * boxes, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (19, 19)))
    return cv2.GaussianBlur(grown.astype(np.float32), (0, 0), 3)


def layers(premul: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n = premul.shape[0]
    lum = luminance(premul)

    # R: thin bright structures. White top-hat removes broad glow and keeps lines and dots.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
    tophat = lum - cv2.morphologyEx(lum, cv2.MORPH_OPEN, kernel)
    line = smoothstep(0.04, 0.55, tophat) ** 0.8

    # G: nodes. A difference of Gaussians peaks on round bright dots and stays low along lines.
    dog = cv2.GaussianBlur(lum, (0, 0), 2.5) - cv2.GaussianBlur(lum, (0, 0), 9)
    node = smoothstep(0.14, 0.42, dog)
    node = cv2.GaussianBlur(cv2.dilate(node, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))), (0, 0), 1.6)
    node = np.clip(node * 1.25, 0, 1)

    glyph = glyph_mask(lum)
    line *= 1 - glyph
    node *= 1 - glyph

    # B: geodesic travel distance from the entry point (under the feet). Bright art is fast,
    # empty space is slow, so the front climbs the figure's own lit pixels.
    network = np.maximum(line, node)
    cost = 1.0 + 7.0 * (1 - smoothstep(0.08, 0.5, network))
    cost[premul.max(axis=2) < 0.015] = 14.0  # outside the art: slowest
    entry = (int(round(ENTRY[1] * n)), int(round(ENTRY[0] * n)))
    mcp = MCP_Geometric(cost)
    dist, _ = mcp.find_costs([entry])
    art = premul.max(axis=2) > 0.03
    scale = float(np.percentile(dist[art & (network > 0.2)], 99.0))
    d = np.clip(dist / scale, 0, 1)
    # Dither before 8-bit quantisation so the moving front never shows contour steps.
    rng = np.random.default_rng(7)
    d = np.clip(d + (rng.random(d.shape, dtype=np.float32) - 0.5) / 255, 0, 1)
    return line, node, d


def save_rgb(channels: list[np.ndarray], size: int, path: Path) -> None:
    rgb = np.dstack(channels)
    img = Image.fromarray((np.clip(rgb, 0, 1) * 255).round().astype(np.uint8), "RGB")
    if img.width != size:
        img = img.resize((size, size), Image.LANCZOS)
    img.save(path, "WEBP", lossless=True, quality=100, method=6)


def save_orb(src: Image.Image, size: int) -> None:
    arr = np.asarray(src).astype(np.float32)
    a = arr[..., 3:4] / 255
    if size != src.width:
        pre = Image.fromarray(np.dstack([arr[..., :3] * a, a * 255]).round().astype(np.uint8), "RGBA")
        small = np.asarray(pre.resize((size, size), Image.LANCZOS)).astype(np.float32)
        sa = small[..., 3:4] / 255
        rgb = np.where(sa > 1e-3, small[..., :3] / np.maximum(sa, 1e-3), 0)
        out = Image.fromarray(np.dstack([np.clip(rgb, 0, 255), small[..., 3:4]]).round().astype(np.uint8), "RGBA")
    else:
        out = src
    out.save(OUT / f"orb-{size}.webp", "WEBP", quality=90, alpha_quality=100, method=6)
    try:
        out.save(OUT / f"orb-{size}.avif", "AVIF", quality=58)
    except (KeyError, OSError, ValueError):
        print("  (AVIF encoder unavailable; WebP only)")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    source = compose()
    _, premul = load(source)
    line, node, dist = layers(premul)
    # The data layer only modulates light over the crisp base art, so 512 px is plenty.
    save_rgb([line, node, dist], 512, OUT / "orb-fx-512.webp")
    for size in (1024, 768, 640, 512, 384):
        save_orb(source, size)

    # Bloom: the mascot's brightest light, blurred wide, at low resolution.
    lum = luminance(premul)
    bright = premul * smoothstep(0.35, 0.95, lum)[..., None]
    bloom = cv2.GaussianBlur(bright, (0, 0), 14)
    bloom = cv2.resize(bloom, (256, 256), interpolation=cv2.INTER_AREA)
    bloom /= max(float(bloom.max()), 1e-6)
    Image.fromarray((np.clip(bloom, 0, 1) ** 0.85 * 255).round().astype(np.uint8), "RGB").save(
        OUT / "orb-bloom-256.webp", "WEBP", lossless=True, method=6
    )

    for path in sorted(OUT.iterdir()):
        print(f"  {path.name:24s} {path.stat().st_size / 1024:7.1f} KB")
    print(f"feet ({FEET_X:.4f}, {SOLES_Y:.4f}), entry y {ENTRY[1]:.4f}, head top {HEAD_Y:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
