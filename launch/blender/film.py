"""KalCode launch film, 60 s master (3600 frames @ 60 fps). Builds film.blend.

  blender -b --factory-startup -P blender/film.py [-- <out.blend>]

Acts: 1 chaos -> introducing -> window forms | 2 one workspace | 3 multi-agent | 4 KalVoice |
5 build loop | 6 cockpit | 7 built in KalCode | 8 end card.
Every UI surface is a real KalCode 0.1.7 Stable capture (see PRODUCTION.md).
"""
import json
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
PL = kc.PLATES
BR = os.path.join(kc.LAUNCH, "..", "assets", "branding")  # KALCODE wordmark lettering
BRAND = os.path.join(A, "brand")  # mascot logo (the terminal-globe symbol is retired)
R = math.radians
rng = random.Random(7)
CUES = {}


def cue(name, f):
    CUES.setdefault(name, []).append(f)


for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
TOTAL = 3600
sc = kc.new_scene("Scene", TOTAL)
kc.compositor(sc, vignette=0.22)
cam, tgt, foc = kc.camera(loc=(0, 0, 5), fstop=1.6)
bd = kc.backdrop(z=0, size=110)
bd.parent = cam
bd.location = (0, 0, -70)
PLATE = (3200, 1920)


def CK(f, loc, t, fo=None, ease="smooth"):
    """Camera pose key: position, look-at target, focus point."""
    kc.key(cam, "location", f, loc, ease)
    kc.key(tgt, "location", f, t, ease)
    kc.key(foc, "location", f, fo if fo is not None else t, ease)


def CUT(f, loc, t, fo=None):
    """Hard cut at frame f: hold the previous pose until f-1, jump at f."""
    for ob in (cam, tgt, foc):
        ob.keyframe_insert("location", frame=f - 1)
        for fc in kc._fcurves(ob):
            if fc.data_path == "location":
                for kp in fc.keyframe_points:
                    if abs(kp.co.x - (f - 1)) < 0.01:
                        kp.interpolation = "CONSTANT"
    CK(f, loc, t, fo)


def tour(poses, whip=14, push=0.06):
    """poses: [(f, cam, tgt, focus)]. Arrive at each pose, drift slowly in, then whip to the next."""
    for k, (f, c, t, fo) in enumerate(poses):
        CK(f, c, t, fo, ease="linear")
        if k + 1 < len(poses):
            nf = poses[k + 1][0]
            c2 = tuple(ci + (ti - ci) * push for ci, ti in zip(c, t))
            CK(nf - whip, c2, t, fo, ease="expo")


def fstop(f, v, ease="smooth"):
    kc.key(cam.data.dof, "aperture_fstop", f, v, ease, owner=cam.data)


def lens(f, v, ease="smooth"):
    kc.key(cam.data, "lens", f, v, ease)


def title(name, body, pos, size, f_in, f_out, font="lexend-deca-500", color="#e6edf8", tracking=1.0,
          parent=None, backing=False, align="CENTER", dur_in=34, strength=1.0):
    ob, m = kc.text(name, body, font, size, pos, color=color, tracking=tracking, parent=parent, align=align,
                    strength=strength)
    kc.sock_keys(m, "Wipe", [(f_in, 0.0, "cubic_out"), (f_in + dur_in, 1.0)])
    kc.sock_keys(m, "Opacity", [(f_out, 1.0, "cubic"), (f_out + 14, 0.0)])
    x, y, z = pos
    kc.keys(ob, "location", [(f_in, (x, y - 0.012, z), "cubic_out"), (f_out + 14, (x, y + 0.02, z))])
    if backing:
        bpy.context.view_layer.update()
        w = ob.dimensions.x + size * 1.4
        h = size * 1.9
        bm = kc.shadow_material(name + "_bg", w, h, h * 0.4, size * 2.2, 0.9)
        b = kc.plane(name + "_back", w + size * 4.4, h + size * 4.4, bm, (x, y, z - 0.01), parent)
        kc._pad_uv(b, w, h, size * 2.2)
        kc.sock_keys(bm, "Opacity", [(f_in - 4, 0.0, "cubic"), (f_in + 10, 0.9), (f_out, 0.9, "cubic"), (f_out + 14, 0.0)])
    cue("title", f_in)
    return ob, m


# =========================================================== ACT 1a  CHAOS (0-291)
FRAGS = [
    ("frag_gitlog", 1.0), ("frag_thread_claude", 0.85), ("frag_card_needs", 1.0), ("frag_site_home", 0.42),
    ("frag_tests", 1.0), ("frag_thread_list", 0.9), ("frag_accounts", 0.62), ("frag_card_updater", 1.0),
    ("frag_pill_listen", 1.0), ("frag_thread_codex", 0.85), ("frag_activity", 0.95), ("frag_site_download", 0.42),
    ("frag_card_browser", 1.0), ("frag_newthread", 0.6), ("frag_agents", 1.0), ("frag_gitlog", 0.9),
    ("frag_card_needs", 0.9), ("frag_tests", 0.9),
]


def cam_z(f):
    if f <= 250:
        return 5 - 25 * ((f / 250) ** 1.45)
    t = min(1, (f - 250) / 42)
    return -20 - 2.5 * (1 - (1 - t) ** 3)


for f in list(range(0, 292, 10)) + [291]:
    x = 0.18 * math.sin(f / 60)
    y = 0.10 * math.sin(f / 47 + 1)
    CK(f, (x, y, cam_z(f)), (x * 0.5, y * 0.5, cam_z(f) - 8), (0, 0, cam_z(f) - 4.2))
