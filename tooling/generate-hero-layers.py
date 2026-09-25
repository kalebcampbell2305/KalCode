"""Hero orb layers, derived from the KalCode symbol's own pixels.

The home hero animates the existing KalCode symbol (terminal globe, orbits, network nodes). This
script never draws anything: it reads `assets/branding/kalcode-icon-1024.png` (the production
symbol, sphere body opaque) and derives the data layers the hero shader needs to light the art
from inside:

  orb-{1024,768,640,512,384}.{avif,webp}   the symbol itself (poster, and the WebGL base texture)
  orb-fx-512.webp              lossless RGB data layer:
                                 R  thin bright structures (orbits and network lines; white top-hat)
                                 G  network nodes (bright dots; difference of Gaussians)
                                 B  travel distance from the energy's entry point (the bottom of
                                    the sphere), measured along the lines first: a weighted
                                    geodesic distance where empty space costs more than a lit
                                    line, so a pulse released at the entry follows the orbits
  orb-bloom-256.webp           a soft blur of the symbol's brightest light (cheap animated bloom)

Usage:  python tooling/generate-hero-layers.py
Output: apps/website/public/assets/hero/  (served as-is; regenerate, never edit by hand)

Geometry (normalised to the symbol square; mirrored in apps/website/src/scripts/hero/meta.ts):
sphere centre (0.4932, 0.5211), radius 0.2807 — the brand pipeline's measured sphere
(board (636, 252), r 160, in the 570 px isolation centred on (640, 240)).
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from skimage.graph import MCP_Geometric

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "branding" / "kalcode-icon-1024.png"
OUT = ROOT / "apps" / "website" / "public" / "assets" / "hero"

# Sphere, normalised (see module docstring).
SPHERE_CX = (636 - (640 - 285)) / 570
SPHERE_CY = (252 - (240 - 285)) / 570
SPHERE_R = 160 / 570

# The terminal prompt glyph (normalised boxes, measured on the 1024 export). The energy never
# washes over it, so the prompt stays crisp and readable while the network around it moves.
GLYPH_BOXES = ((0.340, 0.420, 0.480, 0.625), (0.470, 0.575, 0.590, 0.625))


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def load() -> tuple[np.ndarray, np.ndarray]:
    img = np.asarray(Image.open(SOURCE).convert("RGBA")).astype(np.float32) / 255
    alpha = img[..., 3]
    premul = img[..., :3] * alpha[..., None]  # the symbol as it appears on black
    return img, premul


def luminance(rgb: np.ndarray) -> np.ndarray:
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def glyph_mask(lum: np.ndarray) -> np.ndarray:
    """The prompt's own bright, flat pixels inside the glyph boxes, grown past its glowing edge."""
    n = lum.shape[0]
    boxes = np.zeros((n, n), np.uint8)
    for x0, y0, x1, y1 in GLYPH_BOXES:
        boxes[int(y0 * n) : int(y1 * n), int(x0 * n) : int(x1 * n)] = 1
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

    # B: geodesic travel distance from the entry point (bottom of the sphere). Lines are fast,
    # empty space is slow, so the front runs along the orbits and seeps across the globe.
    network = np.maximum(line, node)
    cost = 1.0 + 7.0 * (1 - smoothstep(0.08, 0.5, network))
    cost[premul.max(axis=2) < 0.015] = 14.0  # outside the art: slowest
    entry = (int(round(SPHERE_CY * n + SPHERE_R * n * 0.985)), int(round(SPHERE_CX * n)))
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


def save_orb(size: int) -> None:
    src = Image.open(SOURCE).convert("RGBA")
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
    if not SOURCE.exists():
        print(f"missing {SOURCE}", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    _, premul = load()
    line, node, dist = layers(premul)
    # The data layer only modulates light over the crisp base art, so 512 px is plenty.
    save_rgb([line, node, dist], 512, OUT / "orb-fx-512.webp")
    for size in (1024, 768, 640, 512, 384):
        save_orb(size)

    # Bloom: the symbol's brightest light, blurred wide, at low resolution.
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
    print(f"sphere centre ({SPHERE_CX:.4f}, {SPHERE_CY:.4f}) r {SPHERE_R:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
