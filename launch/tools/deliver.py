"""Encode deliverables from render/film/####.png + audio/film_mix.wav.

  python tools/deliver.py            -> out/KalCode_Launch_60s_1080p60.mp4, _vertical, _30s, _15s
All cut points sit on the 120 BPM beat grid (30 frames), so music stays on the beat.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
L = os.path.dirname(HERE)
FR = os.path.join(L, "render", "film", "%04d.png")
WAV = os.path.join(L, "audio", "film_mix.wav")
OUT = os.path.join(L, "out")
os.makedirs(OUT, exist_ok=True)
BR = os.path.join(L, "..", "assets", "branding", "kalcode-wordmark.png")
FONT = os.path.join(L, "assets", "fonts", "lexend-deca-400.ttf").replace("\\", "/").replace(":", "\\:")
X264 = ["-c:v", "libx264", "-preset", "slow", "-crf", "15", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+faststart"]
AAC = ["-c:a", "aac", "-b:a", "320k", "-ar", "48000"]
MASTER_AF = "loudnorm=I=-14:TP=-1.0:LRA=9"


def run(cmd):
    print(" ".join(cmd[:6]), "...")
    subprocess.run(cmd, check=True)


def master():
    out = os.path.join(OUT, "KalCode_Launch_60s_1080p60.mp4")
    run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "60", "-i", FR, "-i", WAV, *X264, *AAC, "-af", MASTER_AF,
         "-t", "60", "-map", "0:v", "-map", "1:a", out])
    return out


def cut(name, segments, src):
    """segments: [(f0, f1)] frame ranges of the master, joined with 2-frame audio crossfades."""
    parts = []
    fc = []
    for i, (a, b) in enumerate(segments):
        fc.append(f"[0:v]trim=start_frame={a}:end_frame={b},setpts=PTS-STARTPTS[v{i}]")
        fc.append(f"[0:a]atrim=start={a/60}:end={b/60},asetpts=PTS-STARTPTS,afade=t=in:d=0.02,afade=t=out:st={(b-a)/60-0.03}:d=0.03[a{i}]")
        parts.append(f"[v{i}][a{i}]")
    total = sum(b - a for a, b in segments) / 60
    fc.append("".join(parts) + f"concat=n={len(segments)}:v=1:a=1[v][ar]")
    fc.append(f"[ar]afade=t=out:st={total-0.6}:d=0.6[a]")
    out = os.path.join(OUT, name)
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-filter_complex", ";".join(fc), "-map", "[v]", "-map", "[a]",
         *X264, *AAC, out])
    return out


def vertical(src, name="KalCode_Launch_60s_vertical_1080x1920.mp4"):
    """1080x1920: the master framed in the middle over a soft, darkened blow-up of itself,
    KalCode wordmark above and the site below."""
    fc = (
        "[0:v]split[a][b];"
        "[a]scale=3413:1920,crop=1080:1920,gblur=sigma=40,eq=brightness=-0.18:saturation=0.8[bg];"
        "[b]scale=1080:608:flags=lanczos[fg];"
        "[bg][fg]overlay=0:656[m];"
        "[1:v]scale=520:-1,format=rgba,colorchannelmixer=aa=0.92[w];"
        "[m][w]overlay=(W-w)/2:380[m2];"
        f"[m2]drawtext=fontfile='{FONT}':text='kalcoded.com':fontcolor=0xA8B4C9:fontsize=40:x=(w-tw)/2:y=1420[v]"
    )
    out = os.path.join(OUT, name)
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-loop", "1", "-i", BR, "-filter_complex", fc,
         "-map", "[v]", "-map", "0:a", "-shortest", *X264, "-c:a", "copy", out])
    return out


if __name__ == "__main__":
    what = sys.argv[1:] or ["master", "cuts", "vertical"]
    src = os.path.join(OUT, "KalCode_Launch_60s_1080p60.mp4")
    if "master" in what:
        src = master()
    if "cuts" in what:
        cut("KalCode_Launch_30s_1080p60.mp4",
            [(0, 660), (1200, 1410), (1710, 1980), (2100, 2400), (2520, 2640), (3360, 3600)], src)
        cut("KalCode_Launch_15s_1080p60.mp4",
            [(150, 480), (1710, 1980), (2520, 2640), (3360, 3540)], src)
    if "vertical" in what:
        vertical(src)
        vertical(os.path.join(OUT, "KalCode_Launch_30s_1080p60.mp4"), "KalCode_Launch_30s_vertical_1080x1920.mp4")
    print("delivered to", OUT)