lens(0, 38)
lens(250, 32, "cubic")
lens(291, 40)
fstop(0, 1.6, "const")

P = (0, 0, -27.5)
NAMES = [n for n, _ in FRAGS]
frags = []
for i in range(34):
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
    pop = 0 if i < 4 else 2 + i * 3
    if i >= 4:
        for f in range(0, 250):
            if cam_z(f) - z < 10.5:
                pop = max(pop, f)
                break
    pop = int(round(min(pop, 236) / 7.5) * 7.5)
    cue("pop", pop)
    fin = 10 if pop == 0 else 6
    kc.sock_keys(m, "Opacity", [(pop, 0.0, "cubic_out"), (pop + fin, 1.0)])
    kc.sock_keys(sh, "Opacity", [(pop, 0.0, "cubic_out"), (pop + 10, 0.6)])
    kc.sock_keys(m, "Bright", [(pop, 2.1, "expo_out"), (pop + 12, 1.0)])
    kc.keys(root, "scale", [(pop, (0.84,) * 3, "back_out"), (pop + 15, (1.0,) * 3)])
    vx = side * rng.uniform(0.15, 0.45)
    fb = pop + 22 + (i % 5) * 7
    dx, dy = side * rng.uniform(0.2, 0.55), rng.uniform(-0.2, 0.2)
    kc.keys(root, "location", [(pop, (x, y, z), "linear"), (fb, (x + vx * 0.3, y, z), "expo_out"),
                               (fb + 11, (x + vx * 0.3 + dx, y + dy, z), "linear"), (250, (x + vx + dx, y + dy, z))])
    cue("snap", fb)
    final = (x + vx + dx, y + dy, z)
    kc.keys(root, "rotation_euler", [(pop, rot0, "linear"), (250, (rot0[0], rot0[1] + R(side * 5), rz0 + R(side * 7)))])
    if i % 3 == 1:
        fl = fb + 30
        cue("flash", fl)
        kc.sock_keys(m, "Bright", [(fl, 1.0, "expo_out"), (fl + 3, 1.6, "cubic"), (fl + 14, 1.0)])
    frags.append((root, m, z, final, sh))

for root, m, z, final, sh in frags:
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

flash_m = kc.glow_material("flash_m", 0.02, 0.02, 0.01, 0.5, color="#8fb6ff", strength=9, ring=False)
flash = kc.plane("flash", 1.04, 1.04, flash_m, P)
kc._pad_uv(flash, 0.02, 0.02, 0.51)
kc.sock_keys(flash_m, "Opacity", [(284, 0.0, "expo_in"), (291, 1.0, "expo_out"), (300, 0.0)])
kc.keys(flash, "scale", [(284, (0.2,) * 3, "expo_in"), (291, (1.6, 0.35, 1), "expo_out"), (300, (4.0, 0.02, 1))])
cue("impact", 291)

# =========================================================== ACT 1b  INTRODUCING (318-480)
S = (0, 0, -80)


def at(x, y, z=0.0):
    return (S[0] + x, S[1] + y, S[2] + z)


CUT(300, at(0, 0, 5.2), at(0, 0, 0))
fstop(300, 2.8, "const")
lens(300, 50, "smooth")
CK(480, at(0, 0, 4.8), at(0, 0, 0), ease="cubic")

line_m = kc.flat_material("line_m", "#6aa0ff", strength=7.0)
line = kc.plane("intro_line", 2.8, 0.005, line_m, at(0, -0.03, 0))
kc.keys(line, "scale", [(318, (0.001, 1, 1), "expo_out"), (344, (1, 1, 1))])
kc.sock_keys(line_m, "Opacity", [(316, 0.0, "cubic"), (320, 1.0), (356, 1.0, "cubic"), (378, 0.0)])
kc.keys(line, "location", [(344, at(0, -0.03, 0), "expo"), (378, at(0, -0.5, 0))])
cue("line", 318)

now, now_m = kc.text("now_introducing", "NOW INTRODUCING", "lexend-exa-300", 0.072, at(0, 0.66, 0.02), tracking=1.75, color="#a8b4c9")
kc.sock_keys(now_m, "Wipe", [(328, 0.0, "cubic_out"), (366, 1.0)])
kc.sock_keys(now_m, "Opacity", [(452, 1.0, "cubic"), (470, 0.0)])
kc.keys(now, "location", [(328, at(0, 0.64, 0.02), "linear"), (470, at(0, 0.685, 0.02))])

# the app-icon tile: the same mark the sidebar shows, so the hand-off at 548 lands on it
sym, sym_m = kc.image_plane("intro_symbol", os.path.join(BRAND, "kalcode-icon-1024.png"), 0.64, at(0, 0.2, 0.01), strength=1.15)
kc.sock_keys(sym_m, "Opacity", [(344, 0.0, "cubic_out"), (362, 1.0)])
kc.keys(sym, "scale", [(344, (0.78,) * 3, "back_out"), (382, (1,) * 3)])
kc.sock_keys(sym_m, "Strength", [(344, 2.4, "expo_out"), (384, 1.15)])
cue("symbol", 344)

wm, wm_m = kc.image_plane("intro_wordmark", os.path.join(BR, "kalcode-wordmark.png"), 1.3, at(0, -0.24, 0.0), strength=1.0)
kc.sock_keys(wm_m, "Wipe", [(356, 0.0, "cubic"), (390, 1.0)])
kc.sock_keys(wm_m, "Edge", [(356, 1.0, "linear"), (386, 1.0, "cubic"), (398, 0.0)])
cue("wordmark", 356)

