"""Social cuts from the approved master, cut on the beat grid (0.5 s) with short audio crossfades,
then two-pass loudness normalised to -14 LUFS / -1.5 dBTP.   python scripts/social.py"""
import json, re, subprocess

MASTER = "out/kalcode_launch_60s.mp4"
CUTS = {
    # hook → hit → parallel → voice → ship → end card
    "out/kalcode_launch_30s.mp4": [(5.0, 10.0), (24.0, 30.0), (30.0, 36.0), (44.0, 50.0), (53.0, 60.0)],
    # hit (opens on the frame of the HIT) → parallel → ship → end card
    "out/kalcode_launch_15s.mp4": [(6.0, 10.0), (26.5, 30.0), (46.0, 50.0), (56.5, 60.0)],
}

def run(args):
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")

for out, segs in CUTS.items():
    total = sum(b - a for a, b in segs)
    fc, vl, al = [], [], []
    for i, (a, b) in enumerate(segs):
        fc.append(f"[0:v]trim=start={a}:end={b},setpts=PTS-STARTPTS[v{i}]")
        fade = f",afade=t=in:d=0.012,afade=t=out:st={b - a - 0.02}:d=0.02" if 0 < i or i < len(segs) - 1 else ""
        fc.append(f"[0:a]atrim=start={a}:end={b},asetpts=PTS-STARTPTS{fade}[a{i}]")
        vl.append(f"[v{i}]"); al.append(f"[a{i}]")
    fc.append("".join(v + a for v, a in zip(vl, al)) + f"concat=n={len(segs)}:v=1:a=1[v][a]")
    tmp = out.replace(".mp4", "_tmp.mp4")
    r = run(["ffmpeg", "-y", "-loglevel", "error", "-i", MASTER, "-filter_complex", ";".join(fc), "-map", "[v]", "-map", "[a]",
             "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-r", "60",
             "-c:a", "pcm_s24le", "-t", f"{total:.6f}", tmp.replace(".mp4", ".mov")])
    assert r.returncode == 0, r.stderr
    src = tmp.replace(".mp4", ".mov")
    m = run(["ffmpeg", "-hide_banner", "-i", src, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]).stderr
    j = json.loads(m[m.rfind("{"):m.rfind("}") + 1])
    ln = (f"loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={j['input_i']}:measured_TP={j['input_tp']}:measured_LRA={j['input_lra']}"
          f":measured_thresh={j['input_thresh']}:offset={j['target_offset']}:linear=true")
    r = run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-c:v", "copy", "-af", ln + ",aresample=48000", "-c:a", "aac", "-b:a", "320k",
             "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-t", f"{total:.6f}", out])
    assert r.returncode == 0, r.stderr
    print("wrote", out, total, "s")
