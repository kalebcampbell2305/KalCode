"""KalCode launch film: 16 s visual proof (chaos -> introducing -> window forms -> terminal ->
KalVoice locate/focus/illuminate). Builds proof.blend; render with tools/render.py.

  blender -b --factory-startup -P blender/proof.py -- <out.blend>
"""
import math
import os
import random
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kc  # noqa: E402

A = kc.ASSETS
UI = os.path.join(A, "ui")
SEQ = os.path.join(A, "seq")
BR = os.path.join(kc.LAUNCH, "..", "assets", "branding")
R = math.radians
rng = random.Random(7)
CUES = {"pop": [], "flash": []}

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
sc = kc.new_scene("Scene", 960)
kc.compositor(sc)
cam, tgt, foc = kc.camera(loc=(0, 0, 5), fstop=1.6)
bd = kc.backdrop(z=0, size=110)
bd.parent = cam
bd.location = (0, 0, -70)


def cam_keys(pts, obj=cam):
    for f, loc, *e in pts:
        kc.key(obj, "location", f, loc, e[0] if e else "smooth")


# =========================================================== 1. CHAOS (f0-300)
FRAGS = [
    ("frag_gitlog", 1.0), ("frag_thread_claude", 0.85), ("frag_card_needs", 1.0), ("frag_site_home", 0.42),
    ("frag_tests", 1.0), ("frag_thread_list", 0.9), ("frag_accounts", 0.62), ("frag_card_updater", 1.0),
    ("frag_pill_listen", 1.0), ("frag_thread_codex", 0.85), ("frag_activity", 0.95), ("frag_site_download", 0.42),
    ("frag_card_browser", 1.0), ("frag_newthread", 0.6), ("frag_agents", 1.0), ("frag_gitlog", 0.9),
    ("frag_card_needs", 0.9), ("frag_tests", 0.9),
]


def cam_z(f):
    if f <= 250:
        t = f / 250
        return 5 - 25 * (t ** 1.55)
    t = min(1, (f - 250) / 42)
    return -20 - 2.5 * (1 - (1 - t) ** 3)


# camera path, baked every 10 frames as smooth Bezier keys (editable)
for f in list(range(0, 300, 10)) + [292, 299]:
    x = 0.18 * math.sin(f / 60)
    y = 0.10 * math.sin(f / 47 + 1)
    kc.key(cam, "location", f, (x, y, cam_z(f)))
    kc.key(tgt, "location", f, (x * 0.5, y * 0.5, cam_z(f) - 8))
    kc.key(foc, "location", f, (0, 0, cam_z(f) - 4.2))
kc.key(cam.data, "lens", 0, 38)
kc.key(cam.data, "lens", 250, 32, "cubic")
kc.key(cam.data, "lens", 292, 40)

