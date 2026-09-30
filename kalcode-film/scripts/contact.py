"""Contact sheet every 0.5 s + full-resolution keyframes. python scripts/contact.py video sheet.png [keyframe_dir]"""
import subprocess, sys, io
from pathlib import Path
from PIL import Image, ImageDraw
video, out = sys.argv[1], sys.argv[2]
kdir = sys.argv[3] if len(sys.argv) > 3 else None
dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video], capture_output=True, text=True).stdout)
tmp = Path("build/contact_frames"); tmp.mkdir(parents=True, exist_ok=True)
for f in tmp.glob("*.png"): f.unlink()
subprocess.run(["ffmpeg", "-loglevel", "error", "-i", video, "-vf", "fps=2,scale=240:-2", str(tmp / "f_%04d.png")], check=True)
files = sorted(tmp.glob("f_*.png"))
ims = [Image.open(f).convert("RGB") for f in files]
tw, th = ims[0].size
cols = 12 if tw > th else 15
rows = (len(ims) + cols - 1) // cols
sheet = Image.new("RGB", (cols * tw, rows * th), (0, 0, 0))
d = ImageDraw.Draw(sheet)
for i, im in enumerate(ims):
    x, y = (i % cols) * tw, (i // cols) * th
    sheet.paste(im, (x, y)); d.text((x + 3, y + 2), f"{i * 0.5:.1f}", fill=(255, 200, 0))
sheet.save(out)
if kdir:
    Path(kdir).mkdir(parents=True, exist_ok=True)
    for t in [0, 6, 10, 16, 23, 31, 37, 43, 50, 55, 59]:
        tt = min(t + (0.02 if t == 0 else 0), dur - 1 / 60)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{tt:.3f}", "-i", video, "-frames:v", "1", f"{kdir}/kf_{t:02d}s.png"], check=True)
print(len(ims), "tiles")
