import bpy, sys
from bpy_extras.object_utils import world_to_camera_view
f = int(sys.argv[-1]); sc = bpy.context.scene; sc.frame_set(f)
cam = sc.camera
for ob in bpy.data.objects:
    if ob.type not in ("MESH", "FONT") or not ob.data.materials: continue
    m = ob.data.materials[0]
    n = m.node_tree.nodes.get("Opacity") if m and m.node_tree else None
    v = n.outputs[0].default_value if n else 1.0
    if v <= 0.01: continue
    co = world_to_camera_view(sc, cam, ob.matrix_world.translation)
    if -0.5 < co.x < 1.5 and -0.5 < co.y < 1.5 and co.z > 0:
        print("VIS", ob.name, round(v, 3), round(co.x, 2), round(co.y, 2), round(co.z, 2))
