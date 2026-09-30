"""Measure delivered files (never copied numbers). python scripts/qa.py out/a.mp4 [out/b.mp4 ...]
Writes out/qa_report.json and QA.md; exits non-zero if any check fails."""
import json, re, subprocess, sys
from pathlib import Path

def run(*a):
    return subprocess.run(a, capture_output=True, text=True, encoding="utf-8", errors="replace")

def probe(f):
    j = json.loads(run("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", f).stdout)
    v = next(s for s in j["streams"] if s["codec_type"] == "video")
    a = next((s for s in j["streams"] if s["codec_type"] == "audio"), None)
    return j, v, a

def loud(f):
    e = run("ffmpeg", "-hide_banner", "-nostats", "-i", f, "-map", "0:a", "-af", "ebur128=peak=true", "-f", "null", "-").stderr
    tail = e[e.rfind("Summary:"):]
    I = float(re.search(r"I:\s+(-?[\d.]+) LUFS", tail).group(1))
    TP = float(re.search(r"Peak:\s+(-?[\d.]+) dBFS", tail).group(1))
    return I, TP

def frames(f):
    r = run("ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", f)
    return int(r.stdout.strip().split(",")[0])

def blank(f):
    e = run("ffmpeg", "-hide_banner", "-nostats", "-i", f, "-vf", "blackdetect=d=0.25:pix_th=0.02:pic_th=0.995", "-an", "-f", "null", "-").stderr
    return re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", e)

def decode_errors(f):
    return run("ffmpeg", "-v", "error", "-i", f, "-f", "null", "-").stderr.strip()

def atoms(f):
    b = Path(f).read_bytes()[:4096]
    return "moov-before-mdat" if b.find(b"moov") != -1 and (b.find(b"mdat") == -1 or b.find(b"moov") < b.find(b"mdat")) else "mdat-first"

checks, rows = [], []
for f in sys.argv[1:]:
    j, v, a = probe(f)
    dur = float(j["format"]["duration"])
    n = frames(f)
    fps = v["r_frame_rate"]
    exp = {"out/kalcode_launch_30s.mp4": 30, "out/kalcode_launch_15s.mp4": 15}.get(f.replace("\\", "/"), 60)
    W, H = int(v["width"]), int(v["height"])
    I, TP = loud(f)
    bl = blank(f)
    de = decode_errors(f)
    name = Path(f).name
    c = [
        ("H.264 High", v["codec_name"] == "h264" and v.get("profile") == "High", f'{v["codec_name"]} {v.get("profile")}'),
        ("yuv420p", v["pix_fmt"] == "yuv420p", v["pix_fmt"]),
        ("resolution", (W, H) in [(1920, 1080), (1080, 1920)], f"{W}x{H}"),
        ("60 fps", fps == "60/1", fps),
        (f"{exp}.00 s ± 1 frame", abs(n - exp * 60) <= 1 and abs(dur - exp) <= 1 / 60 + 1e-3, f"{n} frames, {dur:.3f} s"),
        ("AAC stereo 48 kHz", a is not None and a["codec_name"] == "aac" and int(a["channels"]) == 2 and a["sample_rate"] == "48000", f'{a and a["codec_name"]} {a and a["channels"]}ch {a and a["sample_rate"]}'),
        ("AAC ~320 kbps", a is not None and 300_000 <= int(a.get("bit_rate", 0)) <= 340_000, a and a.get("bit_rate")),
        ("-14 LUFS ± 1", abs(I + 14) <= 1, f"{I:.1f} LUFS"),
        ("true peak ≤ -1.0 dBTP", TP <= -1.0, f"{TP:.1f} dBTP"),
        ("+faststart", atoms(f) == "moov-before-mdat", atoms(f)),
        ("decodes cleanly", de == "", de[:120]),
        ("no blank frames (≥0.25 s black)", len(bl) == 0, str(bl)),
    ]
    for k, ok, d in c:
        checks.append({"file": name, "check": k, "pass": bool(ok), "detail": str(d)})
    rows.append({"file": name, "seconds": round(dur, 3), "frames": n, "video": f'{W}x{H} {v["codec_name"]} {v.get("profile")} {v["pix_fmt"]} {fps}', "audio": f'{a["codec_name"]} {a["sample_rate"]} Hz {a["channels"]}ch {int(a.get("bit_rate",0))//1000} kbps', "lufs": I, "truePeak": TP, "sizeMB": round(Path(f).stat().st_size / 1e6, 1)})

Path("out/qa_report.json").write_text(json.dumps({"files": rows, "checks": checks}, indent=1), encoding="utf-8")
md = ["# QA report (measured from the delivered files)", "", "| File | Check | Result | Measured |", "|---|---|---|---|"]
md += [f'| {c["file"]} | {c["check"]} | {"PASS" if c["pass"] else "FAIL"} | {c["detail"]} |' for c in checks]
md += ["", "| File | Duration | Frames | Video | Audio | Loudness | Size |", "|---|---|---|---|---|---|---|"]
md += [f'| {r["file"]} | {r["seconds"]} s | {r["frames"]} | {r["video"]} | {r["audio"]} | {r["lufs"]:.1f} LUFS, {r["truePeak"]:.1f} dBTP | {r["sizeMB"]} MB |' for r in rows]
Path("QA.md").write_text("\n".join(md) + "\n", encoding="utf-8")
bad = [c for c in checks if not c["pass"]]
print("\n".join(f'{"PASS" if c["pass"] else "FAIL"}  {c["file"]}: {c["check"]} — {c["detail"]}' for c in checks))
sys.exit(1 if bad else 0)
