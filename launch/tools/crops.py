"""Utility: cut captured KalCode UI plates (DPR 2) into layers for Blender.

Rects are CSS px (x0, y0, x1, y1) on the 1600x960 viewport; plates are 3200x1920.
Output: launch/assets/ui/<name>.png
"""
import os, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PLATES = os.path.join(HERE, "..", "capture", "plates")
OUT = os.path.join(HERE, "..", "assets", "ui")
os.makedirs(OUT, exist_ok=True)

CROPS = {
    # chaos fragments: separate "windows"
    "frag_gitlog": ("code", (248, 100, 960, 400)),
    "frag_tests": ("term/034", (248, 100, 900, 460)),
    "frag_thread_claude": ("threads", (590, 165, 1558, 600)),
    "frag_thread_codex": ("v_focus/before", (590, 165, 1558, 600)),
    "frag_thread_list": ("threads", (272, 162, 576, 700)),
    "frag_card_needs": ("dash", (272, 300, 580, 551)),
    "frag_card_browser": ("dash", (272, 602, 580, 826)),
    "frag_card_updater": ("dash", (591, 602, 899, 826)),
    "frag_activity": ("dash", (1238, 675, 1554, 960)),
    "frag_agents": ("dash", (1238, 330, 1554, 440)),
    "frag_accounts": ("accounts", (272, 440, 1558, 920)),
    "frag_newthread": ("newthread", (590, 165, 1558, 940)),
    "frag_site_home": ("site_home", (0, 0, 1600, 960)),
    "frag_site_download": ("site_download", (0, 0, 1600, 960)),
    "frag_pill_listen": ("v_focus/listen_012", (696, 8, 1144, 124)),
    # window layers (Threads / Code states share geometry)
    "pill_ready": ("threads", (738, 6, 1102, 46)),
}


def crop(src, rect):
    im = Image.open(os.path.join(PLATES, src + ".png")).convert("RGBA")
    x0, y0, x1, y1 = (v * 2 for v in rect)
    return im.crop((x0, y0, x1, y1))


if __name__ == "__main__":
    names = sys.argv[1:] or list(CROPS)
    for n in names:
        src, rect = CROPS[n]
        crop(src, rect).save(os.path.join(OUT, n + ".png"))
        print(n, rect)
