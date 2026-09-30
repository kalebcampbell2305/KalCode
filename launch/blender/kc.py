"""KalCode launch film: Blender scene toolkit.

Builds editable Blender scenes: UI plates become emissive image planes (exact sRGB with the
Standard view transform), with rounded masks, borders, glow and shadow cards. Brand type is
real text objects. Keyframes use Blender's own easing (EXPO / BACK / BEZIER) so every move
stays editable in the Graph Editor.

Units: 1 BU = 1000 plate px (plates are DPR 2), so a full 1600x960 window is 3.2 x 1.92 BU.
"""
import math
import os

import bpy
from mathutils import Vector

LAUNCH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(LAUNCH, "assets")
PLATES = os.path.join(LAUNCH, "capture", "plates")
FONTS = os.path.join(ASSETS, "fonts")
FPS = 60
PX = 0.001  # 1 plate px in BU

# Brand tokens (packages/ui/src/styles/tokens.css, dark theme)
C = {
    "bg": "#05080f",
    "void": "#020408",
    "surface": "#0b1322",
    "raised": "#101a2d",
    "text": "#e6edf8",
    "text2": "#a8b4c9",
    "muted": "#8593ab",
    "accent": "#4c8dff",
    "primary": "#2a64e6",
    "success": "#35c48d",
    "amber": "#f2b544",
    "red": "#ef5f6b",
    "border": "#8eaadc",
}


def lin(hexstr, a=1.0):
    h = hexstr.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i : i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, a)


# ------------------------------------------------------------------ scene


def new_scene(name, frames):
    sc = bpy.data.scenes.get(name) or bpy.data.scenes.new(name)
    bpy.context.window.scene = sc if bpy.context.window else sc
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
    sc.render.resolution_percentage = 100
    sc.render.fps = FPS
    sc.frame_start, sc.frame_end = 0, frames - 1
    sc.render.use_motion_blur = True
    sc.render.motion_blur_shutter = 0.5
    sc.eevee.motion_blur_steps = 2
    sc.eevee.taa_render_samples = 32
    sc.eevee.use_shadows = False
    sc.eevee.use_raytracing = False
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.view_settings.exposure = 0
    sc.view_settings.gamma = 1
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    sc.render.image_settings.color_depth = "8"
    world = bpy.data.worlds.new(name + "_world")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = lin(C["void"])
    bg.inputs[1].default_value = 1
    sc.world = world
    return sc


ROOT = {"obj": None}


def world_root():
    """All film objects live under one root rotated 90 deg about X, so authoring happens in the
    XY plane (x right, y up, z toward camera) while Blender's world Z stays 'up' for the camera."""
    if ROOT["obj"] is None or ROOT["obj"].name not in bpy.data.objects:
        r = bpy.data.objects.new("FILM_ROOT", None)
        r.rotation_euler = (math.radians(90), 0, 0)
        bpy.context.scene.collection.objects.link(r)
        ROOT["obj"] = r
    return ROOT["obj"]


def link(obj, sc=None):
    (sc or bpy.context.scene).collection.objects.link(obj)
    if obj.name != "FILM_ROOT" and obj.parent is None:
        obj.parent = world_root()
    return obj


def empty(name, loc=(0, 0, 0), parent=None):
    e = bpy.data.objects.new(name, None)
    e.location = loc
    e.empty_display_size = 0.2
    link(e)
    if parent:
        e.parent = parent
    return e


# ------------------------------------------------------------------ keyframes

INTERP = {
    "linear": ("LINEAR", "AUTO"),
    "const": ("CONSTANT", "AUTO"),
    "smooth": ("BEZIER", "AUTO"),
    "expo_out": ("EXPO", "EASE_OUT"),
    "expo_in": ("EXPO", "EASE_IN"),
    "expo": ("EXPO", "EASE_IN_OUT"),
    "quint_out": ("QUINT", "EASE_OUT"),
    "quint": ("QUINT", "EASE_IN_OUT"),
    "cubic_out": ("CUBIC", "EASE_OUT"),
    "cubic": ("CUBIC", "EASE_IN_OUT"),
    "quad_in": ("QUAD", "EASE_IN"),
    "back_out": ("BACK", "EASE_OUT"),
    "sine": ("SINE", "EASE_IN_OUT"),
}