P = (0, 0, -27.5)  # collapse point
NAMES = [n for n, _ in FRAGS]
frag_objs = []
N_FRAGS = 34
for i in range(N_FRAGS):
    name = NAMES[i % len(NAMES)]
    base_s = dict(FRAGS)[name]
    layer = ("near", "mid", "mid", "far")[i % 4]
    z = -0.5 - i * 0.78
    side = -1 if (i * 7) % 3 == 0 else 1
    if layer == "near":
        x, y, s = side * rng.uniform(0.55, 1.05), rng.uniform(-0.55, 0.55), base_s * 0.8
    elif layer == "mid":
        x, y, s = side * rng.uniform(0.35, 1.6), rng.uniform(-0.95, 0.95), base_s * 1.05
    else:
        x, y, s = side * rng.uniform(0.2, 2.2), rng.uniform(-1.3, 1.3), base_s * 1.5
        z -= 3.0
    root, ob, m, _ = kc.ui_card(f"chaos{i:02d}_{name}", os.path.join(UI, name + ".png"), (x, y, z), scale=s)
    sh = bpy.data.materials[root["shadow_mat"]]
    rz0 = R(rng.uniform(-9, 9))
    rot0 = (R(rng.uniform(-14, 14)), R(rng.uniform(-18, 18) - side * 10), rz0)
    root.rotation_euler = rot0
    pop = 2 + i * 3
    for f in range(0, 250):
        if cam_z(f) - z < 10.5:
            pop = max(pop, f)
            break
    pop = min(pop, 236)
    pop = int(round(pop / 7.5) * 7.5)  # 1/8 notes at 120 BPM
    CUES["pop"].append(pop)
    kc.sock_keys(m, "Opacity", [(pop, 0.0, "cubic_out"), (pop + 6, 1.0)])
    kc.sock_keys(sh, "Opacity", [(pop, 0.0, "cubic_out"), (pop + 10, 0.6)])
    kc.sock_keys(m, "Bright", [(pop, 2.1, "expo_out"), (pop + 12, 1.0)])
    kc.keys(root, "scale", [(pop, (0.84,) * 3, "back_out"), (pop + 15, (1.0,) * 3)])
    # windows never sit still: a slow drift plus a snap move on a beat
    vx = side * rng.uniform(0.15, 0.45)
    fb = pop + 22 + (i % 5) * 7
    dx, dy = side * rng.uniform(0.2, 0.55), rng.uniform(-0.2, 0.2)
    kc.keys(root, "location", [(pop, (x, y, z), "linear"), (fb, (x + vx * 0.3, y, z), "expo_out"),
                               (fb + 11, (x + vx * 0.3 + dx, y + dy, z), "linear"), (250, (x + vx + dx, y + dy, z))])
    final = (x + vx + dx, y + dy, z)
    kc.keys(root, "rotation_euler", [(pop, rot0, "linear"), (250, (rot0[0], rot0[1] + R(side * 5), rz0 + R(side * 7)))])
    if i % 3 == 1:  # a notification lands: a brief lift in brightness
        fl = fb + 30
        CUES["flash"].append(fl)
        kc.sock_keys(m, "Bright", [(fl, 1.0, "expo_out"), (fl + 3, 1.6, "cubic"), (fl + 14, 1.0)])
    frag_objs.append((root, m, z, final, sh))

# collapse: everything still ahead of the camera implodes to P
for root, m, z, final, sh in frag_objs:
    kc.sock_keys(sh, "Opacity", [(256, 0.6, "cubic"), (270, 0.0)])
    if z < cam_z(250) - 0.3:
        kc.key(root, "location", 250, final, "expo_in")
        kc.key(root, "location", 290, P)
        kc.key(root, "scale", 250, (1, 1, 1), "expo_in")
        kc.key(root, "scale", 290, (0.02, 0.02, 0.02))
        kc.key(root, "rotation_euler", 250, root.rotation_euler[:], "expo_in")
        kc.key(root, "rotation_euler", 290, (0, 0, 0))
        kc.sock_keys(m, "Opacity", [(282, 1.0, "cubic"), (291, 0.0)])
        kc.sock_keys(m, "Bright", [(262, 1.0, "expo_in"), (289, 3.2)])
    else:
        kc.sock_keys(m, "Opacity", [(262, 1.0, "cubic"), (276, 0.0)])

# convergence flash
flash_m = kc.glow_material("flash_m", 0.02, 0.02, 0.01, 0.5, color="#8fb6ff", strength=9, ring=False)
flash = kc.plane("flash", 1.04, 1.04, flash_m, P)
kc._pad_uv(flash, 0.02, 0.02, 0.51)
kc.sock_keys(flash_m, "Opacity", [(284, 0.0, "expo_in"), (291, 1.0, "expo_out"), (300, 0.0)])
kc.keys(flash, "scale", [(284, (0.2,) * 3, "expo_in"), (291, (1.6, 0.35, 1), "expo_out"), (300, (4.0, 0.02, 1))])

# =========================================================== 2. INTRODUCING (f300-560)
S = (0, 0, -80)


