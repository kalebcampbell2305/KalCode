"""Procedural space environment art for the website (planets, rocky horizons, wave-energy void).

Everything here is rendered from noise and simple lighting maths, once, into static images; no
stock or third-party imagery. The palette and the starfield come from the owner's KalCode banner
(the stars layer produced by tooling/generate-hero-world.py), so the procedural pieces sit in the
same world as the banner-derived hero.

Usage:  python tooling/generate-space-art.py        (run generate-hero-world.py first)
Output: apps/website/public/assets/hero/world/
  planet-rim.{webp,avif}      a large dark planet lit from behind: luminous blue limb, faint
                              surface, atmospheric halo (alpha). Lit from the upper left, so it
                              reads best at the right page edge; mirror it for the left edge.
  planet-small.webp           a smaller moon-like body (alpha), for depth
  rocky-horizon.{webp,avif}   a planet's glowing rim across the sky behind dark rocky terrain
  void-waves.{webp,avif}      dark void with faint horizontal wave-energy lines (KalVoice)
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "apps" / "website" / "public" / "assets" / "hero" / "world"

BLUE = np.array([76, 141, 255], np.float32)  # --color-accent (Constellation)
ICE = np.array([190, 220, 255], np.float32)
GROUND = np.array([0, 1, 4], np.float32)  # the brand boards' black


def fbm2(h: int, w: int, rng: np.random.Generator, octaves: int = 6, base: int = 4, gain: float = 0.55) -> np.ndarray:
    """Fractal value noise by summing upsampled random grids (0..1)."""
    out = np.zeros((h, w), np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        gh, gw = base * 2**o, base * 2**o * max(1, w // h)
        grid = rng.random((gh + 1, gw + 1), dtype=np.float32)
        out += amp * cv2.resize(grid, (w, h), interpolation=cv2.INTER_CUBIC)
        total += amp
        amp *= gain
    out /= total
    return np.clip((out - out.min()) / (out.max() - out.min() + 1e-6), 0, 1)


def fbm1(n: int, rng: np.random.Generator, octaves: int = 7, base: int = 3, gain: float = 0.5) -> np.ndarray:
    out = np.zeros(n, np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        k = base * 2**o
        grid = rng.random(k + 1).astype(np.float32)
        out += amp * np.interp(np.linspace(0, k, n), np.arange(k + 1), grid)
        total += amp
        amp *= gain
    return out / total


def save(img: np.ndarray, name: str, alpha: np.ndarray | None = None, avif: bool = True, q: int = 58) -> None:
    rgb = np.clip(img, 0, 255).round().astype(np.uint8)
    if alpha is not None:
        a = np.clip(alpha * 255, 0, 255).round().astype(np.uint8)
        pil = Image.fromarray(np.dstack([rgb, a]), "RGBA")
    else:
        pil = Image.fromarray(rgb, "RGB")
    pil.save(OUT / f"{name}.webp", "WEBP", quality=q + 22, method=6, alpha_quality=90)
    if avif:
        pil.save(OUT / f"{name}.avif", "AVIF", quality=q)


def planet(size: int, rng: np.random.Generator, light=(-0.55, -0.45, -0.7), rim_boost: float = 1.0, halo: float = 0.09):
    """A planet seen against space, lit mostly from behind: returns (straight RGB, alpha)."""
    n = size
    r0 = n * 0.40
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    x = (xx - n / 2) / r0
    y = (yy - n / 2) / r0
    rr = np.sqrt(x * x + y * y)
    inside = rr <= 1.0
    z = np.sqrt(np.clip(1 - rr * rr, 0, 1))
    lx, ly, lz = light
    ln = np.sqrt(lx * lx + ly * ly + lz * lz)
    lx, ly, lz = lx / ln, ly / ln, lz / ln
    ndotl = x * lx + y * ly + z * lz

    # Surface: equirectangular fbm sampled through the sphere (continents, ridges, soft bands).
    tex = fbm2(512, 1024, rng, octaves=7, base=3)
    ridges = 1 - np.abs(fbm2(512, 1024, rng, octaves=6, base=4) * 2 - 1)
    surface = 0.65 * tex + 0.35 * ridges**3
    lon = (np.arctan2(x, z) / (2 * np.pi) + 0.5) * 1023
    lat = (np.arcsin(np.clip(y, -1, 1)) / np.pi + 0.5) * 511
    s = cv2.remap(surface, lon.astype(np.float32), lat.astype(np.float32), cv2.INTER_LINEAR)

    diffuse = np.clip(ndotl, 0, 1) ** 1.2
    fresnel = (1 - z) ** 3.2
    toward = np.clip(0.5 + 0.5 * (-(x * lx + y * ly) / (rr + 1e-4) / np.hypot(lx, ly)), 0, 1) ** 2
    # Thin lit crescent: back light wraps a little way onto the surface near the limb.
    wrap = np.clip((1 - z) * 2.2, 0, 1) ** 2 * toward
    body = GROUND + np.array([5, 11, 24], np.float32) * (0.3 + 1.1 * s[..., None])
    body = body + BLUE * (diffuse * (0.25 + 0.6 * s) + wrap * (0.18 + 0.5 * s))[..., None]
    # Luminous limb: back-scattered light around the whole rim, strongest toward the light.
    limb = fresnel * (0.06 + 1.9 * toward) * rim_boost
    body = body + (BLUE * 0.9 + ICE * 0.35 * toward[..., None]) * limb[..., None]

    # Atmospheric halo outside the disc.
    d = np.clip(rr - 1.0, 0, None)
    glow = np.exp(-d / halo) * (0.04 + 1.1 * toward) * rim_boost
    edge = np.clip((1.0 - rr) * r0 + 0.5, 0, 1)  # 1 px anti-aliased disc
    # The halo must reach zero before the image edge (no visible box when composited).
    fade = np.clip((1.24 - rr) / 0.16, 0, 1) ** 2
    alpha = np.maximum(edge, np.clip(glow, 0, 1) * 0.85 * fade)
    rgb = np.where(inside[..., None], body, BLUE * 1.15 + ICE * 0.2 * toward[..., None])
    return rgb, alpha


def rocky_horizon(w: int, h: int, rng: np.random.Generator, stars: np.ndarray | None) -> np.ndarray:
    img = np.zeros((h, w, 3), np.float32) + GROUND
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)

    # Sky depth and banner stars.
    img += np.array([2, 6, 18], np.float32) * np.clip(1 - yy / h, 0, 1)[..., None]
    if stars is not None:
        st = cv2.resize(stars, (w, int(stars.shape[0] * w / stars.shape[1])), interpolation=cv2.INTER_AREA)
        st = st[: int(h * 0.62)]
        img[: st.shape[0]] += st[..., :3] * (st[..., 3:4] / 255) * 0.55

    # A giant planet whose glowing limb arcs across the sky (centre far below the frame).
    cx, cy, R = w * 0.5, h * 2.05, h * 1.62
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    inside = dist < R
    limb_d = dist - R
    rim = np.exp(-np.abs(limb_d) / (h * 0.006)) * 1.0 + np.exp(-np.clip(-limb_d, 0, None) / (h * 0.05)) * 0.25 * inside
    halo = np.exp(-np.clip(limb_d, 0, None) / (h * 0.09)) * (~inside)
    crown = np.exp(-(((xx - cx) / (w * 0.22)) ** 2))  # brighter toward the centre of the arc
    img += (BLUE * 1.1 + ICE * 0.45 * crown[..., None]) * (rim * (0.45 + 0.9 * crown))[..., None]
    img += BLUE * (halo * (0.12 + 0.35 * crown))[..., None]
    surf = fbm2(h, w, rng, octaves=6, base=3)
    img = np.where(inside[..., None], GROUND + np.array([4, 10, 24], np.float32) * surf[..., None] + img * 0 + BLUE * (rim * 0.6)[..., None], img)
    flare = np.exp(-(((xx - cx) / (w * 0.035)) ** 2 + ((yy - (cy - R)) / (h * 0.012)) ** 2))
    img += ICE * flare[..., None] * 1.1

    # Rocky terrain: ridged-noise mountain layers, far to near; the nearest rises at the page
    # edges (framing the centre for type) and carries rock texture lit from behind.
    rock = fbm2(h, w, rng, octaves=8, base=6)
    gy, gx = np.gradient(cv2.GaussianBlur(rock, (0, 0), 1.2))
    facet = np.clip(-gy * 40, 0, 1)  # faces turned up toward the back light
    u = xx[0] / w
    layers = ((0.71, 0.06, 0.25, 0.45, 0.03), (0.79, 0.08, 0.17, 0.7, 0.12), (0.9, 0.1, 0.11, 1.0, 0.36))
    for i, (base_y, amp, bright, lit, sides) in enumerate(layers):
        ridge = 1 - np.abs(fbm1(w, rng, octaves=5, base=3 + 2 * i) * 2 - 1)
        ridge = np.convolve(ridge, np.ones(15) / 15, mode="same")
        boulders = fbm1(w, rng, octaves=3, base=10 + 6 * i)
        detail = fbm1(w, rng, octaves=5, base=90 + 40 * i)
        side = np.abs(u - 0.5) * 2
        top = h * (base_y - amp * (ridge**1.3 * 1.2 + boulders * 0.6 + detail * 0.08) - sides * side**2.4)
        below = yy >= top[None, :]
        depth = np.clip((yy - top[None, :]) / (h * 0.3), 0, 1)
        tone = GROUND + np.array([5, 10, 22], np.float32) * (bright * 5) * (0.35 + 0.9 * rock + 0.8 * facet)[..., None] * (1 - depth[..., None] * 0.8)
        tone = tone + BLUE * (facet * lit * 0.14 * (1 - depth) ** 2)[..., None]
        edge = np.exp(-np.clip(yy - top[None, :], 0, None) / (h * (0.003 + 0.002 * i))) * below
        tone = tone + (BLUE * 0.85 + ICE * 0.25) * (edge * lit * 0.6 * (0.45 + crown))[..., None]
        img = np.where(below[..., None], tone, img)
    # Ground mist in front of the far ridge.
    mist = np.exp(-(((yy - h * 0.74) / (h * 0.05)) ** 2)) * (0.3 + 0.7 * crown)
    img += BLUE * 0.12 * mist[..., None]
    return img


def void_waves(w: int, h: int, rng: np.random.Generator) -> np.ndarray:
    img = np.zeros((h, w, 3), np.float32) + GROUND
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    u = xx / w
    env = np.exp(-(((u - 0.5) / 0.28) ** 2))  # energy concentrated in the middle
    total = np.zeros((h, w), np.float32)
    for k in range(9):
        amp = h * (0.02 + 0.08 * rng.random()) * env
        freq = 2.5 + 5 * rng.random()
        phase = rng.random() * 6.28
        centre = h * (0.5 + (rng.random() - 0.5) * 0.08)
        yline = centre + amp * np.sin(u * freq * 6.2832 + phase) * np.sin(u * 3.1416)
        d = np.abs(yy - yline)
        total += np.exp(-d / (0.9 + 0.6 * rng.random())) * (0.25 + 0.75 * rng.random()) + np.exp(-d / 14) * 0.05
    total *= env
    img += (BLUE * 0.9 + ICE * 0.1) * total[..., None] * 0.9
    vign = np.exp(-(((yy - h / 2) / (h * 0.45)) ** 2) - (((xx - w / 2) / (w * 0.6)) ** 2))
    img += np.array([6, 14, 40], np.float32) * vign[..., None] * 0.6
    return img


def main() -> int:
    if not OUT.exists():
        print("run tooling/generate-hero-world.py first", file=sys.stderr)
        return 1
    rng = np.random.default_rng(2026)

    rgb, alpha = planet(1400, rng)
    save(rgb, "planet-rim", alpha)
    rgb, alpha = planet(520, rng, light=(0.4, -0.5, -0.75), rim_boost=0.7, halo=0.06)
    save(rgb, "planet-small", alpha, avif=False)

    stars_path = OUT / "backdrop-stars.webp"
    stars = np.asarray(Image.open(stars_path).convert("RGBA")).astype(np.float32) if stars_path.exists() else None
    save(rocky_horizon(2400, 1000, rng, stars), "rocky-horizon")
    save(void_waves(2000, 900, rng), "void-waves")

    for path in sorted(OUT.glob("planet-*")) + sorted(OUT.glob("rocky-*")) + sorted(OUT.glob("void-*")):
        print(f"  {path.name:26s} {path.stat().st_size / 1024:7.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
