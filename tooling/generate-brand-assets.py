"""KalCode brand asset pipeline.

The owner's brand artwork is the brand. This script never alters it: it copies the master PNGs
byte-for-byte into the repository (verified by SHA-256) and derives every logo, icon, web and
desktop asset from their actual pixels — cutouts, crops, resizes, and luminance-to-alpha
extraction. The mascot is never redrawn; the only additions are a background tile, a rim light
for dark surfaces, and layout.

  - KalCode logo: the mascot (kalcode-mascot.png, on white). Its white ground is removed; the
    dark variant adds a soft blue rim light so the navy figure reads on KalCode's dark theme.
  - KalCode lettering: the wordmark and tagline from the KalCode board.
  - KalVoice: the orb, wordmark and tagline from the KalVoice board.

Usage:
  python tooling/generate-brand-assets.py [--source-dir ~/Downloads]

Masters (source of truth):  packages/ui/src/brand/masters/  (kalcode-mascot.png, kalcode-board.png,
                            kalvoice-board.png)
Production logos:           assets/branding/                (app icon, mascot variants, social,
                            lettering, KalVoice symbols)
Derivatives:                apps/website/public/assets/brand/, apps/website/public/ (favicons, og),
                            apps/desktop/src/assets/brand/, apps/desktop/src-tauri/icons/
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
MASTERS = ROOT / "packages" / "ui" / "src" / "brand" / "masters"
BRANDING = ROOT / "assets" / "branding"
WEB = ROOT / "apps" / "website" / "public" / "assets" / "brand"
SITE = ROOT / "apps" / "website" / "public"
DESKTOP = ROOT / "apps" / "desktop" / "src" / "assets" / "brand"
ICONS = ROOT / "apps" / "desktop" / "src-tauri" / "icons"
SOCIAL = BRANDING / "social"
HERO_PLATE = SITE / "assets" / "hero" / "world" / "world-1920.webp"

SOURCES = {
    "kalcode-mascot.png": "KalCode New Logo For Everything.png",
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


KALVOICE = Symbol(
    center=(620, 322),
    half=310,
    sphere_center=(620, 325),
    sphere_radius=229,
    compact_half=262,
    y_limit=598,
)

# The KalCode mascot (master pixel coordinates, 1254 x 1254, on white).
MASCOT_SHADOW_Y = 1008  # the soft ground shadow under the feet starts here (light surfaces only)
MASCOT_BUST = (636, 500, 380)  # centre x, centre y, half-size: head, laptop and chest (icons)
MASCOT_HEAD = (560, 410, 265)  # head and its pixel trail (icons below 64 px)
# The app icon: the mascot on a deep navy tile.
TILE_TOP = (20, 34, 66)
TILE_BOTTOM = (6, 10, 22)
RIM = (120, 175, 255)
RIM_GLOW = (40, 120, 255)

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


def mascot_cutout() -> tuple[np.ndarray, np.ndarray]:
    """The mascot without its white ground, as float RGBA 0..255: (with ground shadow, without).

    The ground is everything light that connects to the image border (the two eyes are the only
    enclosed light areas, so they stay opaque). Along the ground, alpha is recovered by un-mixing
    white: a pixel C = a*F + (1 - a)*white with the smallest a that C allows, so antialiased edges
    and the laptop's glow keep their colour without a white fringe.
    """
    src = np.asarray(Image.open(MASTERS / "kalcode-mascot.png").convert("RGB")).astype(np.float32)
    ink = 255 - src.min(axis=2)
    light = (ink < 70).astype(np.uint8)
    _, labels = cv2.connectedComponents(light, connectivity=4)
    border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    ground = (np.isin(labels, border) & (light > 0)).astype(np.uint8)
    edge = cv2.dilate(ground, np.ones((9, 9), np.uint8)) > 0
    alpha = np.where(edge, ink / 255, 1.0)
    a = alpha[..., None]
    color = np.where(a > 1e-3, (src - (1 - a) * 255) / np.maximum(a, 1e-3), 0)
    with_shadow = np.dstack([np.clip(color, 0, 255), alpha * 255])
    rows = np.mgrid[0 : src.shape[0], 0 : src.shape[1]][0]
    without = with_shadow.copy()
    without[..., 3] = np.where((rows > MASCOT_SHADOW_Y) & (ink < 90), 0, without[..., 3])
    return with_shadow, without


def over(base: np.ndarray, rgb: tuple[int, int, int] | np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """`rgb` at `alpha` over the float RGBA `base` (straight alpha, 0..255)."""
    top = alpha[..., None]
    below = base[..., 3:4] / 255
    out_a = top + below * (1 - top)
    color = (np.asarray(rgb, np.float32) * top + base[..., :3] * below * (1 - top)) / np.maximum(out_a, 1e-4)
    return np.dstack([color, out_a * 255])


def rim_lit(art: np.ndarray) -> np.ndarray:
    """The dark-surface variant: a thin light-blue rim and a soft blue glow behind the figure."""
    solid = (art[..., 3] > 115).astype(np.uint8)
    grown = cv2.dilate(solid, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))).astype(np.float32)
    rim = cv2.GaussianBlur(grown, (0, 0), 2.45)
    glow = cv2.GaussianBlur(grown, (0, 0), 22) * 0.55
    out = np.zeros_like(art)
    out = over(out, RIM_GLOW, np.clip(glow, 0, 1))
    out = over(out, RIM, np.clip(rim, 0, 1))
    return over(out, art[..., :3], art[..., 3] / 255)


def to_image(art: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(art, 0, 255).round().astype(np.uint8), "RGBA")


def figure_square(art: np.ndarray, pad: float = 0.04) -> Image.Image:
    """The whole figure centred in a transparent square, `pad` of the side on each edge."""
    ys, xs = np.nonzero(art[..., 3] > 3)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    side = round(max(x1 - x0, y1 - y0) / (1 - 2 * pad))
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.alpha_composite(to_image(art[y0:y1, x0:x1]), ((side - (x1 - x0)) // 2, (side - (y1 - y0)) // 2))
    return square


def crop(art: np.ndarray, box: tuple[int, int, int]) -> Image.Image:
    cx, cy, half = box
    return to_image(art).crop((cx - half, cy - half, cx + half, cy + half))


def tile(dark: np.ndarray, size: int, *, margin: float, radius: float | None = 0.225) -> Image.Image:
    """The app icon: the rim-lit mascot on a navy tile, drawn at 1024 and resized.

    `margin` is the transparent border as a share of the canvas (Apple's icon grid: 100/1024);
    `radius` the corner radius as a share of the tile (None: a full-bleed square, for platforms
    that apply their own mask). From 64 px up the head, laptop and chest rise from the tile's
    bottom edge; below that the head alone fills the tile so the face stays legible.
    """
    n = 1024
    m = round(margin * n)
    body = n - 2 * m
    t = np.linspace(0, 1, body)[:, None, None]
    grad = np.asarray(TILE_TOP, np.float32) * (1 - t) + np.asarray(TILE_BOTTOM, np.float32) * t
    face = Image.fromarray(np.broadcast_to(grad, (body, body, 3)).round().astype(np.uint8), "RGB").convert("RGBA")
    if size >= 64:
        art = crop(dark, MASCOT_BUST).resize((round(body * 0.94),) * 2, Image.LANCZOS)
        face.alpha_composite(art, ((body - art.width) // 2, body - art.height))
    else:
        art = crop(dark, MASCOT_HEAD).resize((round(body * 0.96),) * 2, Image.LANCZOS)
        face.alpha_composite(art, ((body - art.width) // 2, round(body * 0.04)))
    mask = Image.new("L", (body * 4, body * 4), 0)
    if radius is None:
        mask.paste(255, (0, 0, body * 4, body * 4))
    else:
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, body * 4 - 1, body * 4 - 1), round(radius * body * 4), fill=255)
    face.putalpha(mask.resize((body, body), Image.LANCZOS))
    canvas = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    canvas.alpha_composite(face, (m, m))
    return resized(canvas, size)


def cover(img: Image.Image, width: int, height: int, focus_y: float = 0.5) -> Image.Image:
    """Scales and crops `img` to fill width x height."""
    scale = max(width / img.width, height / img.height)
    scaled = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    x = (scaled.width - width) // 2
    y = round((scaled.height - height) * focus_y)
    return scaled.crop((x, y, x + width, y + height))


def banner(
    dark: np.ndarray,
    words: Image.Image,
    tagline: Image.Image,
    size: tuple[int, int],
    *,
    mascot_h: float,
    mascot_x: float,
    text_x: float,
    text_w: float,
) -> Image.Image:
    """A dark social image: the hero's world plate, the mascot, the wordmark and the tagline."""
    width, height = size
    ground = cover(Image.open(HERO_PLATE).convert("RGBA"), width, height, focus_y=0.62)
    ground.alpha_composite(Image.new("RGBA", (width, height), (2, 4, 12, 90)))
    side = round(height * mascot_h)
    figure = resized(figure_square(dark, pad=0.0), side)
    ground.alpha_composite(figure, (round(width * mascot_x - side / 2), round((height - side) / 2)))
    word_w = round(width * text_w)
    word = words.resize((word_w, round(words.height * word_w / words.width)), Image.LANCZOS)
    tag_w = round(word_w * 0.82)
    tag = tagline.resize((tag_w, round(tagline.height * tag_w / tagline.width)), Image.LANCZOS)
    gap = round(height * 0.06)
    top = (height - (word.height + gap + tag.height)) // 2
    left = round(width * text_x)
    ground.alpha_composite(word, (left, top))
    ground.alpha_composite(tag, (left + (word.width - tag.width) // 2, top + word.height + gap))
    return ground.convert("RGB")


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


def clean(directory: Path, patterns: tuple[str, ...]) -> None:
    for pattern in patterns:
        for path in directory.glob(pattern):
            path.unlink()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, default=Path.home() / "Downloads")
    args = parser.parse_args()

    copy_masters(args.source_dir)
    kalcode = load("kalcode-board.png")
    kalvoice = load("kalvoice-board.png")
    light, clear = mascot_cutout()
    dark = rim_lit(clear)

    # Retired assets from earlier artwork (including the terminal-globe symbol and the boards).
    for directory in (WEB, DESKTOP):
        clean(directory, ("kalcode-artwork-*", "kalcode-brand.png", "*-board-*", "kalcode-globe-*"))
    for old in ("kalcode-brand.png", "kalvoice-globe.png"):
        (MASTERS / old).unlink(missing_ok=True)

    # 1. Production logos (assets/branding).
    BRANDING.mkdir(parents=True, exist_ok=True)
    SOCIAL.mkdir(parents=True, exist_ok=True)
    clean(BRANDING, ("*.png",))
    clean(SOCIAL, ("*.png",))
    for size in EXPORT_SIZES:
        tile(dark, size, margin=100 / 1024).save(BRANDING / f"kalcode-icon-{size}.png", optimize=True)
    light_square, dark_square = figure_square(light), figure_square(dark)
    light_square.save(BRANDING / "kalcode-mascot-light-source.png", optimize=True)
    dark_square.save(BRANDING / "kalcode-mascot-dark-source.png", optimize=True)
    for size in (1024, 512, 256):
        resized(light_square, size).save(BRANDING / f"kalcode-mascot-light-{size}.png", optimize=True)
        resized(dark_square, size).save(BRANDING / f"kalcode-mascot-dark-{size}.png", optimize=True)
    for size in EXPORT_SIZES:
        icon(kalvoice, KALVOICE, size).save(BRANDING / f"kalvoice-icon-{size}.png", optimize=True)
        icon(kalvoice, KALVOICE, size, solid=False).save(BRANDING / f"kalvoice-orb-{size}.png", optimize=True)
    isolate(kalvoice, KALVOICE, solid=True).save(BRANDING / "kalvoice-icon-source.png", optimize=True)
    isolate(kalvoice, KALVOICE, solid=False).save(BRANDING / "kalvoice-orb-source.png", optimize=True)
    letters = {
        "kalcode-wordmark.png": lettering(kalcode, KALCODE_WORDMARK_BOX),
        "kalcode-tagline.png": lettering(kalcode, KALCODE_TAGLINE_BOX),
        "kalvoice-wordmark.png": lettering(kalvoice, KALVOICE_WORDMARK_BOX),
        "kalvoice-tagline.png": lettering(kalvoice, KALVOICE_TAGLINE_BOX),
    }
    for name, image in letters.items():
        for directory in (BRANDING, WEB, DESKTOP):
            image.save(directory / name, optimize=True)

    # 2. In-product marks: the app icon tile filling its box, so the mark reads the same in the
    # light and dark themes (website header, desktop sidebar, startup, onboarding). Large art:
    # the rim-lit mascot (website fallback hero, desktop About and gated screens).
    for size in (256, 128, 64):
        for directory in (WEB, DESKTOP):
            tile(dark, size, margin=0).save(directory / f"kalcode-mark-{size}.png", optimize=True)
            icon(kalvoice, KALVOICE, size).save(directory / f"kalvoice-mark-{size}.png", optimize=True)
    save_web(dark_square, "kalcode-mascot", [362, 724], [WEB, DESKTOP])
    save_web(isolate(kalvoice, KALVOICE, solid=False), "kalvoice-globe", [300, 600], [WEB, DESKTOP])

    # 3. The KalVoice board as a marketing visual (website only).
    board = Image.open(MASTERS / "kalvoice-board.png").convert("RGB")
    save_web(board, "kalvoice-board", [1254, 627], [WEB], quality=86)

    # 4. Website favicons and social card; X (Twitter) profile image and header.
    frames = {s: tile(dark, s, margin=0, radius=0.2) for s in (16, 32, 48)}
    frames[32].save(SITE / "favicon-32.png", optimize=True)
    frames[48].save(SITE / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)], append_images=[frames[16], frames[32]])
    tile(dark, 180, margin=0, radius=None).convert("RGB").save(SITE / "apple-touch-icon.png", optimize=True)
    words, tagline = letters["kalcode-wordmark.png"], letters["kalcode-tagline.png"]
    og = banner(dark, words, tagline, (1200, 630), mascot_h=0.84, mascot_x=0.22, text_x=0.46, text_w=0.47)
    og.save(SITE / "og.png", optimize=True)
    og.save(SOCIAL / "kalcode-og-1200x630.png", optimize=True)
    # X crops the profile image to a circle: a full-bleed square keeps the face inside it.
    tile(dark, 400, margin=0, radius=None).convert("RGB").save(SOCIAL / "kalcode-x-avatar-400.png", optimize=True)
    header = banner(dark, words, tagline, (1500, 500), mascot_h=0.9, mascot_x=0.8, text_x=0.3, text_w=0.4)
    header.save(SOCIAL / "kalcode-x-header-1500x500.png", optimize=True)

    # 5. Desktop application icons (macOS ICNS, Windows ICO, PNGs) via Tauri's icon generator,
    # then a hand-built multi-size ICO whose small frames fill more of their square.
    icon_source = ROOT / "target" / "brand-icon-1024.png"
    icon_source.parent.mkdir(parents=True, exist_ok=True)
    tile(dark, 1024, margin=100 / 1024).save(icon_source)
    subprocess.run(["cargo", "tauri", "icon", str(icon_source), "-o", str(ICONS)], cwd=ROOT / "apps" / "desktop", check=True, capture_output=True)
    for mobile in ("android", "ios"):
        shutil.rmtree(ICONS / mobile, ignore_errors=True)
    sizes = (16, 24, 32, 48, 64, 128, 256)
    ico = {s: tile(dark, s, margin=0.04 if s < 64 else 100 / 1024) for s in sizes}
    ico[256].save(ICONS / "icon.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=[ico[s] for s in sizes if s != 256])
    ico[32].save(ICONS / "32x32.png")
    print("brand assets generated from the masters")
    return 0


if __name__ == "__main__":
    sys.exit(main())