tag, tag_m = kc.text("tagline", "An all-in-one AI software engineering workspace.", "lexend-deca-300", 0.062, at(0, -0.56, 0.0), color="#a8b4c9")
kc.sock_keys(tag_m, "Wipe", [(398, 0.0, "cubic_out"), (436, 1.0)])
kc.sock_keys(tag_m, "Opacity", [(466, 1.0, "cubic"), (482, 0.0)])

# =========================================================== ACT 1c  WINDOW FORMS (480-660)
WIN = kc.empty("WIN", at(0, 0, 0))
Z = {"z": 0.0}


def state_z():
    Z["z"] += 0.0006
    return Z["z"]


def piece(name, img, final_xy, start_loc, start_rot, f0, f1):
    root, ob, m, _ = kc.ui_card(name, os.path.join(UI, img + ".png"), (final_xy[0], final_xy[1], 0.0), parent=WIN,
                                radius=0.0, border=0.0, shadow=False)
    kc.keys(root, "location", [(f0, start_loc, "expo_out"), (f1, (final_xy[0], final_xy[1], 0.0))])
    kc.keys(root, "rotation_euler", [(f0, start_rot, "expo_out"), (f1, (0, 0, 0))])
    kc.sock_keys(m, "Opacity", [(f0, 0.0, "cubic_out"), (f0 + 14, 1.0)])
    cue("whoosh", f0)
    cue("land", f1 - 6)
    return root, m


SIDE_XY, HEAD_XY, MAIN_XY = (-1.36, 0.0), (0.24, 0.908), (0.24, -0.052)
p_main = piece("code_main", "code_main", MAIN_XY, (0.9, -0.5, -2.8), (R(18), R(-26), R(6)), 484, 548)
p_side = piece("code_sidebar", "code_sidebar", SIDE_XY, (-2.6, 0.3, -1.4), (0, R(40), R(-4)), 494, 554)
p_head = piece("code_header", "code_header", HEAD_XY, (0.5, 1.6, -1.2), (R(-30), 0, 0), 504, 560)

frame_sh = kc.shadow_material("win_shadow_m", 3.2, 1.92, 0.012, 0.55, 0.75)
fs = kc.plane("win_shadow", 4.3, 3.02, frame_sh, (0, -0.06, -0.05), WIN)
kc._pad_uv(fs, 3.2, 1.92, 0.55)
kc.sock_keys(frame_sh, "Opacity", [(530, 0.0, "cubic"), (570, 0.75)])
edge_m = kc.glow_material("win_edge_m", 3.2, 1.92, 0.012, 0.006, color="#8eaadc", strength=0.9)
fe = kc.plane("win_edge", 3.212, 1.932, edge_m, (0, 0, -0.004), WIN)
kc._pad_uv(fe, 3.2, 1.92, 0.006)
kc.sock_keys(edge_m, "Opacity", [(540, 0.0, "cubic"), (570, 0.55)])
# rim light: the window gives off a faint electric-blue presence
rim_m = kc.glow_material("win_rim_m", 3.2, 1.92, 0.012, 0.55, color="#2a64e6", strength=1.2)
rim = kc.plane("win_rim", 4.3, 3.02, rim_m, (0, 0, -0.06), WIN)
kc._pad_uv(rim, 3.2, 1.92, 0.55)
kc.sock_keys(rim_m, "Opacity", [(548, 0.0, "expo_out"), (566, 0.6), (620, 0.22)])


# lands exactly on the plate's sidebar KALCODE lettering (fit to its letter edges in code.png: plate px
# 97-292 x 56-73 -> scale 0.1534 at (-1.4049, 0.8959)), pulled toward the frame-548 camera so the
# 0.012 lift above the plate doesn't parallax-double the letters
kc.keys(wm, "location", [(482, at(0, -0.24, 0.0), "expo"), (548, at(-1.4022, 0.894, 0.012))])
kc.keys(wm, "scale", [(482, (1,) * 3, "expo"), (548, (0.1531,) * 3)])
kc.sock_keys(wm_m, "Opacity", [(544, 1.0, "cubic"), (558, 0.0)])
kc.keys(sym, "location", [(482, at(0, 0.2, 0.01), "expo"), (548, at(-1.5446, 0.8952, 0.014))])
# tile spans 824/1024 of the plane; the sidebar mark is 50 plate px = 0.050 BU, so 0.050/(0.64*824/1024),
# then parallax-corrected toward the frame-548 camera like the wordmark
kc.keys(sym, "scale", [(482, (1,) * 3, "expo"), (548, (0.0969,) * 3)])
kc.sock_keys(sym_m, "Opacity", [(544, 1.0, "cubic"), (558, 0.0)])

# hero: close 3/4 on the assembled window
CK(484, at(0, 0, 4.8), at(0, 0, 0), ease="cubic")
CK(540, at(-0.2, 0.05, 5.4), at(-0.05, 0.03, 0), ease="cubic")
CK(610, at(-2.0, -0.3, 5.0), at(0.15, 0.0, 0), at(0.0, 0.0, 0))
CK(662, at(-1.8, -0.25, 4.6), at(0.12, 0.02, 0), at(0.0, 0.0, 0))
fstop(540, 2.8)
fstop(610, 2.2)


# =========================================================== window states (acts 2-7)
def css(x, y):
    return kc.plate_xy(PLATE, x * 2, y * 2)


STACK = []  # [material, is_full, retired]


