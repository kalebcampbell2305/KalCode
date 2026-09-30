# Tile frames around every scene boundary (motion review): python scripts/transitions.py video out.png
import json, subprocess, sys
from PIL import Image, ImageDraw
video, out = sys.argv[1], sys.argv[2]
cue = json.load(open("cue_sheet.json"))
bounds = [s["start"]["t"] for s in cue["scenes"][1:]]
offs = [-0.4, -0.2, 0.0, 0.1, 0.25, 0.5]
tw, th = 320, 180
sheet = Image.new("RGB", (tw * len(offs), th * len(bounds)), (0, 0, 0))
d = ImageDraw.Draw(sheet)
for r, b in enumerate(bounds):
    for c, o in enumerate(offs):
        t = b + o
        png = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", f"{t:.4f}", "-i", video, "-frames:v", "1", "-vf", f"scale={tw}:{th}", "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True).stdout
        import io
        im = Image.open(io.BytesIO(png)).convert("RGB")
        sheet.paste(im, (c * tw, r * th))
        d.text((c * tw + 4, r * th + 2), f"{t:.2f}", fill=(255, 200, 0))
sheet.save(out)
