"""Utility: swap the retired terminal-globe mark for the mascot mark in UI captures.

The owner retired the globe (feat/brand-mascot-logo makes the mascot the in-app mark; the
KALCODE lettering stays). Originals are kept in capture/plates_orig/.
"""
import glob
import os
import shutil

import numpy as np
from PIL import Image, ImageDraw

L = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PL = os.path.join(L, "capture", "plates")
ORIG = os.path.join(L, "capture", "plates_orig")
MARK = Image.open(os.path.join(L, "assets", "brand", "kalcode-mark-128.png")).convert("RGBA")
MASCOT = Image.open(os.path.join(L, "assets", "brand", "kalcode-mascot-dark-1024.png")).convert("RGBA")


def swap(im, cx, cy, r, size, bg_xy):
    # fill the old mark with the ground it sat on, blended row by row between the left and right
    # neighbours so the sidebar gradient continues under the new mark
    a = np.asarray(im.convert("RGB")).astype(np.float32)
    out = a.copy()
    x0, x1 = cx - r - 2, cx + r + 2
    for y in range(cy - r, cy + r + 1):
        left, right = a[y, max(0, x0)], a[y, min(a.shape[1] - 1, x1)]
        for x in range(x0, x1 + 1):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                t = (x - x0) / (x1 - x0)
                out[y, x] = left * (1 - t) + right * t
    im = Image.fromarray(out.astype(np.uint8), "RGB").convert("RGBA")
    m = MARK.resize((size, size), Image.LANCZOS)
    im.alpha_composite(m, (cx - size // 2, cy - size // 2))
    return im


def hero(im):
    """site_home: the hero art is the globe with orbit rings. Inpaint it from the surrounding sky
    (multi-scale normalized convolution + star texture borrowed from open sky), keep the KALCODE
    lettering, and stand the mascot there (the redesigned site hero is the mascot)."""
    from scipy.ndimage import binary_dilation, binary_opening, gaussian_filter

    a = np.asarray(im.convert("RGB")).astype(np.float32)
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy, rx, ry = 1572, 572, 372, 290
    ell = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1
    r, b = a[..., 0], a[..., 2]
    letters = binary_opening((yy >= 770) & (r > 120) & (b - r < 70), iterations=4)  # solid glyphs only
    letters = binary_dilation(letters, iterations=3) & (yy >= 765)
    hole = ell & ~letters
    known = (~hole & ~binary_dilation(letters, iterations=12)).astype(np.float32)
    est = None
    for s in (160, 80, 40, 20):
        kb = gaussian_filter(known, s)
        cur = np.stack([gaussian_filter(a[..., c] * known, s) for c in range(3)], -1) / np.maximum(kb, 1e-6)[..., None]
        wt = np.clip(kb * 4, 0, 1)[..., None]
        est = cur if est is None else cur * wt + est * (1 - wt)
    donor = np.roll(a, 760, axis=1)
    est = est + np.clip(donor - np.stack([gaussian_filter(donor[..., c], 6) for c in range(3)], -1), 0, None) * 0.9
    feather = gaussian_filter(hole.astype(np.float32), 4)[..., None]
    out = a * (1 - feather) + est * feather
    out[letters] = a[letters]
    d2 = ((xx - cx) / 300.0) ** 2 + ((yy - 548) / 300.0) ** 2
    glow = np.exp(-d2 * 2.2)[..., None] * np.array([40, 95, 190], np.float32) * 0.55
    glow[letters] = 0
    out = 255 - (255 - out) * (1 - glow / 255)
    res = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    size = 520
    res.alpha_composite(MASCOT.resize((size, size), Image.LANCZOS), (cx - size // 2, 770 - size + 18))
    return res


if not os.path.isdir(ORIG):
    shutil.copytree(PL, ORIG)
n = 0
for src in glob.glob(os.path.join(ORIG, "**", "*.png"), recursive=True):
    rel = os.path.relpath(src, ORIG)
    im = Image.open(src).convert("RGBA")
    base = os.path.basename(rel)
    if im.size == (3200, 1920) and not base.startswith("site_"):
        im = swap(im, 54, 63, 29, 50, (96, 63))
    elif base == "site_download_pane.png":
        im = swap(im, 77, 63, 34, 56, (125, 63))
    elif base in ("site_home.png", "site_download.png"):  # live-site header mark (chaos act)
        im = swap(im, 348, 63, 34, 56, (396, 63))
        if base == "site_home.png":
            im = hero(im)
    else:
        continue
    im.convert("RGB").save(os.path.join(PL, rel))
    n += 1
# the Browser-pane composite is rebuilt from the patched page
b = Image.open(os.path.join(PL, "code_browser_clean.png")).convert("RGB")
s = Image.open(os.path.join(PL, "site_download_pane.png")).convert("RGB")
b.paste(s.resize((667 * 2, 724 * 2)), (924 * 2, 174 * 2))
b.save(os.path.join(PL, "code_browser_site.png"))
print("rebranded", n, "plates")
