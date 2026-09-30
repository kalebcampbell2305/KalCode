import sys, math
from PIL import Image, ImageDraw
out, files = sys.argv[1], sys.argv[2:]
ims = [Image.open(f).convert("RGB") for f in files]
w0, h0 = ims[0].size
cols = 2 if w0 > h0 else 4
tw = 960 if w0 > h0 else 400
th = int(tw * h0 / w0)
rows = math.ceil(len(ims) / cols)
sh = Image.new("RGB", (cols * tw, rows * th), (20, 20, 20))
d = ImageDraw.Draw(sh)
for i, (im, f) in enumerate(zip(ims, files)):
    x, y = (i % cols) * tw, (i // cols) * th
    sh.paste(im.resize((tw, th)), (x, y))
    d.text((x + 8, y + 6), f.split("_")[-1].replace(".png", "s"), fill=(255, 200, 0))
sh.save(out)