def retire_below(f, full):
    """A new full-window state hides every earlier state; a region state hides earlier regions."""
    for e in STACK:
        if not e[2] and (full or not e[1]):
            kc.sock_keys(e[0], "Opacity", [(f, 1.0, "const"), (f + 1, 0.0, "const")])
            e[2] = True


def state(name, path, f_in, fade=8, rect=None, seq=None, slide=0.0, f_out=None):
    """A full-window (or region) UI state on WIN, faded in at f_in (optional slide-up)."""
    retire_below(f_in + 1, rect is None)
    r = rect or (0, 0, 3200, 1920)
    z = state_z()
    ob, m = kc.overlay(name, path, WIN, PLATE, r, z=z, seq=seq)
    kc.sock_keys(m, "Opacity", [(f_in - fade, 0.0, "cubic_out"), (f_in, 1.0)] +
                 ([(f_out, 1.0, "cubic"), (f_out + fade, 0.0)] if f_out else []))
    if slide:
        x0, y0 = ob.location.x, ob.location.y
        kc.keys(ob, "location", [(f_in - fade, (x0, y0 - slide, z), "expo_out"), (f_in + 12, (x0, y0, z))])
    cue("state", f_in - fade)
    STACK.append([m, rect is None, f_out is not None])
    return ob, m


MAIN_R = (480, 104, 3200, 1920)
for _pm in (p_main[1], p_side[1], p_head[1]):
    STACK.append([_pm, True, False])
TERM_R = (506, 270, 3182, 1846)

# =========================================================== ACT 2  ONE WORKSPACE (660-1140)
state("term_seq", os.path.join(SEQ, "term", "0000.png"), 664, 4, TERM_R, seq={"start": 664, "length": 117, "offset": -1})
for c in range(9):
    cue("key", 676 + 3 * c)
cue("enter", 703)
for c in range(4):
    cue("pass", 703 + 3 * (4 + c * 2))
cue("allpass", 703 + 48)
CK(700, at(-1.1, 0.12, 2.6), at(-0.3, 0.3, 0), at(-0.4, 0.34, 0), ease="cubic")
CK(772, at(-0.95, 0.1, 2.35), at(-0.28, 0.24, 0), at(-0.4, 0.34, 0))
fstop(700, 8.0)

# terminal pane -> Browser pane joins beside it (real split canvas)
cb = state("cb_full", os.path.join(PL, "code_browser_site.png"), 792, 10)
cue("pane", 784)
CK(800, at(0.1, 0.0, 3.3), at(0.55, 0.0, 0), at(0.9, 0.0, 0), ease="expo_out")
CK(880, at(0.55, -0.05, 2.7), at(0.95, 0.0, 0), at(0.95, 0.0, 0))

# -> Threads: Claude Code and Codex in one list
thA = state("thA_full", os.path.join(PL, "v_focus", "before.png"), 900, 10, slide=0.06)
CK(890, at(0.2, 0.0, 3.2), at(-0.3, 0.2, 0), at(-0.75, 0.2, 0), ease="expo_out")
CK(1000, at(-0.65, 0.15, 2.55), at(-0.8, 0.12, 0), at(-0.8, 0.1, 0))
title("t_claude_codex", "Claude Code + Codex.", at(-0.05, -0.62, 0.55), 0.13, 918, 990, "lexend-deca-600", backing=True)

# -> Providers > Accounts: two accounts each, isolated
acc = state("acc_full", os.path.join(PL, "accounts_scrolled.png"), 1012, 10, slide=0.06)
CK(1004, at(-0.4, 0.3, 3.4), at(0.25, 0.1, 0), at(0.2, 0.1, 0), ease="expo_out")
CK(1136, at(0.55, 0.15, 3.0), at(0.4, 0.05, 0), at(0.35, 0.05, 0))
title("t_accounts", "Multiple accounts.", at(0.3, 0.22, 0.6), 0.12, 1030, 1122, "lexend-deca-600", backing=True)
title("t_one_ws", "One workspace.", at(0.3, 0.02, 0.6), 0.12, 1052, 1122, "lexend-deca-300", color="#a8b4c9", backing=False)

# =========================================================== ACT 3  MULTI-AGENT (1140-1620)
dash = state("dash_full", os.path.join(PL, "dashlive2", "000.png"), 1146, 10, slide=0.06)
CK(1140, at(-0.2, 0.2, 3.4), at(-0.1, 0.25, 0), at(-0.4, 0.3, 0), ease="expo_out")
CK(1190, at(-0.4, 0.1, 3.0), at(-0.25, 0.1, 0), at(-0.3, 0.1, 0), ease="cubic")
CARDS = [("card_browser", (911, 587, 1218, 812), "#35c48d"), ("card_updater", (591, 587, 898, 812), "#35c48d"),
         ("card_waveform", (272, 587, 579, 812), "#35c48d"), ("card_download", (272, 301, 579, 551), "#f2b544")]