def _fcurves(idblock):
    ad = idblock.animation_data
    if not ad or not ad.action:
        return []
    act = ad.action
    try:
        from bpy_extras import anim_utils

        cb = anim_utils.action_get_channelbag_for_slot(act, ad.action_slot)
        return list(cb.fcurves) if cb else []
    except Exception:
        return list(getattr(act, "fcurves", []))


def key(target, path, frame, value, ease="smooth", back=1.2, owner=None):
    """Keyframe target.path = value at frame; the segment AFTER this key uses `ease`.

    target: an ID or struct (object, node socket...). owner: the ID whose action holds the curve
    (defaults to target; node sockets need their node tree).
    """
    obj = target
    attr = path
    setattr(obj, attr, value)
    obj.keyframe_insert(attr, frame=frame)
    owner = owner or target
    interp, easing = INTERP[ease]
    full = obj.path_from_id(attr) if owner is not target else attr
    for fc in _fcurves(owner):
        if fc.data_path == full:
            for kp in fc.keyframe_points:
                if abs(kp.co.x - frame) < 0.01:
                    kp.interpolation = interp
                    kp.easing = easing
                    if interp == "BACK":
                        kp.back = back
                    if interp == "BEZIER":
                        kp.handle_left_type = kp.handle_right_type = "AUTO_CLAMPED"


def keys(target, path, pts, owner=None):
    """pts: [(frame, value, ease?), ...]"""
    for p in pts:
        f, v = p[0], p[1]
        ease = p[2] if len(p) > 2 else "smooth"
        key(target, path, f, v, ease, owner=owner)


def sock_keys(mat, node_name, pts, socket=0):
    """Keyframe a Value node's output (named `node_name`) in material `mat`."""
    node = mat.node_tree.nodes[node_name]
    for p in pts:
        f, v = p[0], p[1]
        ease = p[2] if len(p) > 2 else "smooth"
        key(node.outputs[socket], "default_value", f, v, ease, owner=mat.node_tree)


# ------------------------------------------------------------------ images & materials

_img_cache = {}


def image(path, sequence_len=0):
    path = os.path.abspath(path)
    if path in _img_cache:
        return _img_cache[path]
    img = bpy.data.images.load(path, check_existing=True)
    if sequence_len:
        img.source = "SEQUENCE"
    img.colorspace_settings.name = "sRGB"
    _img_cache[path] = img
    return img


def _sdf_rrect(nt, uv_socket, w, h, r):
    """Signed distance (BU) to a w x h rounded rect with radius r, from a UV socket."""
    N = nt.nodes
    L = nt.links
    sub = N.new("ShaderNodeVectorMath"); sub.operation = "SUBTRACT"; sub.inputs[1].default_value = (0.5, 0.5, 0)
    mul = N.new("ShaderNodeVectorMath"); mul.operation = "MULTIPLY"; mul.inputs[1].default_value = (w, h, 1)
    ab = N.new("ShaderNodeVectorMath"); ab.operation = "ABSOLUTE"
    q = N.new("ShaderNodeVectorMath"); q.operation = "SUBTRACT"; q.inputs[1].default_value = (w / 2 - r, h / 2 - r, 0)
    mx = N.new("ShaderNodeVectorMath"); mx.operation = "MAXIMUM"; mx.inputs[1].default_value = (0, 0, 0)
    ln = N.new("ShaderNodeVectorMath"); ln.operation = "LENGTH"
    sep = N.new("ShaderNodeSeparateXYZ")
    mxy = N.new("ShaderNodeMath"); mxy.operation = "MAXIMUM"
    mn0 = N.new("ShaderNodeMath"); mn0.operation = "MINIMUM"; mn0.inputs[1].default_value = 0
    add = N.new("ShaderNodeMath"); add.operation = "ADD"
    subr = N.new("ShaderNodeMath"); subr.operation = "SUBTRACT"; subr.inputs[1].default_value = r
    L.new(uv_socket, sub.inputs[0]); L.new(sub.outputs[0], mul.inputs[0]); L.new(mul.outputs[0], ab.inputs[0])
    L.new(ab.outputs[0], q.inputs[0]); L.new(q.outputs[0], mx.inputs[0]); L.new(mx.outputs[0], ln.inputs[0])
    L.new(q.outputs[0], sep.inputs[0]); L.new(sep.outputs[0], mxy.inputs[0]); L.new(sep.outputs[1], mxy.inputs[1])
    L.new(mxy.outputs[0], mn0.inputs[0]); L.new(ln.outputs["Value"], add.inputs[0]); L.new(mn0.outputs[0], add.inputs[1])
    L.new(add.outputs[0], subr.inputs[0])
    return subr.outputs[0]


