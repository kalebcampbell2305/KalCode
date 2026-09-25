"""Hero world layers, derived from the owner's KalCode banner.

The banner (deep-space nebula sky, the KalCode orb, KALCODE lettering, an orbital platform with
concentric rings, side data walls) is the visual world of the site. This script derives
environment layers from its pixels. Nothing is drawn by hand: baked text and labels, the banner's
own orb and its lettering are removed (the live orb and the page's own type replace them), and the
holes are filled from the surrounding sky (multi-scale inpainting plus stars resampled from the
banner itself).

Usage:  python tooling/generate-hero-world.py [--source PATH]
Source: apps/website/src/components/hero/masters/kalcode-world.png (the banner, 1672 x 941)
Output: apps/website/public/assets/hero/world/
  world-{2560,1920,1280}.{avif,webp}      clean plate, landscape (hero, >= 768 px wide)
  world-portrait-{1080,720}.{avif,webp}   centre crop for portrait screens
  backdrop-nebula.{avif,webp}             nebula crown (sky band) for section backdrops
  backdrop-stars.webp                     stars only, alpha (luminance), for section backdrops
  backdrop-gravity.{avif,webp}            the sky pulled into a gravitational lens (depth funnel)
  backdrop-orbital.{avif,webp}            the ring platform band, faded to black at the top
  backdrop-horizon.{avif,webp}            the planet horizon glow band

Geometry (plate coordinates, normalised; mirrored in src/scripts/hero/meta.ts):
  platform ring centre (beam origin) (0.5, 0.776)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "apps" / "website" / "src" / "components" / "hero" / "masters" / "kalcode-world.png"
OUT = ROOT / "apps" / "website" / "public" / "assets" / "hero" / "world"

# Baked text, measured on the 1672 x 941 banner (x0, y0, x1, y1). Only the bright strokes inside
# each box are removed, so the sky and panels behind them survive.
TEXT_BOXES = (
    (55, 140, 232, 260),  # "One intelligence for every part of your code workspace."
    (1490, 140, 1634, 260),  # "Global AI coding workspace ..."
    (1490, 276, 1612, 392),  # "Code / Create / Collaborate / Automate / Anywhere"
    (368, 278, 408, 296),  # orbit labels
    (700, 278, 728, 295),
    (304, 397, 356, 415),
    (722, 373, 779, 391),
    (324, 492, 414, 511),
    (667, 492, 739, 511),
    (48, 556, 164, 684),  # left screen "> imagine / build / ship / together_"
    (1520, 556, 1630, 684),  # right screen "// people / ideas / code / impact"
    (570, 846, 1102, 874),  # "Build without boundaries" and its rules
)
# Large regions replaced entirely: the banner's orb (with its orbits and glow) and the lettering.
ORB_ELLIPSE = ((532, 400), (290, 210))
LETTERING_BOXES = ((786, 382, 1410, 460), (806, 464, 1390, 497))

BEAM_ORIGIN = (0.5, 730 / 941)


def luminance(img: np.ndarray) -> np.ndarray:
    return 0.2126 * img[..., 0] + 0.7152 * img[..., 1] + 0.0722 * img[..., 2]


def text_mask(img: np.ndarray) -> np.ndarray:
    lum = luminance(img)
    tophat = lum - cv2.morphologyEx(lum, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    mask = np.zeros(lum.shape, np.uint8)
    for x0, y0, x1, y1 in TEXT_BOXES:
        region = tophat[y0:y1, x0:x1]
        mask[y0:y1, x0:x1] = (region > 22).astype(np.uint8)
    return cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))


def region_mask(shape: tuple[int, int]) -> np.ndarray:
    mask = np.zeros(shape, np.uint8)
    (cx, cy), (ax, ay) = ORB_ELLIPSE
    cv2.ellipse(mask, (cx, cy), (ax, ay), 0, 0, 360, 1, -1)
    for x0, y0, x1, y1 in LETTERING_BOXES:
        mask[y0:y1, x0:x1] = 1
    return mask


def star_layer(img: np.ndarray) -> np.ndarray:
    """Point stars only (bright, small), as a float RGB layer."""
    lum = luminance(img)
    tophat = lum - cv2.morphologyEx(lum, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    stars = np.clip((tophat - 6) / 60, 0, 1)
    return img * stars[..., None]


def synth_stars(shape: tuple[int, int], reference: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Point stars with the density and brightness distribution measured in the banner's own sky."""
    h, w = shape
    lum = luminance(reference)
    peaks = (lum == cv2.dilate(lum, np.ones((5, 5), np.uint8))) & (lum - cv2.blur(lum, (9, 9)) > 18)
    sky = np.zeros_like(peaks)
    sky[40:330, 260:1440] = True  # clean upper sky, away from the data walls
    values = lum[peaks & sky]
    density = len(values) / sky.sum()
    count = int(density * h * w)
    out = np.zeros((h, w, 3), np.float32)
    ys = rng.integers(0, h, count)
    xs = rng.integers(0, w, count)
    bright = rng.choice(values, count) if len(values) else np.full(count, 60.0)
    tint = np.array([0.72, 0.84, 1.0], np.float32)
    for y, x, v in zip(ys, xs, bright):
        out[y, x] = tint * v
    return cv2.GaussianBlur(out, (0, 0), 0.7) * 2.2