row_x = [-1.05, -0.35, 0.35, 1.05]
cards = []
for k, (name, rect, col) in enumerate(CARDS):
    x0, y0 = css((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2)
    root, ob, m, gm = kc.ui_card("pop_" + name, os.path.join(UI, name + ".png"), (x0, y0, 0.02), parent=WIN, glow=col)
    sh = bpy.data.materials[root["shadow_mat"]]
    f0 = 1196 + k * 7
    tx, ty, tz = row_x[k], 0.12 - (0.05 if k % 2 else 0.0), 1.05
    kc.keys(root, "location", [(f0, (x0, y0, 0.02), "expo_out"), (f0 + 34, (tx, ty, tz), "sine"),
                               (1400, (tx, ty + 0.03, tz), "expo_in"), (1436, (x0, y0, 0.02))])
    kc.keys(root, "rotation_euler", [(f0, (0, 0, 0), "expo_out"), (f0 + 34, (0, R(-12 + k * 8), 0), "sine"),
                                     (1400, (0, R(-10 + k * 7), 0), "expo_in"), (1436, (0, 0, 0))])
    kc.sock_keys(m, "Opacity", [(f0 - 1, 0.0, "const"), (f0, 1.0), (1434, 1.0, "cubic"), (1442, 0.0)])
    kc.sock_keys(sh, "Opacity", [(f0, 0.0, "cubic"), (f0 + 20, 0.6), (1420, 0.6, "cubic"), (1436, 0.0)])
    kc.sock_keys(gm, "Opacity", [(f0 + 10, 0.0, "cubic"), (f0 + 30, 0.7)] +
                 [(f0 + 40 + 24 * j, 0.45 if j % 2 else 0.8, "sine") for j in range(6)] + [(1400, 0.6, "cubic"), (1420, 0.0)])
    kc.sock_keys(gm, "Strength", [(f0, 2.0)])
    cue("card", f0)
    cards.append(root)
CK(1236, at(-1.6, 0.05, 3.4), at(-0.5, 0.1, 1.05), at(-0.7, 0.1, 1.05), ease="sine")
CK(1396, at(1.4, 0.15, 3.3), at(0.5, 0.1, 1.05), at(0.7, 0.1, 1.05), ease="expo")
fstop(1236, 5.6)
fstop(1440, 11.0)
title("t_side", "Run agents side by side.", at(0.0, 0.78, 1.2), 0.1, 1262, 1380, "lexend-deca-600", backing=True)
# back into the Dashboard: live status changes (real, captured)
live = state("dash_live", os.path.join(SEQ, "dash_live", "0000.png"), 1440, 6, MAIN_R, seq={"start": 1440, "length": 192, "offset": -1})
CK(1440, at(0.0, 0.0, 3.6), at(-0.2, 0.2, 0), at(-0.45, 0.3, 0), ease="cubic")
CK(1616, at(-0.65, 0.25, 2.6), at(-0.45, 0.25, 0), at(-0.45, 0.3, 0))
for f in (1470, 1510, 1556):
    cue("status", f)

# =========================================================== ACT 4  KALVOICE (1620-2100)
thA2 = state("thA2_full", os.path.join(PL, "v_focus", "before.png"), 1632, 10, slide=0.06)
CK(1626, at(-0.2, 0.2, 3.6), at(0.0, 0.3, 0), at(0.1, 0.5, 0), ease="expo_out")
CK(1690, at(-0.45, 0.2, 3.3), at(-0.1, 0.4, 0), at(0.1, 0.6, 0))
title("t_talk", "Talk to your workspace.", at(0.0, -0.35, 0.7), 0.15, 1640, 1690, "lexend-deca-600", backing=True)
PILL_RECT = (1380, 0, 2300, 260)
PILLC = kc.plate_xy(PLATE, 1840, 132)
ROW = kc.plate_xy(PLATE, 849, 640)


def pill_glow(name, f_on, f_off):
    gm = kc.glow_material(name + "_m", 0.896, 0.232, 0.018, 0.05, color="#4c8dff", strength=3.0)
    g = kc.plane(name, 0.996, 0.332, gm, (PILLC[0], PILLC[1], 0.03), WIN)
    kc._pad_uv(g, 0.896, 0.232, 0.05)
    kc.sock_keys(gm, "Opacity", [(f_on, 0.0, "expo_out"), (f_on + 10, 1.0), (f_off, 1.0, "cubic"), (f_off + 12, 0.0)])
    n = max(1, (f_off - f_on) // 16)
    kc.sock_keys(gm, "Strength", [(f_on + 10 + 16 * k, 2.2 if k % 2 else 3.6, "sine") for k in range(n)])


def said(name, body, f0, f1, f_out):
    ob, m = kc.text(name, body, "lexend-deca-400", 0.058, (PILLC[0] - 0.3, PILLC[1] - 0.3, 0.42), parent=WIN)
    kc.sock_keys(m, "Wipe", [(f0, 0.0, "linear"), (f1, 1.0)])
    kc.sock_keys(m, "Opacity", [(f_out, 1.0, "cubic"), (f_out + 14, 0.0)])
    bgm = kc.shadow_material(name + "_bg", 1.25, 0.1, 0.05, 0.16, 0.92)
    b = kc.plane(name + "_bgp", 1.57, 0.42, bgm, (PILLC[0] - 0.3, PILLC[1] - 0.3, 0.41), WIN)
    kc._pad_uv(b, 1.25, 0.1, 0.16)
    kc.sock_keys(bgm, "Opacity", [(f0 - 2, 0.0, "cubic"), (f0 + 10, 0.92), (f_out, 0.92, "cubic"), (f_out + 14, 0.0)])


# focus
V0 = 1704
lz = state_z() + 0.01
pl, plm = kc.overlay("pill_listen", os.path.join(SEQ, "pill_listen", "0000.png"), WIN, PLATE, PILL_RECT, z=lz, seq={"start": V0, "length": 64, "offset": -1})
kc.sock_keys(plm, "Opacity", [(V0 - 2, 0.0, "cubic"), (V0 + 1, 1.0), (V0 + 62, 1.0, "cubic"), (V0 + 65, 0.0)])
pill_glow("pill_glow1", V0 - 2, V0 + 58)
said("said_focus", "“Focus the Browser redesign thread.”", V0 + 6, V0 + 54, V0 + 60)
cue("voice_on", V0 - 2)
cue("voice_off", V0 + 58)
fstop(V0 - 60, 8.0)
CK(V0, at(-0.62, 0.05, 3.05), at(-0.18, 0.5, 0), at(0.0, 0.6, 0), ease="cubic")
CK(V0 + 70, at(-0.7, 0.18, 2.85), at(-0.25, 0.5, 0), at(-0.25, 0.5, 0))
sx, sy = PILLC[0], PILLC[1] - 0.12
dx, dy = ROW[0] + 0.3 - sx, ROW[1] + 0.09 - sy
L = math.hypot(dx, dy)
beam_m = kc.text_material("beam_m", "#7fb0ff", strength=6.0)
beam = kc.plane("route_beam", L, 0.006, beam_m, (sx + dx / 2, sy + dy / 2, 0.05), WIN)
beam.rotation_euler = (0, 0, math.atan2(dy, dx) + math.pi)
for k_, v_ in (("XMin", -L / 2), ("XMax", L / 2), ("Feather", 0.08)):
    beam_m.node_tree.nodes[k_].outputs[0].default_value = v_
kc.sock_keys(beam_m, "Wipe", [(V0 + 60, 0.0, "expo_out"), (V0 + 72, 1.0)])
kc.sock_keys(beam_m, "Opacity", [(V0 + 59, 0.0), (V0 + 60, 1.0), (V0 + 74, 1.0, "cubic"), (V0 + 88, 0.0)])
cue("route", V0 + 60)
thB = state("thB_full", os.path.join(PL, "v_tell", "before.png"), V0 + 76, 8)
pr, prm = kc.overlay("pill_ready", os.path.join(UI, "pill_ready_region.png"), WIN, PLATE, PILL_RECT, z=lz + 0.0005)
kc.sock_keys(prm, "Opacity", [(V0 + 63, 0.0, "cubic"), (V0 + 67, 1.0), (V0 + 124, 1.0, "const"), (V0 + 125, 0.0)])
RW, RH = 0.602, 0.168
rg_m = kc.glow_material("row_glow_m", RW, RH, 0.012, 0.06, color="#4c8dff", strength=5.0)
rg = kc.plane("row_glow", RW + 0.12, RH + 0.12, rg_m, (ROW[0], ROW[1], 0.035), WIN)
kc._pad_uv(rg, RW, RH, 0.06)
kc.sock_keys(rg_m, "Opacity", [(V0 + 70, 0.0, "expo_out"), (V0 + 76, 1.0), (V0 + 118, 1.0, "cubic"), (V0 + 132, 0.0)])
kc.sock_keys(rg_m, "Strength", [(V0 + 70, 5.0, "expo_out"), (V0 + 98, 2.2)])
cue("focus", V0 + 70)
CK(V0 + 76, at(-0.7, 0.18, 2.85), at(-0.25, 0.5, 0), at(ROW[0], ROW[1], 0), ease="expo_out")
CK(V0 + 118, at(-1.0, 0.26, 2.5), at(-0.5, 0.36, 0), at(ROW[0], ROW[1], 0))

# tell: the prompt lands in the thread
T0 = V0 + 128  # 1832
tz = state_z() + 0.012
pt, ptm = kc.overlay("pill_tell", os.path.join(SEQ, "pill_tell", "0000.png"), WIN, PLATE, PILL_RECT, z=tz, seq={"start": T0, "length": 128, "offset": -1})
kc.sock_keys(ptm, "Opacity", [(T0 - 2, 0.0, "cubic"), (T0 + 1, 1.0)])
pill_glow("pill_glow2", T0 - 2, T0 + 60)
said("said_tell", "“Tell it to finish the redesign.”", T0 + 6, T0 + 50, T0 + 64)
cue("voice_on", T0 - 2)
cue("voice_off", T0 + 60)
CK(T0, at(-0.35, 0.25, 3.2), at(0.05, 0.5, 0), at(0.1, 0.6, 0), ease="cubic")
told = state("thread_tell", os.path.join(SEQ, "thread_tell", "0000.png"), T0 + 66, 4, MAIN_R, seq={"start": T0 + 66, "length": 64, "offset": -1})
cue("sent", T0 + 64)
CK(T0 + 70, at(0.2, -0.1, 3.0), at(0.45, -0.1, 0), at(0.45, -0.05, 0), ease="expo_out")
CK(2096, at(0.35, -0.3, 2.5), at(0.5, -0.25, 0), at(0.5, -0.25, 0))

# =========================================================== ACT 5  BUILD LOOP (2100-2580)
STEPS = ["PROMPT", "CODE", "BUILD", "BROWSER", "RESULT"]
chain = kc.empty("CHAIN", at(0.0, -1.22, 0.9))
chain_m = kc.flat_material("chain_line_m", "#4c8dff", strength=3.0, opacity=0.0)
cl = kc.plane("chain_line", 2.6, 0.004, chain_m, (0, 0, -0.01), chain)
kc.sock_keys(chain_m, "Opacity", [(2104, 0.0, "cubic"), (2124, 0.55), (2560, 0.55, "cubic"), (2580, 0.0)])
step_frames = [2110, 2200, 2290, 2380, 2470]
for k, (word, f) in enumerate(zip(STEPS, step_frames)):
    x = -1.2 + k * 0.6
    ob, m = kc.text("step_" + word, word, "lexend-exa-500", 0.05, (x, 0.04, 0), tracking=1.4, color="#e6edf8", parent=chain)
    kc.sock_keys(m, "Wipe", [(2104 + k * 5, 0.0, "cubic_out"), (2130 + k * 5, 1.0)])
    kc.sock_keys(m, "Opacity", [(2130, 0.35), (f - 4, 0.35, "cubic"), (f + 4, 1.0), (f + 84, 1.0, "cubic"), (f + 96, 0.55),
                                (2566, 0.55, "cubic"), (2580, 0.0)])
    kc.sock_keys(m, "Strength", [(f - 4, 1.0, "expo_out"), (f + 2, 2.6), (f + 40, 1.3)])
    dot_m = kc.glow_material("step_dot_m%d" % k, 0.012, 0.012, 0.006, 0.03, color="#4c8dff", strength=6)
    dot = kc.plane("step_dot%d" % k, 0.072, 0.072, dot_m, (x, -0.0, 0.0), chain)
    kc._pad_uv(dot, 0.012, 0.012, 0.03)
    kc.sock_keys(dot_m, "Opacity", [(2100, 0.0, "cubic"), (2124, 0.3), (f - 4, 0.3, "expo_out"), (f + 2, 1.0), (f + 60, 0.7), (2566, 0.7, "cubic"), (2580, 0.0)])
    cue("step", f)
# PROMPT: the message you sent (thread_tell already showing it)
# CODE: the agent's edit to BrowserPane.tsx
st_code = state("code_edit", os.path.join(PL, "v_tell", "after_015.png"), 2196, 8)
# BUILD: tests run green in the real terminal
st_term = state("build_code", os.path.join(PL, "term", "034.png"), 2286, 8, slide=0.05)
# BROWSER: the page in KalCode's Browser pane
st_br = state("build_browser", os.path.join(PL, "code_browser_site.png"), 2376, 8, slide=0.05)
# RESULT: done, tests pass
st_res = state("build_result", os.path.join(PL, "v_tell", "after_015.png"), 2466, 8, slide=0.05)

fstop(2100, 11.0)
tour([
    (2112, at(0.1, -0.2, 3.1), at(0.4, 0.05, 0.2), at(0.45, 0.25, 0)),      # PROMPT: the message
    (2202, at(0.05, -0.4, 2.7), at(0.45, -0.3, 0.2), at(0.5, -0.35, 0)),    # CODE: the edit
    (2292, at(-0.95, 0.05, 2.8), at(-0.4, 0.2, 0.2), at(-0.5, 0.3, 0)),     # BUILD: tests
    (2382, at(0.55, -0.1, 2.9), at(0.95, 0.0, 0.2), at(0.95, 0.0, 0)),      # BROWSER
    (2472, at(0.2, -0.55, 2.6), at(0.5, -0.5, 0.2), at(0.5, -0.62, 0)),     # RESULT
    (2546, at(0.25, -0.58, 2.35), at(0.5, -0.55, 0.2), at(0.5, -0.62, 0)),
])

# =========================================================== ACT 6  COCKPIT (2580-3060)
title("t_build", "Build.", at(-0.95, 0.12, 0.9), 0.14, 2548, 2640, "lexend-deca-700", backing=True, dur_in=14)
title("t_test", "Test.", at(-0.38, 0.12, 0.9), 0.14, 2562, 2640, "lexend-deca-700", backing=True, dur_in=14)
title("t_ship", "Ship.", at(0.17, 0.12, 0.9), 0.14, 2576, 2640, "lexend-deca-700", color="#7fb0ff", backing=True, dur_in=14)
t2 = state("t2_full", os.path.join(PL, "term_second.png"), 2596, 8, slide=0.05)
push = state("push_seq", os.path.join(SEQ, "push", "0000.png"), 2612, 4, TERM_R, seq={"start": 2612, "length": 70, "offset": -1})
cue("key", 2604)
cue("push", 2640)
CK(2590, at(-0.6, 0.35, 3.1), at(-0.3, 0.45, 0), at(-0.5, 0.55, 0), ease="expo")
CK(2690, at(-0.85, 0.5, 2.5), at(-0.45, 0.6, 0), at(-0.55, 0.62, 0))
# rapid tour: model + account pickers, a named second terminal, workspaces, dashboard
TOUR = [
    ("tour_nt0", os.path.join(PL, "nt_0.png"), 2700, "Pick the provider.", (0.0, 0.3)),
    ("tour_nt1", os.path.join(PL, "nt_1.png"), 2760, "Pick the account.", (0.1, 0.3)),
    ("tour_nt2", os.path.join(PL, "nt_2.png"), 2810, "Pick the model.", (0.35, 0.3)),
    ("tour_sw", os.path.join(PL, "switch_ws.png"), 2880, "Switch workspaces.", (1.15, 0.55)),
    ("tour_dash", os.path.join(PL, "dash.png"), 2950, "See what needs you.", (-0.3, 0.3)),
]
poses = []
for k, (name, path, f, label, focus_xy) in enumerate(TOUR):
    state(name, path, f, 8, slide=0.05 if k % 2 == 0 else 0.0)
    fx, fy = focus_xy
    poses.append((f - 2, at(fx - 0.45 + 0.2 * (k % 2), fy - 0.25, 2.9), at(fx, fy - 0.08, 0), at(fx, fy, 0)))
    title("tl_" + name, label, at(fx, fy - 0.62, 0.8), 0.075, f + 2, f + 50, "lexend-deca-500", backing=True, dur_in=18)
poses.append((3000, at(0.0, 0.0, 4.6), at(0.0, 0.0, 0), at(0.0, -0.1, 1.3)))
tour(poses)
fstop(2690, 11.0)
nt_type = state("nt_type", os.path.join(SEQ, "nt_type", "0000.png"), 2826, 4, MAIN_R, seq={"start": 2826, "length": 72, "offset": -1}, f_out=2872)
title("t_wrapper", "Not another terminal wrapper.", at(0.0, -0.1, 1.3), 0.14, 3004, 3050, "lexend-deca-600", backing=True)
CK(3058, at(0.0, 0.0, 4.9), at(0.0, 0.0, 0), at(0.0, -0.1, 1.3))

# =========================================================== ACT 7  BUILT IN KALCODE (3060-3360)
self_st = state("self_code", os.path.join(PL, "code.png"), 3066, 8)
CK(3064, at(-1.25, 0.72, 1.7), at(-0.85, 0.82, 0), at(-0.95, 0.85, 0), ease="cubic")
CK(3150, at(-0.9, 0.55, 2.0), at(-0.55, 0.6, 0), at(-0.6, 0.62, 0), ease="cubic")
fstop(3064, 22.0)
CK(3268, at(0.0, 0.0, 7.5), at(0.0, 0.0, 0), at(0.0, 0.0, 0), ease="expo")
fstop(3268, 8.0)
title("t_self1", "Build KalCode.", at(0.0, 0.2, 1.6), 0.2, 3228, 3304, "lexend-deca-700", backing=True)
title("t_self2", "Inside KalCode.", at(0.0, -0.12, 1.6), 0.2, 3248, 3304, "lexend-deca-300", color="#7fb0ff", backing=False)
CK(3330, at(0.0, 0.0, 8.0), at(0.0, 0.0, 0), at(0.0, 0.0, 0))
# the window folds away before the end card
for m in [self_st[1]] + [bpy.data.materials[n] for n in ("win_edge_m", "win_rim_m", "win_shadow_m")]:
    kc.sock_keys(m, "Opacity", [(3318, m.node_tree.nodes["Opacity"].outputs[0].default_value or 0.6, "cubic"), (3350, 0.0)])

# =========================================================== ACT 8  END CARD (3360-3600)
E = (0, 0, -160)


def et(x, y, z=0.0):
    return (E[0] + x, E[1] + y, E[2] + z)


CUT(3352, et(0, 0, 5.4), et(0, 0, 0))
fstop(3352, 3.2, "const")
CK(3599, et(0, 0, 5.0), et(0, 0, 0), ease="cubic")
# the full rim-lit mascot reads better large than the tile; a touch bigger and higher than the old
# round glyph so the figure (taller than wide) keeps a clear gap above the wordmark
esym, esm = kc.image_plane("end_symbol", os.path.join(BRAND, "kalcode-mascot-dark-1024.png"), 0.60, et(0, 0.535, 0.01), strength=1.15)
kc.sock_keys(esm, "Opacity", [(3356, 0.0, "cubic_out"), (3374, 1.0)])
kc.keys(esym, "scale", [(3356, (0.8,) * 3, "back_out"), (3392, (1,) * 3)])
ewm, ewm_m = kc.image_plane("end_wordmark", os.path.join(BR, "kalcode-wordmark.png"), 1.2, et(0, 0.08, 0.0))
kc.sock_keys(ewm_m, "Wipe", [(3364, 0.0, "cubic"), (3396, 1.0)])
kc.sock_keys(ewm_m, "Edge", [(3364, 1.0, "linear"), (3392, 1.0, "cubic"), (3404, 0.0)])
cue("endlogo", 3364)
e1, e1m = kc.text("end_refactor", "REFACTOR THE WORKFLOW.", "lexend-exa-500", 0.07, et(0, -0.2, 0), tracking=1.5, color="#e6edf8")
kc.sock_keys(e1m, "Wipe", [(3404, 0.0, "cubic_out"), (3436, 1.0)])
e2, e2m = kc.text("end_future", "CODE THE FUTURE.", "lexend-exa-700", 0.07, et(0, -0.33, 0), tracking=1.5, color="#7fb0ff", strength=1.3)
kc.sock_keys(e2m, "Wipe", [(3424, 0.0, "cubic_out"), (3456, 1.0)])
cta, ctam = kc.text("end_cta", "Start building  —  kalcoded.com", "lexend-deca-500", 0.058, et(0, -0.56, 0), color="#e6edf8")
kc.sock_keys(ctam, "Wipe", [(3470, 0.0, "cubic_out"), (3500, 1.0)])
sub, subm = kc.text("end_sub", "Claude Code + Codex available now. More providers coming.", "lexend-deca-300", 0.036,
                    et(0, -0.68, 0), color="#8593ab")
kc.sock_keys(subm, "Wipe", [(3486, 0.0, "cubic_out"), (3520, 1.0)])
eline_m = kc.flat_material("end_line_m", "#4c8dff", strength=5.0, opacity=0.0)
eline = kc.plane("end_line", 1.3, 0.003, eline_m, et(0, -0.45, 0))
kc.keys(eline, "scale", [(3462, (0.001, 1, 1), "expo_out"), (3490, (1, 1, 1))])
kc.sock_keys(eline_m, "Opacity", [(3460, 0.0, "cubic"), (3466, 0.8)])

out = sys.argv[-1] if sys.argv[-1].endswith(".blend") else os.path.join(kc.LAUNCH, "blender", "film.blend")
json.dump(CUES, open(os.path.join(kc.LAUNCH, "audio", "film_cues.json"), "w"), indent=0)
kc.save(out)
print("FILM_BUILT", out)
