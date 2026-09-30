"""Build the launch-film soundtrack from cue_sheet.json.

    python src/audio/build_audio.py

Writes audio/master.wav (48 kHz, 24-bit, exactly 60.000 s), audio/stems/*.wav,
audio/audio_report.json, out/audio_waveform.png, out/audio_spectrum.png.
Loudness: BS.1770-4 integrated -14 LUFS; true peak limited to -1.3 dBTP (4x oversampled).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

sys.path.insert(0, str(Path(__file__).parent))
import dsp  # noqa: E402
import instruments as I  # noqa: E402
import score  # noqa: E402
from dsp import SR, TOTAL_N, db, filt, lookahead_limiter, pan, place, true_peak  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CUE = json.loads((ROOT / "cue_sheet.json").read_text(encoding="utf-8"))
TARGET_LUFS = -14.0
CEILING_DBTP = -1.3


def k_weight(x):
    b1, a1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585]
    b2, a2 = [1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621]
    return signal.lfilter(b2, a2, signal.lfilter(b1, a1, x, axis=-1), axis=-1)


def integrated_lufs(x):
    y = k_weight(x)
    block, hop = int(0.4 * SR), int(0.1 * SR)
    ms = np.array([np.mean(y[:, i:i + block] ** 2, axis=1).sum() for i in range(0, y.shape[1] - block + 1, hop)])
    loud = -0.691 + 10 * np.log10(ms + 1e-15)
    gated = ms[loud > -70]
    rel = -0.691 + 10 * np.log10(gated.mean()) - 10
    final = gated[(-0.691 + 10 * np.log10(gated + 1e-15)) > rel]
    return float(-0.691 + 10 * np.log10(final.mean()))


SFX = {
    "pane_snap": lambda e, i: I.pane_snap(seed=600 + i),
    "key_texture": lambda e, i: I.key_texture(int(e.get("count", 18)), float(e.get("span", 1.0)), seed=700 + i),
    "mic_on": lambda e, i: I.mic_on(),
    "mic_off": lambda e, i: I.mic_off(),
    "air_sweep": lambda e, i: I.air_sweep(seed=800 + i),
    "test_pass": lambda e, i: I.test_pass(88 + (i % 3) * 2),
    "fail": lambda e, i: I.fail_blip(),
    "whoosh": lambda e, i: I.whoosh(float(e.get("span", 0.6)), up=e.get("dir", "up") == "up", seed=900 + i),
    "route": lambda e, i: I.agent_launch(88, seed=950 + i),
}
SFX_GAIN = {"pane_snap": 0.55, "key_texture": 0.22, "mic_on": 0.7, "mic_off": 0.5, "air_sweep": 0.6,
            "test_pass": 0.42, "fail": 0.5, "whoosh": 0.45, "route": 0.28}


def sound_design() -> np.ndarray:
    out = dsp.stereo(TOTAL_N)
    for i, e in enumerate(CUE["events"]):
        kind = e.get("sfx")
        if kind not in SFX:
            continue
        x = SFX[kind](e, i)
        if x.ndim == 1:
            x = pan(x, float(e.get("pan", 0.0)))
        place(out, x, e["sample"], SFX_GAIN[kind] * float(e.get("gain", 1.0)))
    return out


def main():
    print("score ...")
    sc = score.Score(CUE)
    stems = sc.build()
    stems["ui"] = stems["ui"] + sound_design()
    mixed = score.mix(stems)
    bus = sum(mixed.values())
    bus = filt(bus, "hp", 24, 0.6)
    # glue: slow RMS compression above -16 dBFS, 1.6:1
    env = np.sqrt(signal.lfilter([0.0015], [1, -0.9985], (bus ** 2).mean(axis=0)) + 1e-12)
    gr = np.minimum(0, (20 * np.log10(env) + 16) * (1 / 1.6 - 1))
    bus = bus * 10 ** (gr / 20)
    bus = filt(bus, "highshelf", 9000, 0.7, 1.0)

    gain = TARGET_LUFS - integrated_lufs(bus)
    for _ in range(8):
        master = lookahead_limiter(bus * db(gain), CEILING_DBTP)
        err = TARGET_LUFS - integrated_lufs(master)
        if abs(err) < 0.05:
            break
        gain += err
    # the final chord has decayed into the last 0.3 s; land on digital silence at 60.000
    n = int(0.3 * SR)
    master[:, -n:] *= np.linspace(1, 0, n) ** 2
    master[:, :64] *= np.linspace(0, 1, 64)
    assert master.shape[1] == TOTAL_N

    adir = ROOT / "audio"
    (adir / "stems").mkdir(parents=True, exist_ok=True)
    for name, x in mixed.items():
        sf.write(adir / "stems" / f"{name}.wav", (x * db(gain)).T.astype(np.float32), SR, subtype="FLOAT")
    sf.write(adir / "master.wav", master.T, SR, subtype="PCM_24")
    tp = 20 * np.log10(true_peak(master).max())
    report = {
        "sampleRate": SR, "samples": int(master.shape[1]), "seconds": master.shape[1] / SR,
        "integratedLUFS": round(integrated_lufs(master), 2), "truePeakDBTP": round(float(tp), 2),
        "samplePeakDBFS": round(float(20 * np.log10(np.abs(master).max())), 2),
        "clippedSamples": int((np.abs(master) >= 1.0).sum()), "masterGainDB": round(float(gain), 2),
        "seed": dsp.SEED,
    }
    (adir / "audio_report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps(report, indent=1))
    plots(master)


def plots(master):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    out = ROOT / "out"
    out.mkdir(exist_ok=True)
    bg, grid, fg, acc = "#05080f", "#1b2740", "#8593ab", "#4c8dff"
    t = np.arange(master.shape[1]) / SR
    fig, ax = plt.subplots(figsize=(16, 4.2), dpi=150, facecolor=bg)
    ax.set_facecolor(bg)
    step = 80
    mx = np.abs(master).max(axis=0)
    ax.fill_between(t[::step], -mx[::step], mx[::step], color=acc, linewidth=0)
    for b in range(31):
        ax.axvline(b * 2, color=grid, linewidth=0.6)
    for s in CUE["scenes"]:
        ax.axvline(s["start"]["t"], color="#e6edf8", linewidth=0.9, alpha=0.6)
        ax.text(s["start"]["t"] + 0.1, 1.03, s["id"], color=fg, fontsize=7)
    for e in CUE["events"]:
        if e["id"].startswith("hit."):
            ax.axvline(e["t"], color="#f2b544", linewidth=1.2)
    ax.set_xlim(0, 60)
    ax.set_ylim(-1.05, 1.13)
    ax.tick_params(colors=fg, labelsize=7)
    for sp in ax.spines.values():
        sp.set_color(grid)
    ax.set_xlabel("seconds (bar lines every 2 s at 120 BPM; amber = product and ship hits)", color=fg, fontsize=8)
    fig.tight_layout()
    fig.savefig(out / "audio_waveform.png", facecolor=bg)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(16, 5), dpi=150, facecolor=bg)
    f, tt, S = signal.spectrogram(master.mean(axis=0), SR, nperseg=4096, noverlap=3072)
    ax.pcolormesh(tt, f, 10 * np.log10(S + 1e-12), shading="auto", cmap="magma", vmin=-120, vmax=-30)
    ax.set_yscale("symlog", linthresh=100)
    ax.set_ylim(20, 20000)
    ax.set_xlim(0, 60)
    ax.tick_params(colors=fg, labelsize=7)
    ax.set_xlabel("seconds", color=fg, fontsize=8)
    ax.set_ylabel("Hz", color=fg, fontsize=8)
    fig.tight_layout()
    fig.savefig(out / "audio_spectrum.png", facecolor=bg)
    plt.close(fig)


if __name__ == "__main__":
    main()
