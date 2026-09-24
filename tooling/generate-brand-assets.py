"""KalCode brand asset pipeline.

The owner's artwork is the brand. This script never alters it: it copies the two master PNGs
byte-for-byte into the repository (verified by SHA-256) and derives every web, desktop and icon
asset from those masters' actual pixels — crops, resizes, and luminance-to-alpha extraction of
the lettering so it can sit on light or dark surfaces. Nothing is redrawn.

Usage:
  python tooling/generate-brand-assets.py [--source-dir ~/Downloads]

Masters (source of truth):   packages/ui/src/brand/masters/
Originals served on the web: apps/website/public/assets/brand/  (unmodified copies)
Derivatives:                 apps/website/public/assets/brand/, apps/desktop/src/assets/brand/,
                             apps/desktop/src-tauri/icons/ (via `cargo tauri icon`)
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
MASTERS = ROOT / "packages" / "ui" / "src" / "brand" / "masters"
WEB = ROOT / "apps" / "website" / "public" / "assets" / "brand"
DESKTOP = ROOT / "apps" / "desktop" / "src" / "assets" / "brand"
ICONS = ROOT / "apps" / "desktop" / "src-tauri" / "icons"

SOURCES = {
    "kalcode-brand.png": "KALCODE UI FOR WEBSITE LOGO AND FOR THEME.png",
    "jarvis-brand.png": "JARVIS UI FOR JARVIS VOICE IN KALCODE.png",
}

# Regions measured from the masters (1122 x 1402). See docs/BRAND.md.
KALCODE_GLOBE_CENTER = (545, 511)
KALCODE_GLOBE_HALF = 362  # includes the outer constellation network
KALCODE_SPHERE_HALF = 318  # sphere + rim glow, for the icon mark
KALCODE_WORDMARK_BOX = (116, 919, 1015, 1001)
KALCODE_TAGLINE_BOX = (230, 1046, 888, 1076)
JARVIS_GLOBE_CENTER = (553, 372)
JARVIS_GLOBE_HALF = 300
JARVIS_WORDMARK_BOX = (177, 679, 958, 762)
JARVIS_TAGLINE_BOX = (178, 790, 944, 819)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def copy_masters(source_dir: Path) -> None:
    MASTERS.mkdir(parents=True, exist_ok=True)
    WEB.mkdir(parents=True, exist_ok=True)
    for target, original in SOURCES.items():
        src = source_dir / original
        master = MASTERS / target
        if src.exists():
            if not master.exists() or sha256(master) != sha256(src):
                shutil.copyfile(src, master)
        elif not master.exists():
            sys.exit(f"missing master artwork: {src}")
        # Unmodified original, also published with the website.
        shutil.copyfile(master, WEB / target)
        if src.exists():
            assert sha256(master) == sha256(src), f"{target} differs from the original"
        print(f"master {target}: sha256 {sha256(master)[:16]}…")


def square(img: Image.Image, center: tuple[int, int], half: int) -> Image.Image:
    cx, cy = center
    return img.crop((cx - half, cy - half, cx + half, cy + half))


def save_web(img: Image.Image, stem: str, widths: list[int], dirs: list[Path], quality: int = 84) -> None:
    for width in widths:
        height = round(img.height * width / img.width)
        resized = img.resize((width, height), Image.LANCZOS) if width != img.width else img
        for directory in dirs:
            directory.mkdir(parents=True, exist_ok=True)
            resized.save(directory / f"{stem}-{width}.webp", "WEBP", quality=quality, method=6)
            try:
                resized.save(directory / f"{stem}-{width}.avif", "AVIF", quality=quality - 20)
            except (KeyError, OSError, ValueError):
                pass  # AVIF encoder unavailable; WebP is the baseline.


def lettering_alpha(img: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    """Extracts light lettering from the dark artwork as white-on-transparent, using the
    artwork's own luminance as alpha so edges and glow are preserved exactly."""
    region = np.asarray(img.crop(box).convert("RGB")).astype(np.float32)
    lum = region.max(axis=2)
    # Treat the artwork's background plus its faint atmospheric haze as transparent, so the
    # lettering sits cleanly on light surfaces; the letterforms and their glow edge remain.
    floor = np.percentile(lum, 80) + 10
    alpha = np.clip((lum - floor) / (255 - floor), 0, 1) ** 0.85
    out = np.zeros((*alpha.shape, 4), dtype=np.uint8)
    out[..., :3] = 255
    out[..., 3] = (alpha * 255).round().astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def round_mark(img: Image.Image, center: tuple[int, int], half: int, size: int) -> Image.Image:
    """The globe from the artwork, cut to a circle with a soft edge (transparent outside)."""
    crop = square(img, center, half).convert("RGBA").resize((size, size), Image.LANCZOS)
    yy, xx = np.mgrid[0:size, 0:size]
    r = np.hypot(xx - (size - 1) / 2, yy - (size - 1) / 2) / (size / 2)
    alpha = np.clip((1.0 - r) / 0.035, 0, 1)
    arr = np.asarray(crop).copy()
    arr[..., 3] = (alpha * 255).astype(np.uint8)
    out = Image.fromarray(arr, "RGBA")
    if size <= 64:
        out = out.filter(ImageFilter.UnsharpMask(radius=0.8, percent=90, threshold=0))
    return out