def at(x, y, z=0.0):
    return (S[0] + x, S[1] + y, S[2] + z)


# cut in black at f300: camera moves to the stage (constant keys)
kc.key(cam, "location", 300, at(0, 0, 5.2), "smooth")
kc.key(tgt, "location", 300, at(0, 0, 0), "smooth")
kc.key(foc, "location", 300, at(0, 0, 0), "smooth")
kc.key(cam.data, "lens", 300, 50, "smooth")
kc.key(cam.data.dof, "aperture_fstop", 0, 1.6, "const", owner=cam.data)
kc.key(cam.data.dof, "aperture_fstop", 300, 2.8, "const", owner=cam.data)
for fc in kc._fcurves(cam):
    for kp in fc.keyframe_points:
        if abs(kp.co.x - 299) < 0.01:
            kp.interpolation = "CONSTANT"
kc.key(cam, "location", 540, at(0, 0, 4.75), "cubic")

line_m = kc.flat_material("line_m", "#6aa0ff", strength=7.0)
line = kc.plane("intro_line", 2.8, 0.005, line_m, at(0, -0.03, 0))
kc.keys(line, "scale", [(328, (0.001, 1, 1), "expo_out"), (356, (1, 1, 1))])
kc.sock_keys(line_m, "Opacity", [(326, 0.0, "cubic"), (330, 1.0), (370, 1.0, "cubic"), (392, 0.0)])
kc.keys(line, "location", [(356, at(0, -0.03, 0), "expo"), (392, at(0, -0.5, 0))])

now, now_m = kc.text("now_introducing", "NOW INTRODUCING", "lexend-exa-300", 0.072, at(0, 0.66, 0.02), tracking=1.75, color="#a8b4c9")
kc.sock_keys(now_m, "Wipe", [(344, 0.0, "cubic_out"), (388, 1.0)])
kc.sock_keys(now_m, "Opacity", [(470, 1.0, "cubic"), (490, 0.0)])
kc.keys(now, "location", [(344, at(0, 0.64, 0.02), "linear"), (490, at(0, 0.685, 0.02))])

sym, sym_m = kc.image_plane("intro_symbol", os.path.join(BR, "kalcode-icon-1024.png"), 0.64, at(0, 0.2, 0.01), strength=1.15)
kc.sock_keys(sym_m, "Opacity", [(360, 0.0, "cubic_out"), (378, 1.0)])
kc.keys(sym, "scale", [(360, (0.78,) * 3, "back_out"), (398, (1,) * 3)])
kc.sock_keys(sym_m, "Strength", [(360, 2.4, "expo_out"), (400, 1.15)])

wm, wm_m = kc.image_plane("intro_wordmark", os.path.join(BR, "kalcode-wordmark.png"), 1.3, at(0, -0.24, 0.0), strength=1.0)
kc.sock_keys(wm_m, "Wipe", [(372, 0.0, "cubic"), (408, 1.0)])
kc.sock_keys(wm_m, "Edge", [(372, 1.0, "linear"), (404, 1.0, "cubic"), (416, 0.0)])

tag, tag_m = kc.text("tagline", "An all-in-one AI software engineering workspace.", "lexend-deca-300", 0.062, at(0, -0.56, 0.0), color="#a8b4c9")
kc.sock_keys(tag_m, "Wipe", [(424, 0.0, "cubic_out"), (466, 1.0)])
kc.sock_keys(tag_m, "Opacity", [(500, 1.0, "cubic"), (520, 0.0)])

# =========================================================== 3. WINDOW FORMS (f540-690)
WIN = kc.empty("WIN", at(0, 0, 0))
PLATE = (3200, 1920)


