"""Rebuilds the small desktop icon sizes from the simplified mark so they stay legible.

Run after `cargo tauri icon` (which renders every size from the detailed mark):
  python tooling/generate-app-icons.py
"""
import io
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "apps" / "desktop" / "src-tauri" / "icons"
SMALL = ROOT / "packages" / "ui" / "src" / "brand" / "mark-small.svg"
DETAILED = ROOT / "packages" / "ui" / "src" / "brand" / "mark.svg"
RENDER = ROOT / "tooling" / "render-preview.mjs"


def render(svg: Path, size: int) -> Image.Image:
    out = ICONS / f".tmp-{size}.png"
    subprocess.run(["node", str(RENDER), str(svg), str(out), str(size)], check=True, capture_output=True)
    image = Image.open(out).convert("RGBA")
    image.load()
    out.unlink()
    return image


def main() -> int:
    frames = {size: render(SMALL if size <= 48 else DETAILED, size) for size in (16, 24, 32, 48, 64, 128, 256)}
    frames[32].save(ICONS / "32x32.png")
    frames[256].save(
        ICONS / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in frames],
        append_images=[frames[s] for s in frames if s != 256],
    )
    for name, size in (("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44)):
        render(SMALL, size).save(ICONS / name)
    print("icons: small sizes rebuilt from mark-small.svg")
    return 0


if __name__ == "__main__":
    sys.exit(main())
