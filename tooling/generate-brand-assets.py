"""KalCode brand asset pipeline.

The owner's brand boards are the brand. This script never alters them: it copies the two board
PNGs byte-for-byte into the repository (verified by SHA-256) and derives every logo, icon, web and
desktop asset from the boards' actual pixels — crops, label removal, resizes, and
luminance-to-alpha extraction so the glowing symbols sit on any surface. Nothing is redrawn.

Usage:
  python tooling/generate-brand-assets.py [--source-dir ~/Downloads]

Masters (source of truth):  packages/ui/src/brand/masters/  (kalcode-board.png, kalvoice-board.png)
Production logos:           assets/branding/                (isolated symbols, 1024 … 32, lettering)
Derivatives:                apps/website/public/assets/brand/, apps/website/public/ (favicons, og),
                            apps/desktop/src/assets/brand/, apps/desktop/src-tauri/icons/
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
MASTERS = ROOT / "packages" / "ui" / "src" / "brand" / "masters"
BRANDING = ROOT / "assets" / "branding"
WEB = ROOT / "apps" / "website" / "public" / "assets" / "brand"
SITE = ROOT / "apps" / "website" / "public"
DESKTOP = ROOT / "apps" / "desktop" / "src" / "assets" / "brand"
ICONS = ROOT / "apps" / "desktop" / "src-tauri" / "icons"

SOURCES = {
    "kalcode-board.png": "KALCODE LOGO.png",
    "kalvoice-board.png": "KALVOICE LOGO.png",
}

EXPORT_SIZES = (1024, 512, 256, 128, 64, 32)
# Below this size the orbit network turns to noise, so small icons use the tighter crop.
COMPACT_BELOW = 96


@dataclass(frozen=True)
class Symbol:
    """A glowing symbol on a brand board (board pixel coordinates, 1254 x 1254)."""

    center: tuple[int, int]  # centre of the full symbol including its orbits
    half: int  # half-size of the square that holds the full symbol
    sphere_center: tuple[int, int]
    sphere_radius: int
    compact_half: int  # half-size of the tight crop around the sphere, for small icons
    y_limit: int  # nothing at or below this row belongs to the symbol (board lettering)
    labels: tuple[tuple[int, int, int, int], ...] = field(default=())  # annotation text to remove


# The KalCode board annotates the symbol's orbits with small labels (IDE, AI, BUILD, CODE,
# TERMINAL, DEPLOY); they are presentation notes, not part of the mark, and are removed.
KALCODE = Symbol(
    center=(640, 240),
    half=285,
    sphere_center=(636, 252),
    sphere_radius=160,
    compact_half=200,
    y_limit=452,
    labels=(
        (438, 93, 468, 104),
        (820, 93, 833, 104),
        (360, 237, 402, 248),
        (853, 208, 898, 220),
        (396, 353, 471, 365),
        (798, 346, 857, 358),
    ),
)
KALVOICE = Symbol(
    center=(620, 322),
    half=310,
    sphere_center=(620, 325),
    sphere_radius=229,
    compact_half=262,
    y_limit=598,
)

# Lettering boxes on the boards (measured; padded for the glow).
KALCODE_WORDMARK_BOX = (286, 467, 973, 536)
KALCODE_TAGLINE_BOX = (305, 561, 950, 582)
KALVOICE_WORDMARK_BOX = (174, 603, 1075, 675)  # stops before the ™ mark
KALVOICE_TAGLINE_BOX = (248, 705, 997, 728)

# Luminance at or below this is the boards' background (near-black, with a faint grid).
BLACK_FLOOR = 12


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def copy_masters(source_dir: Path) -> None:
    MASTERS.mkdir(parents=True, exist_ok=True)
    for target, original in SOURCES.items():
        src = source_dir / original
        master = MASTERS / target
        if src.exists():
            if not master.exists() or sha256(master) != sha256(src):
                shutil.copyfile(src, master)
            assert sha256(master) == sha256(src), f"{target} differs from the original"
        elif not master.exists():
            sys.exit(f"missing brand board: {src}")
        print(f"master {target}: sha256 {sha256(master)[:16]}…")


def load(name: str) -> np.ndarray:
    return np.asarray(Image.open(MASTERS / name).convert("RGB"))


def remove_labels(board: np.ndarray, boxes: tuple[tuple[int, int, int, int], ...]) -> np.ndarray:
    """Inpaints the label glyphs (only their pixels, not the whole box) from the surrounding art."""
    if not boxes:
        return board
    mask = np.zeros(board.shape[:2], np.uint8)
    for x0, y0, x1, y1 in boxes:
        x0, y0, x1, y1 = x0 - 3, y0 - 3, x1 + 3, y1 + 3
        glyphs = (board[y0:y1, x0:x1].max(axis=2) > 40).astype(np.uint8)
        mask[y0:y1, x0:x1] = cv2.dilate(glyphs, np.ones((3, 3), np.uint8), iterations=2)
    return cv2.inpaint(board, mask * 255, 4, cv2.INPAINT_TELEA)


def smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - edge0) / (edge1 - edge0), 0, 1)
    return t * t * (3 - 2 * t)


def isolate(board: np.ndarray, symbol: Symbol, *, solid: bool, compact: bool = False) -> Image.Image:
    """Cuts a symbol out of its board as a transparent RGBA image.

    Glow is extracted with the board's luminance as alpha (premultiplied colour = the original
    pixel), so the symbol composited on the board's black is pixel-identical to the board.
    `solid` keeps the sphere's dark body opaque, so the mark reads on light surfaces too.
    """
    pad = 320
    art = np.pad(board, ((pad, pad), (pad, pad), (0, 0))).astype(np.float32)
    cx, cy = (symbol.sphere_center if compact else symbol.center)
    half = symbol.compact_half if compact else symbol.half
    x0, y0 = cx - half + pad, cy - half + pad
    sub = art[y0 : y0 + 2 * half, x0 : x0 + 2 * half]
    n = sub.shape[0]
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    board_x, board_y = xx + x0 - pad, yy + y0 - pad

    # Everything outside the symbol's circle, and the board lettering below it, is dropped.
    r = np.hypot(xx - (n - 1) / 2, yy - (n - 1) / 2) / (n / 2)
    keep = 1 - smoothstep(0.88, 1.0, r)
    keep *= np.clip((symbol.y_limit - board_y) / 12, 0, 1)

    glow = np.clip((sub.max(axis=2) - BLACK_FLOOR) / (255 - BLACK_FLOOR), 0, 1)
    alpha = glow
    if solid:
        sx, sy = symbol.sphere_center
        rs = np.hypot(board_x - sx, board_y - sy) / symbol.sphere_radius
        alpha = np.maximum(alpha, 1 - smoothstep(0.93, 0.99, rs))
    alpha = alpha * keep

    premultiplied = np.clip(sub - BLACK_FLOOR, 0, None) * (255 / (255 - BLACK_FLOOR))
    premultiplied *= keep[..., None]
    color = np.where(alpha[..., None] > 1e-4, premultiplied / np.maximum(alpha[..., None], 1e-4), 0)
    out = np.dstack([np.clip(color, 0, 255), alpha * 255]).round().astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def resized(img: Image.Image, size: int) -> Image.Image:
    """Resizes in premultiplied space (so glow edges do not darken) and sharpens small sizes."""
    arr = np.asarray(img).astype(np.float32)
    a = arr[..., 3:4] / 255
    pre = Image.fromarray(np.dstack([arr[..., :3] * a, a * 255]).round().astype(np.uint8), "RGBA")
    small = np.asarray(pre.resize((size, size), Image.LANCZOS)).astype(np.float32)
    sa = small[..., 3:4] / 255
    rgb = np.where(sa > 1e-3, small[..., :3] / np.maximum(sa, 1e-3), 0)
    out = Image.fromarray(np.dstack([np.clip(rgb, 0, 255), small[..., 3:4]]).round().astype(np.uint8), "RGBA")
    if size <= 64:
        out = out.filter(ImageFilter.UnsharpMask(radius=0.7, percent=80, threshold=0))
    elif size > img.width:
        out = out.filter(ImageFilter.UnsharpMask(radius=1.2, percent=35, threshold=2))
    return out


def icon(board: np.ndarray, symbol: Symbol, size: int, *, solid: bool = True) -> Image.Image:
    return resized(isolate(board, symbol, solid=solid, compact=size < COMPACT_BELOW), size)


def lettering(board: np.ndarray, box: tuple[int, int, int, int]) -> Image.Image:
    """Light lettering from the dark board as white-on-transparent (its luminance is the alpha)."""
    x0, y0, x1, y1 = box
    lum = board[y0:y1, x0:x1].max(axis=2).astype(np.float32)
    # The background level is read from the box's border (the lettering fills much of the box).
    border = np.concatenate([lum[:2].ravel(), lum[-2:].ravel(), lum[:, :2].ravel(), lum[:, -2:].ravel()])
    floor = np.percentile(border, 90) + 12
    alpha = np.clip((lum - floor) / (255 - floor), 0, 1) ** 0.85
    out = np.zeros((*alpha.shape, 4), dtype=np.uint8)
    out[..., :3] = 255
    out[..., 3] = (alpha * 255).round().astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def save_web(img: Image.Image, stem: str, widths: list[int], dirs: list[Path], quality: int = 84) -> None:
    for width in widths:
        height = round(img.height * width / img.width)
        if img.mode == "RGBA":
            out = resized(img, width) if img.width == img.height else img.resize((width, height), Image.LANCZOS)
        else:
            out = img.resize((width, height), Image.LANCZOS) if width != img.width else img
        for directory in dirs:
            directory.mkdir(parents=True, exist_ok=True)
            out.save(directory / f"{stem}-{width}.webp", "WEBP", quality=quality, method=6)
            try:
                out.save(directory / f"{stem}-{width}.avif", "AVIF", quality=quality - 20)
            except (KeyError, OSError, ValueError):
                pass  # AVIF encoder unavailable; WebP is the baseline.


def on_ground(img: Image.Image, size: int, inset: int) -> Image.Image:
    """An opaque square with the mark on the boards' black (for platforms that need opacity)."""
    ground = Image.new("RGBA", (size, size), (0, 0, 1, 255))
    mark = img.resize((size - 2 * inset, size - 2 * inset), Image.LANCZOS)
    ground.alpha_composite(mark, (inset, inset))
    return ground.convert("RGB")


