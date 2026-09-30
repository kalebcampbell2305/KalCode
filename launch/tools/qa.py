"""Automated QA for rendered frames and deliverables.

Checks: every frame present, no blank/black frames outside the designed black beat (f291-318),
deliverable specs (resolution, fps, duration, codecs), loudness (-14 LUFS, <= -1 dBTP).
Writes out/qa_report.json.
"""
import glob
import json
import os
import re
import subprocess

import numpy as np
from PIL import Image

L = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FR = os.path.join(L, "render", "film")
OUT = os.path.join(L, "out")
DESIGNED_BLACK = range(291, 319)
report = {"frames": {}, "files": {}}

frames = sorted(glob.glob(os.path.join(FR, "*.png")))
nums = {int(os.path.basename(f)[:4]) for f in frames}
report["frames"]["count"] = len(frames)
report["frames"]["missing"] = [i for i in range(3600) if i not in nums]
dark = []
lum = []
for i in range(0, 3600, 2):
    p = os.path.join(FR, f"{i:04d}.png")
    if not os.path.exists(p):
        continue
    a = np.asarray(Image.open(p).convert("L").resize((192, 108)), dtype=np.float32)
    m = float(a.mean())
    lum.append((i, round(m, 1)))
    if a.max() < 12 and i not in DESIGNED_BLACK:
        dark.append(i)
report["frames"]["unexpected_blank"] = dark
report["frames"]["mean_luma_min"] = min(v for _, v in lum) if lum else None


def probe(path):
    j = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
                                  capture_output=True, text=True).stdout)
    v = next(s for s in j["streams"] if s["codec_type"] == "video")
    a = next((s for s in j["streams"] if s["codec_type"] == "audio"), None)
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
    I = re.findall(r"I:\s+(-?[\d.]+) LUFS", r)
    P = re.findall(r"Peak:\s+(-?[\d.]+) dBFS", r)
    return {
        "size": f'{v["width"]}x{v["height"]}', "fps": v["r_frame_rate"], "vcodec": v["codec_name"],
        "pix_fmt": v["pix_fmt"], "duration": round(float(j["format"]["duration"]), 3),
        "acodec": a["codec_name"] if a else None, "lufs": float(I[-1]) if I else None,
        "true_peak": float(P[-1]) if P else None, "bytes": int(j["format"]["size"]),
    }


for f in sorted(glob.glob(os.path.join(OUT, "*.mp4"))):
    report["files"][os.path.basename(f)] = probe(f)
json.dump(report, open(os.path.join(OUT, "qa_report.json"), "w"), indent=2)
print(json.dumps({k: (v if k != "frames" else {x: y for x, y in v.items() if x != "missing" or y}) for k, v in report.items()}, indent=1)[:3000])