def _math(nt, op, a, b=None, clamp=False):
    n = nt.nodes.new("ShaderNodeMath")
    n.operation = op
    n.use_clamp = clamp
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            nt.links.new(v, n.inputs[i])
    return n.outputs[0]


def _value(nt, name, v):
    n = nt.nodes.new("ShaderNodeValue")
    n.name = n.label = name
    n.outputs[0].default_value = v
    return n.outputs[0]


def _finish(mat, nt, color_socket, strength_socket, alpha_socket):
    N, L = nt.nodes, nt.links
    em = N.new("ShaderNodeEmission")
    L.new(color_socket, em.inputs["Color"])
    if isinstance(strength_socket, (int, float)):
        em.inputs["Strength"].default_value = strength_socket
    else:
        L.new(strength_socket, em.inputs["Strength"])
    tr = N.new("ShaderNodeBsdfTransparent")
    mix = N.new("ShaderNodeMixShader")
    L.new(alpha_socket, mix.inputs[0])
    L.new(tr.outputs[0], mix.inputs[1])
    L.new(em.outputs[0], mix.inputs[2])
    out = N.new("ShaderNodeOutputMaterial")
    L.new(mix.outputs[0], out.inputs["Surface"])
    mat.surface_render_method = "BLENDED"
    mat.use_transparency_overlap = False


def ui_material(name, img, w, h, radius=0.012, border=0.14, border_color="#8eaadc", seq=None):
    """Image plane material: exact UI colours, rounded alpha, hairline border. Keyable nodes:
    Opacity, Bright (emission multiplier), Border (border alpha)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Linear"
    tex.extension = "EXTEND"
    if seq:
        u = tex.image_user
        u.frame_start, u.frame_duration, u.frame_offset = seq["start"], seq["length"], seq.get("offset", 0)
        u.use_auto_refresh = True
        u.use_cyclic = False
    nt.links.new(tc.outputs["UV"], tex.inputs[0])
    d = _sdf_rrect(nt, tc.outputs["UV"], w, h, radius)
    aa = 0.0016
    inside = _math(nt, "SUBTRACT", 0.5, _math(nt, "DIVIDE", d, aa), clamp=True)
    band = _math(nt, "SUBTRACT", 1.0, _math(nt, "DIVIDE", _math(nt, "ABSOLUTE", _math(nt, "ADD", d, 0.0012)), 0.0012), clamp=True)
    op = _value(nt, "Opacity", 1.0)
    br = _value(nt, "Bright", 1.0)
    bd = _value(nt, "Border", border)
    # colour = mix(image, border colour, band*Border)
    mixc = nt.nodes.new("ShaderNodeMix")
    mixc.data_type = "RGBA"
    nt.links.new(_math(nt, "MULTIPLY", band, bd), mixc.inputs["Factor"])
    nt.links.new(tex.outputs["Color"], mixc.inputs[6])
    mixc.inputs[7].default_value = lin(border_color)
    alpha = _math(nt, "MULTIPLY", _math(nt, "MULTIPLY", inside, tex.outputs["Alpha"]), op)
    _finish(mat, nt, mixc.outputs[2], br, alpha)
    # UI plates are opaque surfaces: depth-tested (dithered) alpha keeps layered states in the
    # right order from any camera angle; TAA resolves the dither into smooth fades.
    mat.surface_render_method = "DITHERED"
    return mat


def glow_material(name, w, h, radius, spread, color="#4c8dff", strength=4.0, ring=True):
    """Soft glow around a rounded rect (ring=True: hugs the edge; False: filled halo)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    d = _sdf_rrect(nt, tc.outputs["UV"], w, h, radius)
    # ring: soft halo outside the edge + a crisp 1.5 px focus line on it; inside stays clear.
    # halo (ring=False): the same, plus a faint fill inside.
    outside = _math(nt, "GREATER_THAN", d, 0.0)
    dd = _math(nt, "MAXIMUM", d, 0.0)
    fall = _math(nt, "SUBTRACT", 1.0, _math(nt, "DIVIDE", dd, spread), clamp=True)
    fall = _math(nt, "MULTIPLY", _math(nt, "POWER", fall, 3.0), 0.75)
    line = _math(nt, "SUBTRACT", 1.0, _math(nt, "DIVIDE", _math(nt, "ABSOLUTE", _math(nt, "SUBTRACT", d, 0.0012)), 0.0016), clamp=True)
    fall = _math(nt, "MAXIMUM", _math(nt, "MULTIPLY", fall, outside), line)
    if not ring:
        fall = _math(nt, "MAXIMUM", fall, _math(nt, "MULTIPLY", _math(nt, "LESS_THAN", d, 0.0), 0.35))
    op = _value(nt, "Opacity", 0.0)
    st = _value(nt, "Strength", strength)
    rgb = nt.nodes.new("ShaderNodeRGB")
    rgb.outputs[0].default_value = lin(color)
    _finish(mat, nt, rgb.outputs[0], st, _math(nt, "MULTIPLY", fall, op))
    return mat