def background(img: Image.Image) -> tuple[int, int, int]:
    arr = np.asarray(img.convert("RGB"))
    edge = np.concatenate([arr[:12].reshape(-1, 3), arr[-12:].reshape(-1, 3)])
    return tuple(int(v) for v in np.median(edge, axis=0))


def social_card(kalcode: Image.Image, wordmark: Image.Image, tagline: Image.Image) -> Image.Image:
    bg = background(kalcode)
    card = Image.new("RGB", (1200, 630), bg)
    globe = square(kalcode, KALCODE_GLOBE_CENTER, KALCODE_GLOBE_HALF).resize((600, 600), Image.LANCZOS)
    card.paste(globe, (40, 15))
    wm = wordmark.resize((480, round(wordmark.height * 480 / wordmark.width)), Image.LANCZOS)
    tl = tagline.resize((330, round(tagline.height * 330 / tagline.width)), Image.LANCZOS)
    card.paste(wm, (660, 262), wm)
    card.paste(tl, (660 + (480 - 330) // 2, 262 + wm.height + 34), tl)
    return card


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, default=Path.home() / "Downloads")
    args = parser.parse_args()

    copy_masters(args.source_dir)
    kalcode = Image.open(MASTERS / "kalcode-brand.png").convert("RGB")
    jarvis = Image.open(MASTERS / "jarvis-brand.png").convert("RGB")
    print(f"artwork background: rgb{background(kalcode)} / rgb{background(jarvis)}")

    # Full artwork (brand presentation sections).
    save_web(kalcode, "kalcode-artwork", [1122, 560], [WEB, DESKTOP])
    save_web(jarvis, "jarvis-artwork", [1122, 560], [WEB, DESKTOP])

    # Globes.
    save_web(square(kalcode, KALCODE_GLOBE_CENTER, KALCODE_GLOBE_HALF), "kalcode-globe", [724, 362], [WEB, DESKTOP])
    save_web(square(jarvis, JARVIS_GLOBE_CENTER, JARVIS_GLOBE_HALF), "jarvis-globe", [600, 300], [WEB, DESKTOP])

    # Lettering as transparent PNGs (usable as CSS masks or images on any surface).
    lettering = {
        "kalcode-wordmark.png": lettering_alpha(kalcode, KALCODE_WORDMARK_BOX),
        "kalcode-tagline.png": lettering_alpha(kalcode, KALCODE_TAGLINE_BOX),
        "jarvis-wordmark.png": lettering_alpha(jarvis, JARVIS_WORDMARK_BOX),
        "jarvis-tagline.png": lettering_alpha(jarvis, JARVIS_TAGLINE_BOX),
    }
    for name, image in lettering.items():
        for directory in (WEB, DESKTOP):
            image.save(directory / name, optimize=True)

    # Round globe mark for small brand placements.
    for size in (256, 128, 64):
        mark = round_mark(kalcode, KALCODE_GLOBE_CENTER, KALCODE_SPHERE_HALF, size)
        for directory in (WEB, DESKTOP):
            mark.save(directory / f"kalcode-mark-{size}.png", optimize=True)

    # Website favicons and social card.
    site = WEB.parent.parent
    round_mark(kalcode, KALCODE_GLOBE_CENTER, KALCODE_SPHERE_HALF, 32).save(site / "favicon-32.png", optimize=True)
    icon_frames = [round_mark(kalcode, KALCODE_GLOBE_CENTER, KALCODE_SPHERE_HALF, s) for s in (16, 32, 48)]
    icon_frames[-1].save(site / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)], append_images=icon_frames[:-1])
    touch = Image.new("RGB", (180, 180), background(kalcode))
    touch_mark = round_mark(kalcode, KALCODE_GLOBE_CENTER, KALCODE_SPHERE_HALF, 164)
    touch.paste(touch_mark, (8, 8), touch_mark)
    touch.save(site / "apple-touch-icon.png", optimize=True)
    social_card(kalcode, lettering["kalcode-wordmark.png"], lettering["kalcode-tagline.png"]).save(site / "og.png", optimize=True)

    # Desktop application icons: the artwork globe, via Tauri's icon generator.
    icon_source = ROOT / "target" / "brand-icon-1024.png"
    icon_source.parent.mkdir(parents=True, exist_ok=True)
    round_mark(kalcode, KALCODE_GLOBE_CENTER, KALCODE_SPHERE_HALF, 1024).save(icon_source)
    subprocess.run(["cargo", "tauri", "icon", str(icon_source), "-o", str(ICONS)], cwd=ROOT / "apps" / "desktop", check=True, capture_output=True)
    for mobile in ("android", "ios"):
        shutil.rmtree(ICONS / mobile, ignore_errors=True)
    frames = {s: round_mark(kalcode, KALCODE_GLOBE_CENTER, KALCODE_SPHERE_HALF, s) for s in (16, 24, 32, 48, 64, 128, 256)}
    frames[256].save(ICONS / "icon.ico", format="ICO", sizes=[(s, s) for s in frames], append_images=[frames[s] for s in frames if s != 256])
    frames[32].save(ICONS / "32x32.png")
    print("brand assets generated from the masters")
    return 0


if __name__ == "__main__":
    sys.exit(main())