def social_card(board: Image.Image) -> Image.Image:
    """The KalCode board's hero (symbol, wordmark, tagline) at 1200 x 630."""
    hero = board.crop((0, 20, 1254, 678))  # 1254 x 658 = 1.906 : 1
    return hero.resize((1200, 630), Image.LANCZOS)


def clean(directory: Path, patterns: tuple[str, ...]) -> None:
    for pattern in patterns:
        for path in directory.glob(pattern):
            path.unlink()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, default=Path.home() / "Downloads")
    args = parser.parse_args()

    copy_masters(args.source_dir)
    kalcode = remove_labels(load("kalcode-board.png"), KALCODE.labels)
    kalvoice = load("kalvoice-board.png")

    # Retired assets from earlier artwork.
    for directory in (WEB, DESKTOP):
        clean(directory, ("kalcode-artwork-*", "kalcode-brand.png", "*-board-*"))
    for old in ("kalcode-brand.png", "kalvoice-globe.png"):
        (MASTERS / old).unlink(missing_ok=True)

    # 1. Production logos (assets/branding): transparent PNGs at the standard sizes.
    BRANDING.mkdir(parents=True, exist_ok=True)
    clean(BRANDING, ("*.png",))
    for name, board, symbol in (("kalcode", kalcode, KALCODE), ("kalvoice", kalvoice, KALVOICE)):
        mark = f"{name}-icon"
        glow = "kalcode-symbol" if name == "kalcode" else "kalvoice-orb"
        for size in EXPORT_SIZES:
            icon(board, symbol, size).save(BRANDING / f"{mark}-{size}.png", optimize=True)
            icon(board, symbol, size, solid=False).save(BRANDING / f"{glow}-{size}.png", optimize=True)
        isolate(board, symbol, solid=True).save(BRANDING / f"{mark}-source.png", optimize=True)
        isolate(board, symbol, solid=False).save(BRANDING / f"{glow}-source.png", optimize=True)
    letters = {
        "kalcode-wordmark.png": lettering(kalcode, KALCODE_WORDMARK_BOX),
        "kalcode-tagline.png": lettering(kalcode, KALCODE_TAGLINE_BOX),
        "kalvoice-wordmark.png": lettering(kalvoice, KALVOICE_WORDMARK_BOX),
        "kalvoice-tagline.png": lettering(kalvoice, KALVOICE_TAGLINE_BOX),
    }
    for name, image in letters.items():
        for directory in (BRANDING, WEB, DESKTOP):
            image.save(directory / name, optimize=True)

    # 2. In-product marks (website header, desktop sidebar) and symbols (hero, About, KalVoice).
    for size in (256, 128, 64):
        for directory in (WEB, DESKTOP):
            icon(kalcode, KALCODE, size).save(directory / f"kalcode-mark-{size}.png", optimize=True)
            icon(kalvoice, KALVOICE, size).save(directory / f"kalvoice-mark-{size}.png", optimize=True)
    save_web(isolate(kalcode, KALCODE, solid=False), "kalcode-globe", [362, 724], [WEB, DESKTOP])
    save_web(isolate(kalvoice, KALVOICE, solid=False), "kalvoice-globe", [300, 600], [WEB, DESKTOP])

    # 3. Full boards as marketing visuals (website only).
    for name in SOURCES:
        board = Image.open(MASTERS / name).convert("RGB")
        save_web(board, name.removesuffix(".png"), [1254, 627], [WEB], quality=86)

    # 4. Website favicons and social card.
    frames = {s: icon(kalcode, KALCODE, s) for s in (16, 32, 48)}
    frames[32].save(SITE / "favicon-32.png", optimize=True)
    frames[48].save(SITE / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)], append_images=[frames[16], frames[32]])
    on_ground(isolate(kalcode, KALCODE, solid=True), 180, 6).save(SITE / "apple-touch-icon.png", optimize=True)
    social_card(Image.open(MASTERS / "kalcode-board.png").convert("RGB")).save(SITE / "og.png", optimize=True)

    # 5. Desktop application icons, via Tauri's icon generator, then a hand-built multi-size ICO.
    icon_source = ROOT / "target" / "brand-icon-1024.png"
    icon_source.parent.mkdir(parents=True, exist_ok=True)
    icon(kalcode, KALCODE, 1024).save(icon_source)
    subprocess.run(["cargo", "tauri", "icon", str(icon_source), "-o", str(ICONS)], cwd=ROOT / "apps" / "desktop", check=True, capture_output=True)
    for mobile in ("android", "ios"):
        shutil.rmtree(ICONS / mobile, ignore_errors=True)
    sizes = (16, 24, 32, 48, 64, 128, 256)
    ico = {s: icon(kalcode, KALCODE, s) for s in sizes}
    ico[256].save(ICONS / "icon.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=[ico[s] for s in sizes if s != 256])
    ico[32].save(ICONS / "32x32.png")
    print("brand assets generated from the boards")
    return 0


if __name__ == "__main__":
    sys.exit(main())
