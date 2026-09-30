"""Render frames from an open .blend: blender -b x.blend -P tools/render.py -- <outdir> <frames|a-b> [samples]"""
import bpy, os, sys, time
args = sys.argv[sys.argv.index("--") + 1:]
out, spec = args[0], args[1]
sc = bpy.context.scene
if len(args) > 2:
    sc.eevee.taa_render_samples = int(args[2])
os.makedirs(out, exist_ok=True)
if "-" in spec:
    a, b = map(int, spec.split("-"))
    frames = range(a, b + 1)
else:
    frames = [int(x) for x in spec.split(",")]
t0 = time.time()
for f in frames:
    path = os.path.join(out, f"{f:04d}.png")
    if os.environ.get("KC_SKIP_EXISTING") and os.path.exists(path) and os.path.getsize(path) > 10000:
        continue
    sc.frame_set(f)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
print("RENDERED", len(list(frames)), "in", round(time.time() - t0, 1), "s")