def shadow_material(name, w, h, radius, spread, opacity=0.55):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    d = _sdf_rrect(nt, tc.outputs["UV"], w, h, radius)
    fall = _math(nt, "SUBTRACT", 1.0, _math(nt, "DIVIDE", _math(nt, "MAXIMUM", _math(nt, "ADD", d, spread * 0.25), 0.0), spread), clamp=True)
    fall = _math(nt, "POWER", fall, 2.5)
    op = _value(nt, "Opacity", opacity)
    rgb = nt.nodes.new("ShaderNodeRGB")
    rgb.outputs[0].default_value = (0, 0, 0, 1)
    _finish(mat, nt, rgb.outputs[0], 0.0, _math(nt, "MULTIPLY", fall, op))
    return mat


def flat_material(name, color, strength=1.0, opacity=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    rgb = nt.nodes.new("ShaderNodeRGB")
    rgb.outputs[0].default_value = lin(color)
    st = _value(nt, "Strength", strength)
    op = _value(nt, "Opacity", opacity)
    _finish(mat, nt, rgb.outputs[0], st, op)
    return mat


def gradient_material(name, inner, outer, strength=1.0):
    """Radial backdrop: inner colour at centre fading to outer."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sub = nt.nodes.new("ShaderNodeVectorMath"); sub.operation = "SUBTRACT"; sub.inputs[1].default_value = (0.5, 0.5, 0)
    ln = nt.nodes.new("ShaderNodeVectorMath"); ln.operation = "LENGTH"
    nt.links.new(tc.outputs["UV"], sub.inputs[0]); nt.links.new(sub.outputs[0], ln.inputs[0])
    t = _math(nt, "POWER", _math(nt, "MULTIPLY", ln.outputs["Value"], 2.0, clamp=True), 0.8)
    mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"
    nt.links.new(t, mix.inputs["Factor"])
    mix.inputs[6].default_value = lin(inner)
    mix.inputs[7].default_value = lin(outer)
    st = _value(nt, "Strength", strength)
    op = _value(nt, "Opacity", 1.0)
    _finish(mat, nt, mix.outputs[2], st, op)
    return mat


# ------------------------------------------------------------------ geometry


def plane(name, w, h, mat, loc=(0, 0, 0), parent=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(-w / 2, -h / 2, 0), (w / 2, -h / 2, 0), (w / 2, h / 2, 0), (-w / 2, h / 2, 0)], [], [(0, 1, 2, 3)])
    uv = me.uv_layers.new(name="UVMap")
    for i, co in enumerate(((0, 0), (1, 0), (1, 1), (0, 1))):
        uv.data[i].uv = co
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    link(ob)
    if parent:
        ob.parent = parent
    return ob


def _pad_uv(ob, w, h, pad):
    """The SDF nodes compute from UV scaled by (w, h). For a padded plane, remap UVs so the
    card rect maps to 0..1 and the padding extends beyond it."""
    uv = ob.data.uv_layers[0]
    fx, fy = pad / w, pad / h
    for i, co in enumerate(((-fx, -fy), (1 + fx, -fy), (1 + fx, 1 + fy), (-fx, 1 + fy))):
        uv.data[i].uv = co


def ui_card(name, img_path, loc=(0, 0, 0), parent=None, radius=0.012, border=0.14, shadow=True,
            scale=1.0, seq=None, glow=None):
    """A UI plate as a floating card: image plane + soft shadow (+ optional focus glow).
    Returns (root_empty, image_plane_object, material, glow_material_or_None)."""
    img = image(img_path, sequence_len=seq["length"] if seq else 0)
    w, h = img.size[0] * PX * scale, img.size[1] * PX * scale
    root = empty(name, loc, parent)
    mat = ui_material(name + "_m", img, w, h, radius * scale, border, seq=seq)
    ob = plane(name + "_img", w, h, mat, (0, 0, 0), root)
    gmat = None
    if shadow:
        sp = 0.28 * max(0.4, min(1.0, scale))
        sm = shadow_material(name + "_sh", w, h, radius, sp, 0.6)
        plane(name + "_shadow", w + 2 * sp, h + 2 * sp, sm, (0.0, -0.05 * scale, -0.03), root)
        sm.node_tree.nodes  # size-matched: SDF uses the card size, plane is padded
        _pad_uv(bpy.data.objects[name + "_shadow"], w, h, sp)
        root["shadow_mat"] = sm.name
    if glow:
        gs = 0.07
        gmat = glow_material(name + "_gl", w, h, radius, gs, color=glow, strength=3.0)
        plane(name + "_glow", w + 2 * gs, h + 2 * gs, gmat, (0, 0, -0.01), root)
        _pad_uv(bpy.data.objects[name + "_glow"], w, h, gs)
    return root, ob, mat, gmat


def overlay(name, img_path, parent, plate_size_px, rect_px, z=0.002, seq=None, radius=0.0, border=0.0):
    """Place a crop exactly over its source position on a full-window plate.
    rect_px = (x0, y0, x1, y1) in plate pixels; parent's origin is the plate centre."""
    x0, y0, x1, y1 = rect_px
    W, H = plate_size_px
    cx = ((x0 + x1) / 2 - W / 2) * PX
    cy = (H / 2 - (y0 + y1) / 2) * PX
    img = image(img_path, sequence_len=seq["length"] if seq else 0)
    w, h = (x1 - x0) * PX, (y1 - y0) * PX
    mat = ui_material(name + "_m", img, w, h, radius, border, seq=seq)
    return plane(name, w, h, mat, (cx, cy, z), parent), mat


def plate_xy(plate_size_px, x_px, y_px):
    W, H = plate_size_px
    return ((x_px - W / 2) * PX, (H / 2 - y_px) * PX)


# ------------------------------------------------------------------ type

_fonts = {}


def font(name):
    if name not in _fonts:
        _fonts[name] = bpy.data.fonts.load(os.path.join(FONTS, name + ".ttf"), check_existing=True)
    return _fonts[name]


def text_material(name, color="#e6edf8", strength=1.0):
    """Text material with keyable Opacity, Strength and a left-to-right Wipe (0..1 over the
    object's local x from XMin to XMax, feathered by Feather BU)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    xmin = _value(nt, "XMin", 0.0)
    xmax = _value(nt, "XMax", 1.0)
    wipe = _value(nt, "Wipe", 1.0)
    feather = _value(nt, "Feather", 0.05)
    # edge = xmin + wipe*(xmax - xmin + feather); alpha = clamp((edge - x)/feather)
    span = _math(nt, "ADD", _math(nt, "SUBTRACT", xmax, xmin), feather)
    edge = _math(nt, "ADD", xmin, _math(nt, "MULTIPLY", wipe, span))
    a = _math(nt, "DIVIDE", _math(nt, "SUBTRACT", edge, sep.outputs[0]), feather)
    a = _math(nt, "MINIMUM", _math(nt, "MAXIMUM", a, 0.0), 1.0)
    op = _value(nt, "Opacity", 1.0)
    st = _value(nt, "Strength", strength)
    rgb = nt.nodes.new("ShaderNodeRGB")
    rgb.outputs[0].default_value = lin(color)
    _finish(mat, nt, rgb.outputs[0], st, _math(nt, "MULTIPLY", a, op))
    return mat


def text(name, body, fontname="lexend-deca-500", size=0.2, loc=(0, 0, 0), align="CENTER",
         color="#e6edf8", tracking=1.0, strength=1.0, parent=None, valign="CENTER"):
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = body
    cu.font = font(fontname)
    cu.size = size
    cu.align_x = align
    cu.align_y = valign
    cu.space_character = tracking
    cu.resolution_u = 6
    ob = bpy.data.objects.new(name, cu)
    ob.location = loc
    link(ob)
    if parent:
        ob.parent = parent
    mat = text_material(name + "_m", color, strength)
    cu.materials.append(mat)
    bpy.context.view_layer.update()
    xs = [v[0] for v in ob.bound_box]
    mat.node_tree.nodes["XMin"].outputs[0].default_value = min(xs)
    mat.node_tree.nodes["XMax"].outputs[0].default_value = max(xs)
    mat.node_tree.nodes["Feather"].outputs[0].default_value = max(0.02, (max(xs) - min(xs)) * 0.12)
    return ob, mat


# ------------------------------------------------------------------ camera & compositor


def camera(name="Cam", loc=(0, 0, 6), lens=50, fstop=2.8):
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cd.sensor_width = 36
    cd.clip_start, cd.clip_end = 0.05, 400
    cd.dof.use_dof = True
    cd.dof.aperture_fstop = fstop
    cd.dof.aperture_blades = 7
    cam = bpy.data.objects.new(name, cd)
    cam.location = loc
    link(cam)
    target = empty(name + "_target", (0, 0, 0))
    focus = empty(name + "_focus", (0, 0, 0))
    cd.dof.focus_object = focus
    con = cam.constraints.new("TRACK_TO")
    con.target = target
    con.track_axis = "TRACK_NEGATIVE_Z"
    con.up_axis = "UP_Y"
    bpy.context.scene.camera = cam
    return cam, target, focus


def compositor(sc, bloom=0.9, bloom_size=0.62, vignette=0.28, grain=0.018):
    ng = bpy.data.node_groups.new(sc.name + "_comp", "CompositorNodeTree")
    sc.compositing_node_group = ng
    N, L = ng.nodes, ng.links
    ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    rl = N.new("CompositorNodeRLayers")
    rl.scene = sc
    gl = N.new("CompositorNodeGlare")
    gl.inputs["Type"].default_value = "Bloom"
    gl.inputs["Quality"].default_value = "High"
    gl.inputs["Threshold"].default_value = bloom
    gl.inputs["Smoothness"].default_value = 0.3
    gl.inputs["Strength"].default_value = 0.85
    gl.inputs["Size"].default_value = bloom_size
    L.new(rl.outputs["Image"], gl.inputs["Image"])
    # vignette: ellipse mask, blurred, multiplied in
    el = N.new("CompositorNodeEllipseMask")
    el.inputs["Size"].default_value = (0.92, 0.86)
    bl = N.new("CompositorNodeBlur")
    bl.inputs["Size"].default_value = (420, 420)
    L.new(el.outputs["Mask"], bl.inputs["Image"])
    mr = N.new("ShaderNodeMapRange")
    mr.inputs["To Min"].default_value = 1 - vignette
    mr.inputs["To Max"].default_value = 1.0
    L.new(bl.outputs["Image"], mr.inputs["Value"])
    mul = N.new("CompositorNodeMixRGB") if hasattr(bpy.types, "CompositorNodeMixRGB") else None
    out = N.new("NodeGroupOutput")
    if mul is not None:
        mul.blend_type = "MULTIPLY"
        L.new(gl.outputs["Image"], mul.inputs[1])
        L.new(mr.outputs["Result"], mul.inputs[2])
        L.new(mul.outputs[0], out.inputs[0])
    else:
        mix = N.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        L.new(gl.outputs["Image"], mix.inputs[6])
        L.new(mr.outputs["Result"], mix.inputs[7])
        L.new(mix.outputs[2], out.inputs[0])
    return ng


def backdrop(z=-60, size=220, inner="#0a1428", outer="#020408"):
    m = gradient_material("backdrop_m", inner, outer)
    return plane("backdrop", size, size * 0.62, m, (0, 0, z))


def save(path):
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(path), compress=True)


def image_wipe_material(name, img, strength=1.0, edge_color="#9cc2ff", edge_strength=6.0):
    """Image (logo) revealed left-to-right by Wipe (0..1 in UV x) with a bright light-sweep edge.
    Keyable: Wipe, Opacity, Strength, Edge."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.extension = "CLIP"
    nt.links.new(tc.outputs["UV"], tex.inputs[0])
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["UV"], sep.inputs[0])
    wipe = _value(nt, "Wipe", 1.0)
    edge = _value(nt, "Edge", 0.0)
    fea = 0.06
    pos = _math(nt, "SUBTRACT", _math(nt, "MULTIPLY", wipe, 1 + 2 * fea), fea)
    reveal = _math(nt, "MINIMUM", _math(nt, "MAXIMUM", _math(nt, "DIVIDE", _math(nt, "SUBTRACT", pos, sep.outputs[0]), fea), 0.0), 1.0)
    band = _math(nt, "SUBTRACT", 1.0, _math(nt, "DIVIDE", _math(nt, "ABSOLUTE", _math(nt, "SUBTRACT", sep.outputs[0], pos)), fea), clamp=True)
    op = _value(nt, "Opacity", 1.0)
    st = _value(nt, "Strength", strength)
    mixc = nt.nodes.new("ShaderNodeMix"); mixc.data_type = "RGBA"
    nt.links.new(_math(nt, "MULTIPLY", band, edge), mixc.inputs["Factor"])
    nt.links.new(tex.outputs["Color"], mixc.inputs[6])
    mixc.inputs[7].default_value = lin(edge_color)
    # strength boosted on the sweep edge
    stt = _math(nt, "ADD", st, _math(nt, "MULTIPLY", _math(nt, "MULTIPLY", band, edge), edge_strength))
    alpha = _math(nt, "MULTIPLY", _math(nt, "MULTIPLY", tex.outputs["Alpha"], reveal), op)
    _finish(mat, nt, mixc.outputs[2], stt, alpha)
    return mat


def image_plane(name, path, width, loc=(0, 0, 0), parent=None, mat=None, strength=1.0):
    """Plane sized to `width` BU keeping the image aspect; default image_wipe_material."""
    img = image(path)
    h = width * img.size[1] / img.size[0]
    mat = mat or image_wipe_material(name + "_m", img, strength)
    return plane(name, width, h, mat, loc, parent), mat


def hide_until(ob_mat_pairs, show, hide=None, fade=6):
    """Fade material Opacity nodes in at `show` (and out at `hide`)."""
    for m in ob_mat_pairs:
        pts = [(show - fade, 0.0, "cubic"), (show, 1.0)]
        if hide is not None:
            pts += [(hide, 1.0, "cubic"), (hide + fade, 0.0)]
        sock_keys(m, "Opacity", pts)
