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
# EEVEE depth of field blurs the whole frame when a BLENDED overlay sits in front of the focus plane,
# even where it is fully transparent. Cull overlays that are invisible on the frame being rendered
# (zero Opacity, or text whose Wipe reveal has not started).
BLENDED = []
for o in sc.objects:
    m = o.active_material
    if not (m and m.node_tree and m.surface_render_method == "BLENDED"):
        continue
    gates = [n for n in (m.node_tree.nodes.get("Opacity"), m.node_tree.nodes.get("Wipe")) if n]
    if gates:
        BLENDED.append((o, gates, o.hide_render))


def cull_transparent():
    for o, gates, hidden in BLENDED:
        o.hide_render = hidden or any(n.outputs[0].default_value < 1e-3 for n in gates)


t0 = time.time()
for f in frames:
    path = os.path.join(out, f"{f:04d}.png")
    if os.environ.get("KC_SKIP_EXISTING") and os.path.exists(path) and os.path.getsize(path) > 10000:
        continue
    sc.frame_set(f)
    cull_transparent()
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
print("RENDERED", len(list(frames)), "in", round(time.time() - t0, 1), "s")