def piece(name, img, final_xy, start_loc, start_rot, f0, f1, z=0.0):
    root, ob, m, _ = kc.ui_card(name, os.path.join(UI, img + ".png"), (final_xy[0], final_xy[1], z), parent=WIN, radius=0.0, border=0.0, shadow=False)
    kc.keys(root, "location", [(f0, start_loc, "expo_out"), (f1, (final_xy[0], final_xy[1], z))])
    kc.keys(root, "rotation_euler", [(f0, start_rot, "expo_out"), (f1, (0, 0, 0))])
    kc.sock_keys(m, "Opacity", [(f0, 0.0, "cubic_out"), (f0 + 14, 1.0)])
    return root, m


SIDE_XY, HEAD_XY, MAIN_XY = (-1.36, 0.0), (0.24, 0.908), (0.24, -0.052)
code_main = piece("code_main", "code_main", MAIN_XY, (0.9, -0.5, -2.8), (R(18), R(-26), R(6)), 548, 616)
code_side = piece("code_sidebar", "code_sidebar", SIDE_XY, (-2.6, 0.3, -1.4), (0, R(40), R(-4)), 560, 622)
code_head = piece("code_header", "code_header", HEAD_XY, (0.5, 1.6, -1.2), (R(-30), 0, 0), 572, 628)

# window frame: soft shadow + hairline edge
frame_sh = kc.shadow_material("win_shadow_m", 3.2, 1.92, 0.012, 0.55, 0.75)
fs = kc.plane("win_shadow", 3.2 + 1.1, 1.92 + 1.1, frame_sh, (0, -0.06, -0.05), WIN)
kc._pad_uv(fs, 3.2, 1.92, 0.55)
kc.sock_keys(frame_sh, "Opacity", [(596, 0.0, "cubic"), (640, 0.75)])
edge_m = kc.glow_material("win_edge_m", 3.2, 1.92, 0.012, 0.006, color="#8eaadc", strength=0.9)
fe = kc.plane("win_edge", 3.2 + 0.012, 1.92 + 0.012, edge_m, (0, 0, -0.004), WIN)
kc._pad_uv(fe, 3.2, 1.92, 0.006)
kc.sock_keys(edge_m, "Opacity", [(610, 0.0, "cubic"), (640, 0.55)])

# wordmark + symbol fly into the sidebar logo, then hand over to the plate's own logo
kc.keys(wm, "location", [(548, at(0, -0.24, 0.0), "expo"), (616, at(-1.406, 0.898, 0.012))])
kc.keys(wm, "scale", [(548, (1,) * 3, "expo"), (616, (0.157,) * 3)])
kc.sock_keys(wm_m, "Opacity", [(612, 1.0, "cubic"), (626, 0.0)])
kc.keys(sym, "location", [(548, at(0, 0.2, 0.01), "expo"), (616, at(-1.548, 0.898, 0.014))])
kc.keys(sym, "scale", [(548, (1,) * 3, "expo"), (616, (0.075,) * 3)])
kc.sock_keys(sym_m, "Opacity", [(612, 1.0, "cubic"), (626, 0.0)])

cam_keys([(540, at(0, 0, 4.75), "cubic"), (604, at(-0.25, 0.05, 5.9), "cubic"), (686, at(-1.55, -0.4, 5.0))])
kc.keys(tgt, "location", [(540, at(0, 0, 0), "cubic"), (604, at(-0.1, 0.05, 0)), (686, at(0.25, -0.02, 0))])
kc.keys(foc, "location", [(540, at(0, 0, 0)), (686, at(0.1, 0, 0))])

# =========================================================== 4. TERMINAL (f690-810)
term, term_m = kc.overlay("term_seq", os.path.join(SEQ, "term", "0000.png"), WIN, PLATE, (506, 270, 3182, 1846), z=0.003,
                          seq={"start": 694, "length": 117, "offset": -1})
