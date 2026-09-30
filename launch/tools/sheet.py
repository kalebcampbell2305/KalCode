"""Contact sheet: python tools/sheet.py <dir> <out.png> [cols] [w]"""
import sys, glob, os
from PIL import Image, ImageDraw
d, out = sys.argv[1], sys.argv[2]
cols = int(sys.argv[3]) if len(sys.argv) > 3 else 3
w = int(sys.argv[4]) if len(sys.argv) > 4 else 640
fs = sorted(glob.glob(os.path.join(d, "*.png")))
h = w * 9 // 16
sheet = Image.new("RGB", (w * cols, (h + 4) * ((len(fs) + cols - 1) // cols)), (80, 80, 80))
for i, f in enumerate(fs):
    im = Image.open(f).convert("RGB").resize((w, h), Image.LANCZOS)
    ImageDraw.Draw(im).text((8, 6), os.path.basename(f)[:-4], fill=(255, 220, 0))
    sheet.paste(im, ((i % cols) * w, (i // cols) * (h + 4)))
sheet.save(out)
