import sys, os, bpy
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(bpy.data.filepath or __file__)), "..", "blender"))
import kc
for o in list(bpy.data.objects): bpy.data.objects.remove(o)
sc = kc.new_scene("Scene", 10)
kc.backdrop()
cam, tgt, foc = kc.camera(loc=(0.3, -0.2, 4.2), fstop=2.0)
root, ob, m, g = kc.ui_card("thread", os.path.join(kc.ASSETS, "ui", "frag_card_browser.png"), (-0.6, 0, 0), glow="#4c8dff")
g.node_tree.nodes["Opacity"].outputs[0].default_value = 1.0
kc.ui_card("dl", os.path.join(kc.ASSETS, "ui", "frag_site_home.png"), (1.3, 0.2, -1.5), scale=0.5)
t, tm = kc.text("title", "NOW INTRODUCING", "lexend-exa-300", 0.09, (0, -0.75, 0.2), tracking=1.4)
kc.compositor(sc)
sc.render.filepath = sys.argv[-1]
bpy.ops.render.render(write_still=True)
print("SMOKE_OK")