kc.sock_keys(term_m, "Opacity", [(690, 0.0, "cubic"), (694, 1.0)])
cam_keys([(686, at(-1.55, -0.4, 5.0), "expo"), (760, at(-1.05, 0.12, 2.55), "cubic"), (806, at(-0.95, 0.1, 2.4))])
kc.keys(tgt, "location", [(686, at(0.25, -0.02, 0), "expo"), (760, at(-0.3, 0.3, 0), "cubic"), (806, at(-0.28, 0.24, 0))])
kc.keys(foc, "location", [(686, at(0.1, 0, 0), "expo"), (760, at(-0.4, 0.34, 0))])
kc.key(cam.data.dof, "aperture_fstop", 686, 2.8, "expo", owner=cam.data)
kc.key(cam.data.dof, "aperture_fstop", 770, 1.8, owner=cam.data)

# =========================================================== 5. THREADS + KALVOICE (f800-960)
th_side = kc.overlay("thA_sidebar", os.path.join(UI, "thA_sidebar.png"), WIN, PLATE, (0, 0, 480, 1920), z=0.005)
th_head = kc.overlay("thA_header", os.path.join(UI, "thA_header.png"), WIN, PLATE, (480, 0, 3200, 104), z=0.005)
th_main = kc.overlay("thA_main", os.path.join(UI, "thA_main.png"), WIN, PLATE, (480, 104, 3200, 1920), z=0.005)
for ob, m in (th_side, th_head):
    kc.sock_keys(m, "Opacity", [(804, 0.0, "cubic"), (816, 1.0)])
kc.sock_keys(th_main[1], "Opacity", [(800, 0.0, "cubic_out"), (814, 1.0)])
y0 = th_main[0].location.y
kc.keys(th_main[0], "location", [(800, (th_main[0].location.x, y0 - 0.09, 0.005), "expo_out"), (826, (th_main[0].location.x, y0, 0.005))])
for m in (code_main[1], code_side[1], code_head[1], term_m):
    kc.sock_keys(m, "Opacity", [(814, 1.0, "cubic"), (826, 0.0)])

# camera: frame the KalVoice pill and the thread list
cam_keys([(806, at(-0.95, 0.1, 2.4), "expo"), (852, at(-0.62, 0.05, 3.05), "cubic"), (916, at(-0.7, 0.18, 2.85))])
kc.keys(tgt, "location", [(806, at(-0.28, 0.24, 0), "expo"), (852, at(-0.18, 0.5, 0), "cubic"), (916, at(-0.25, 0.5, 0))])
kc.keys(foc, "location", [(806, at(-0.4, 0.34, 0), "expo"), (852, at(0.0, 0.6, 0))])

PILL_RECT = (1380, 0, 2300, 260)
pill_l, pill_lm = kc.overlay("pill_listen", os.path.join(SEQ, "pill_listen", "0000.png"), WIN, PLATE, PILL_RECT, z=0.008,
                             seq={"start": 848, "length": 64, "offset": -1})
kc.sock_keys(pill_lm, "Opacity", [(846, 0.0, "cubic"), (849, 1.0), (910, 1.0, "cubic"), (913, 0.0)])
# KalVoice energy around the pill while listening
PILL = kc.plate_xy(PLATE, 1840, 132)
pg_m = kc.glow_material("pill_glow_m", 0.896, 0.232, 0.018, 0.05, color="#4c8dff", strength=3.0)
pg = kc.plane("pill_glow", 0.896 + 0.1, 0.232 + 0.1, pg_m, (PILL[0], PILL[1], 0.007), WIN)
kc._pad_uv(pg, 0.896, 0.232, 0.05)
kc.sock_keys(pg_m, "Opacity", [(846, 0.0, "expo_out"), (856, 1.0), (906, 1.0, "cubic"), (918, 0.0)])
kc.sock_keys(pg_m, "Strength", [(856 + 16 * k, 2.2 if k % 2 else 3.6, "sine") for k in range(4)] + [(918, 2.0)])

# intent, large: the words appear as they are heard
said, said_m = kc.text("said_focus", "“Focus the Browser redesign thread.”", "lexend-deca-400", 0.058,
                       (PILL[0] - 0.3, PILL[1] - 0.3, 0.42), parent=WIN, color="#e6edf8")