def fill_large(img: np.ndarray, mask: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Open-sky colour (the banner's own dark sky), softly graded, plus matching stars.

    Inpainting from the border would pull the removed orb's glow and the horizon light inward,
    so the fill is the surrounding sky with the masked area replaced by the sky's dark tone,
    blurred wide so it grades into the real sky at the mask edge.
    """
    h, w = mask.shape
    region = img[250:360, 260:760].reshape(-1, 3)
    dark = np.percentile(region, 35, axis=0).astype(np.float32)
    base = cv2.medianBlur(img.astype(np.uint8), 7).astype(np.float32)
    grown = cv2.dilate(mask, np.ones((31, 31), np.uint8)).astype(bool)
    base[grown] = dark
    low = cv2.GaussianBlur(base, (0, 0), 28)
    return low + synth_stars((h, w), img, rng)


def clean_plate(src: np.ndarray) -> np.ndarray:
    rng = np.random.default_rng(11)
    img = src.astype(np.float32)
    tmask = text_mask(img)
    out = cv2.inpaint(src, tmask, 4, cv2.INPAINT_TELEA).astype(np.float32)
    big = region_mask(tmask.shape)
    filled = fill_large(out, big, rng)
    alpha = cv2.GaussianBlur(cv2.dilate(big, np.ones((21, 21), np.uint8)).astype(np.float32), (0, 0), 12)
    alpha = np.clip(alpha * 1.4, 0, 1)[..., None]
    return np.clip(out * (1 - alpha) + filled * alpha, 0, 255)


def save(img: np.ndarray, name: str, widths: tuple[int, ...] | None = None, quality: int = 60) -> None:
    pil = Image.fromarray(np.clip(img, 0, 255).round().astype(np.uint8))
    for width in widths or (pil.width,):
        out = pil if width == pil.width else pil.resize((width, round(pil.height * width / pil.width)), Image.LANCZOS)
        stem = f"{name}-{width}" if widths else name
        out.save(OUT / f"{stem}.webp", "WEBP", quality=quality + 18, method=6)
        out.save(OUT / f"{stem}.avif", "AVIF", quality=quality)


def lens(img: np.ndarray, strength: float = 0.2) -> np.ndarray:
    """Gravitational lens: pull the sky around a dark core, with a thin photon ring."""
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = w / 2, h / 2
    dx, dy = xx - cx, yy - cy
    r = np.sqrt(dx * dx + dy * dy) + 1e-3
    rs = min(w, h) * strength
    # Inverse map: sample further out near the core (Einstein-ring style deflection).
    src_r = r + rs * rs / r
    mx = (cx + dx / r * src_r).astype(np.float32)
    my = (cy + dy / r * src_r).astype(np.float32)
    warped = cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    core = np.clip((r - rs * 0.62) / (rs * 0.45), 0, 1) ** 1.6
    ring = np.exp(-(((r - rs * 0.7) / (rs * 0.05)) ** 2))
    glow = np.exp(-np.maximum(r - rs * 0.7, 0) / (rs * 0.9))
    out = warped * core[..., None]
    out += np.array([80, 150, 255], np.float32) * (ring * 0.55 + glow * 0.08)[..., None]
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--check", type=Path, help="also write the clean plate PNG here")
    args = parser.parse_args()
    if not args.source.exists():
        print(f"missing {args.source}", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    src = np.asarray(Image.open(args.source).convert("RGB"))
    h, w = src.shape[:2]
    plate = clean_plate(src)
    if args.check:
        Image.fromarray(plate.round().astype(np.uint8)).save(args.check)

    # Upscale once (Lanczos + gentle unsharp) for the large landscape widths.
    big = cv2.resize(plate, (2560, round(h * 2560 / w)), interpolation=cv2.INTER_LANCZOS4)
    big = np.clip(big + (big - cv2.GaussianBlur(big, (0, 0), 1.6)) * 0.35, 0, 255)
    save(big, "world", (2560, 1920, 1280), quality=58)

    # Portrait: the centre column (ring centre and the nebula crown above it).
    half = round(h * 0.62)
    cx = round(w * BEAM_ORIGIN[0])
    portrait = plate[:, cx - half : cx + half]
    portrait = cv2.resize(portrait, (1080, round(h * 1080 / (2 * half))), interpolation=cv2.INTER_LANCZOS4)
    save(portrait, "world-portrait", (1080, 720), quality=58)

    # Section backdrops.
    crown = plate[0:330, 180:1500]
    fade = np.clip(np.linspace(1.4, -0.2, crown.shape[0]), 0, 1) ** 1.2
    save(crown * fade[:, None, None], "backdrop-nebula", quality=55)

    # Stars only: the banner's point stars (local maxima), re-rendered as clean dots on alpha, so
    # the nebula filaments do not repeat in every section that uses the layer.
    lum = luminance(plate)
    peaks = (lum == cv2.dilate(lum, np.ones((5, 5), np.uint8))) & (lum - cv2.blur(lum, (9, 9)) > 16)
    peaks[560:] = False
    ys, xs = np.nonzero(peaks)
    dots = np.zeros(lum.shape, np.float32)
    dots[ys, xs] = np.clip((lum[ys, xs] - cv2.blur(lum, (9, 9))[ys, xs]) / 90, 0.15, 1)
    dots = cv2.GaussianBlur(dots, (0, 0), 0.6) * 3.2
    rgba = np.dstack([np.full_like(dots, 225), np.full_like(dots, 235), np.full_like(dots, 255), np.clip(dots, 0, 1) * 255])
    Image.fromarray(rgba[:560].round().astype(np.uint8), "RGBA").save(OUT / "backdrop-stars.webp", "WEBP", quality=80, method=6)

    save(lens(plate[0:520, 336:1336]), "backdrop-gravity", quality=55)

    band = plate[600:941]
    fade = np.clip(np.linspace(-0.1, 1.2, band.shape[0]), 0, 1) ** 1.1
    save(band * fade[:, None, None], "backdrop-orbital", quality=55)

    horizon = plate[540:720]
    fade = np.sin(np.linspace(0, np.pi, horizon.shape[0])) ** 0.8
    save(horizon * fade[:, None, None], "backdrop-horizon", quality=55)

    for path in sorted(OUT.iterdir()):
        print(f"  {path.name:28s} {path.stat().st_size / 1024:7.1f} KB")
    print(f"beam origin (plate) {BEAM_ORIGIN[0]:.3f}, {BEAM_ORIGIN[1]:.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
