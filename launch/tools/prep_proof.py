"""Utility: window pieces + retimed UI frame sequences for the proof / film scenes.

Rects are CSS px on the 1600x960 viewport (plates are DPR 2).
"""
import os, shutil
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PLATES = os.path.join(HERE, "..", "capture", "plates")
UI = os.path.join(HERE, "..", "assets", "ui")
SEQ = os.path.join(HERE, "..", "assets", "seq")

SIDEBAR = (0, 0, 240, 960)
HEADER = (240, 0, 1600, 52)
MAIN = (240, 52, 1600, 960)
PILL = (690, 0, 1150, 130)
TERM = (253, 135, 1591, 923)
LIST = (272, 162, 577, 945)
DETAIL = (588, 162, 1560, 945)


def load(name):
    return Image.open(os.path.join(PLATES, name + ".png")).convert("RGB")


def cut(im, r):
    return im.crop(tuple(v * 2 for v in r))


def save(im, *parts):
    p = os.path.join(*parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    im.save(p)


def pieces(prefix, plate):
    im = load(plate)
    save(cut(im, SIDEBAR), UI, f"{prefix}_sidebar.png")
    save(cut(im, HEADER), UI, f"{prefix}_header.png")
    save(cut(im, MAIN), UI, f"{prefix}_main.png")
    save(im, UI, f"{prefix}_full.png")


def sequence(name, frames, rect, holds):
    """frames: list of plate names; holds: frames to hold each (same length or int)."""
    out = os.path.join(SEQ, name)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    n = 0
    for i, f in enumerate(frames):
        h = holds[i] if isinstance(holds, list) else holds
        im = cut(load(f), rect)
        for _ in range(h):
            im.save(os.path.join(out, f"{n:04d}.png"))
            n += 1
    print(name, n, "frames")
    return n


if __name__ == "__main__":
    pieces("code", "code")
    pieces("thA", "v_focus/before")   # Updater retry selected
    pieces("thB", "v_tell/before")    # Browser redesign selected
    save(cut(load("v_tell/before"), PILL), UI, "pill_ready_region.png")
    # terminal: clear screen, type "pnpm test" (3 f/char), stream results (3 f/capture)
    term = ["code_clear"] * 1 + [f"term/{i:03d}" for i in range(35)]
    sequence("term", term, TERM, [12] + [3] * 9 + [3] * 26)
    # KalVoice listening (hold F8): 16 captures, 4 f each
    sequence("pill_listen", [f"v_focus/listen_{i:03d}" for i in range(16)], PILL, 4)
    # tell: listening + result pill
    sequence("pill_tell", [f"v_tell/listen_{i:03d}" for i in range(16)] + [f"v_tell/after_{i:03d}" for i in range(16)], PILL, 4)
    sequence("thread_tell", [f"v_tell/after_{i:03d}" for i in range(16)], MAIN, 4)