kc.sock_keys(said_m, "Wipe", [(852, 0.0, "linear"), (900, 1.0)])
kc.sock_keys(said_m, "Opacity", [(906, 1.0, "cubic"), (920, 0.0)])
said_bg = kc.shadow_material("said_bg_m", 1.25, 0.1, 0.05, 0.16, 0.92)
sb = kc.plane("said_bg", 1.57, 0.42, said_bg, (PILL[0] - 0.3, PILL[1] - 0.3, 0.41), WIN)
kc._pad_uv(sb, 1.25, 0.1, 0.16)
kc.sock_keys(said_bg, "Opacity", [(850, 0.0, "cubic"), (862, 0.92), (906, 0.92, "cubic"), (920, 0.0)])

# LOCATE: a routing beam from KalVoice to the target thread
ROW = kc.plate_xy(PLATE, 849, 640)
sx, sy = PILL[0], PILL[1] - 0.12
dx, dy = ROW[0] + 0.3 - sx, ROW[1] + 0.09 - sy
L = math.hypot(dx, dy)
beam_m = kc.text_material("beam_m", "#7fb0ff", strength=6.0)
beam = kc.plane("route_beam", L, 0.006, beam_m, (sx + dx / 2, sy + dy / 2, 0.012), WIN)
beam.rotation_euler = (0, 0, math.atan2(dy, dx) + math.pi)
nt = beam_m.node_tree.nodes
nt["XMin"].outputs[0].default_value = -L / 2
nt["XMax"].outputs[0].default_value = L / 2
nt["Feather"].outputs[0].default_value = 0.08
kc.sock_keys(beam_m, "Wipe", [(906, 0.0, "expo_out"), (918, 1.0)])
kc.sock_keys(beam_m, "Opacity", [(905, 0.0), (906, 1.0), (920, 1.0, "cubic"), (934, 0.0)])

# FOCUS: the thread becomes the target (real selection state from the capture)
thB = kc.overlay("thB_main", os.path.join(UI, "thB_main.png"), WIN, PLATE, (480, 104, 3200, 1920), z=0.006)
kc.sock_keys(thB[1], "Opacity", [(914, 0.0, "cubic"), (922, 1.0)])
pr = kc.overlay("pill_ready", os.path.join(UI, "pill_ready_region.png"), WIN, PLATE, PILL_RECT, z=0.0085)
kc.sock_keys(pr[1], "Opacity", [(909, 0.0, "cubic"), (913, 1.0)])
RW, RH = 0.602, 0.168
rg_m = kc.glow_material("row_glow_m", RW, RH, 0.012, 0.06, color="#4c8dff", strength=6.0)
rg = kc.plane("row_glow", RW + 0.12, RH + 0.12, rg_m, (ROW[0], ROW[1], 0.01), WIN)
kc._pad_uv(rg, RW, RH, 0.06)
kc.sock_keys(rg_m, "Opacity", [(916, 0.0, "expo_out"), (922, 1.0)])
kc.sock_keys(rg_m, "Strength", [(916, 5.0, "expo_out"), (944, 2.2)])

# ILLUMINATE: push in on the target
cam_keys([(916, at(-0.7, 0.18, 2.85), "expo_out"), (959, at(-1.0, 0.26, 2.5))])
kc.keys(tgt, "location", [(916, at(-0.25, 0.5, 0), "expo_out"), (959, at(-0.5, 0.36, 0))])
kc.keys(foc, "location", [(852, at(0.0, 0.6, 0), "expo_out"), (930, at(ROW[0], ROW[1], 0))])

out = sys.argv[-1] if sys.argv[-1].endswith(".blend") else os.path.join(kc.LAUNCH, "blender", "proof.blend")
import json
json.dump(CUES, open(os.path.join(kc.LAUNCH, "audio", "proof_cues.json"), "w"))
kc.save(out)
print("PROOF_BUILT", out)
