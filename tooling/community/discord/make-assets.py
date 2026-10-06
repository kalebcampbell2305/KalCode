"""Discord server art, derived from the official social assets (assets/branding/social).

    python tooling/community/discord/make-assets.py

Writes assets/branding/discord/:
  kalcode-discord-icon-512.png          server icon (the dark, rim-lit mascot avatar; reads at every size)
  kalcode-discord-banner-960x540.png    server banner (needs boost level 2), 16:9 crop of the OG art
  kalcode-discord-splash-1920x1080.png  invite background (needs boost level 1), same crop
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
SOCIAL = ROOT / "assets" / "branding" / "social"
OUT = ROOT / "assets" / "branding" / "discord"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    avatar = Image.open(SOCIAL / "kalcode-x-avatar-400.png").convert("RGB")
    avatar.resize((512, 512), Image.LANCZOS).save(OUT / "kalcode-discord-icon-512.png", optimize=True)
    og = Image.open(SOCIAL / "kalcode-og-1200x630.png").convert("RGB")
    w = round(og.height * 16 / 9)  # 1120: keeps the mascot and the wordmark, trims the edges evenly
    left = (og.width - w) // 2
    art = og.crop((left, 0, left + w, og.height))
    art.resize((960, 540), Image.LANCZOS).save(OUT / "kalcode-discord-banner-960x540.png", optimize=True)
    art.resize((1920, 1080), Image.LANCZOS).save(OUT / "kalcode-discord-splash-1920x1080.png", optimize=True)


if __name__ == "__main__":
    main()
