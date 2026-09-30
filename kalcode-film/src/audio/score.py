"""Original KalCode launch score (high-energy cut): 120 BPM, 4/4, 30 bars, E minor to E major.

Sonic mnemonic: B4 - E5 - F#5 - B5 on the 16th grid 0 . . 3 . . 6 . 8. It is the supersaw
hook of every drop, the bell on the product hit, one note per agent launch, one note per
release gate, and the full resolution on the end card.

Rhythm is NOT defined here: kicks, claps, hats, snare rolls and impacts come from the
"drums", "rolls" and "impacts" blocks of cue_sheet.json, which the picture also reads
(camera punches, light flashes, cuts). Sidechain pumping is derived from the same kicks.
"""

from __future__ import annotations

import numpy as np

import instruments as I
from dsp import (SIXTEENTH_N, SR, TOTAL_N, convolve, db, filt, make_ir, midi_hz, pan, pingpong, place, rng, saw,
                 stereo)

MOTIF = [71, 76, 78, 83]  # B4 E5 F#5 B5
MOTIF_STEPS = [0, 3, 6, 8]  # 16ths

PROG = [  # i - VI - III - VII: Em9, Cmaj7(#11), G6/9, D6/F#
    {"bass": 40, "pad": [55, 59, 62, 66], "shift": 0},
    {"bass": 36, "pad": [52, 55, 59, 66], "shift": -4},
    {"bass": 43, "pad": [59, 62, 64, 69], "shift": 3},
    {"bass": 42, "pad": [57, 62, 64, 66], "shift": 2},
]
FINAL = {"bass": 40, "pad": [52, 59, 64, 66, 68, 71]}  # E major add9

# the hook: the mnemonic stretched across a bar and answered (16th step, midi, length in 16ths)
HOOK = [(0, 71, 2), (3, 76, 2), (6, 78, 2), (8, 83, 4), (12, 81, 2), (14, 78, 2)]


def kick_times(cue: dict) -> list[float]:
    """Kick onsets from cue_sheet.json 'drums' (mirrored by src/components/beat.ts)."""
    out = []
    for d in cue["drums"]:
        step = 0.5 if d["kick"] == "four" else 1.0
        t = d["start"]
        while t < d["end"] - 1e-9:
            out.append(round(t, 6))
            t += step
    return out


def clap_times(cue: dict) -> list[float]:
    out = []
    for d in cue["drums"]:
        if not d["clap"]:
            continue
        t = d["start"]
        while t < d["end"] - 1e-9:
            if round(t / 0.5) % 2 == 1:
                out.append(round(t, 6))
            t += 0.5
    return out


def supersaw(m: float, dur: float, cutoff: float = 5200, voices: int = 7, detune: float = 0.18, seed: int = 0) -> np.ndarray:
    n = int((dur + 0.25) * SR)
    g = rng(700 + int(seed))
    out = np.zeros((2, n))
    half = (voices - 1) / 2
    for v in range(voices):
        cents = (v - half) * detune * 12
        x = saw(midi_hz(m) * 2 ** (cents / 1200), n, g.random())
        out += pan(x, (v - half) / half * 0.9)
    t = np.arange(n) / SR
    env = np.minimum(t / 0.006, 1) * np.where(t < dur, 1.0, np.exp(-(t - dur) / 0.08))
    env *= 0.75 + 0.25 * np.exp(-t / 0.15)
    out = filt(out * env, "lp", cutoff, 0.8)
    return out / voices * 1.6


def crash(seed: int = 71) -> np.ndarray:
    n = int(2.2 * SR)
    nz = rng(seed).standard_normal((2, n))
    t = np.arange(n) / SR
    metal = sum(np.sign(np.sin(2 * np.pi * f * 3.1 * t)) for f in [340.0, 511.0, 777.0, 1043.0, 1521.0]) / 5
    x = filt(0.7 * nz + 0.4 * metal, "hp", 4000)
    return x * np.exp(-t / 0.55) * np.minimum(t / 0.002, 1) * 0.5


class Score:
    def __init__(self, cue: dict):
        self.cue = cue
        self.ev = {e["id"]: e for e in cue["events"]}
        self.sc = {s["id"]: s for s in cue["scenes"]}
        self.st = {k: stereo(TOTAL_N) for k in ["drums", "bass", "pads", "keys", "lead", "logo", "fx", "ui"]}
        self.kicks = kick_times(cue)

    def s(self, t: float) -> int:
        return int(round(t * SR))

    def at(self, eid: str) -> float:
        return self.ev[eid]["t"]

    def scene(self, sid: str) -> tuple[float, float]:
        s = self.sc[sid]
        return s["start"]["t"], s["end"]["t"]

    def chord(self, t: float) -> dict:
        return PROG[int(t // 2.0) % 4]

    def motif(self, t: float, stem: str = "logo", gain: float = 1.0, octave: int = 0, dur: float = 2.6):
        for m, step in zip(MOTIF, MOTIF_STEPS):
            b = I.bell(m + 12 * octave, dur if step == 8 else dur * 0.6)
            place(self.st[stem], pan(b, -0.15 + 0.1 * step / 8), self.s(t) + step * SIXTEENTH_N, gain)

    # ---------------------------------------------------------- rhythm (from the cue sheet)

    def drums(self):
        for t in self.kicks:
            place(self.st["drums"], I.kick(1.25, 0.34), self.s(t), 1.0)
        for t in clap_times(self.cue):
            place(self.st["drums"], I.clap(seed=int(t * 8)), self.s(t), 0.62)
            place(self.st["drums"], I.snare(seed=int(t * 8) + 1), self.s(t), 0.25)
        for d in self.cue["drums"]:
            if not d["hats"]:
                continue
            t = d["start"]
            k = 0
            while t < d["end"] - 1e-9:
                off = k % 4 == 2  # the offbeat 8th
                place(self.st["drums"], pan(I.hat(off and k % 8 == 2, seed=int(t * 16)), 0.25 if k % 2 else -0.15),
                      self.s(t), 0.34 if off else 0.16 + 0.05 * (k % 2 == 0))
                t += 0.125
                k += 1
        for r in self.cue["rolls"]:
            t = r["start"]
            span = r["end"] - r["start"]
            while t < r["end"] - 1e-9:
                u = (t - r["start"]) / span
                rate = r["rate0"] * (r["rate1"] / r["rate0"]) ** u  # hits per beat, accelerating
                place(self.st["drums"], pan(I.snare(seed=int(t * 64)), 0.1 * np.sin(t * 7)), self.s(t), 0.18 + 0.42 * u)
                t += 0.5 / rate
        for t in self.cue["impacts"]:
            place(self.st["fx"], I.ship_impact(seed=int(t * 10)), self.s(t), 0.5)
            place(self.st["drums"], crash(seed=int(t * 10)), self.s(t), 0.5)

    def sidechain(self) -> np.ndarray:
        """Pump envelope from the kicks: duck to 30 %, recover over ~180 ms."""
        env = np.ones(TOTAL_N)
        rel = int(0.18 * SR)
        shape = 1 - 0.7 * np.exp(-np.arange(rel) / (0.06 * SR))
        a = int(0.004 * SR)
        shape[:a] = np.linspace(1, shape[a], a)
        for t in self.kicks:
            i = self.s(t)
            n = min(rel, TOTAL_N - i)
            env[i:i + n] = np.minimum(env[i:i + n], shape[:n])
        return env

    # ------------------------------------------------------------------ music parts

    def bassline(self, t0: float, t1: float, style: str = "roll", gain: float = 0.62):
        t = t0
        while t < t1 - 1e-9:
            ch = self.chord(t)
            step = int(round((t % 2.0) / 0.125))  # 16th inside the bar
            if style == "roll":  # rolling offbeat 16ths
                if step % 4 != 0:
                    place(self.st["bass"], I.bass(ch["bass"] + (12 if step in (6, 14) else 0), 0.11, cutoff=900, sub=0.9),
                          self.s(t), gain)
            elif style == "drop":
                if step % 2 == 1 or step in (0, 8):
                    place(self.st["bass"], I.bass(ch["bass"] + (12 if step in (3, 11, 15) else 0), 0.12, cutoff=1300, sub=1.0),
                          self.s(t), gain * 1.1)
            elif style == "half":
                if step in (0, 10):
                    place(self.st["bass"], I.bass(ch["bass"], 0.7, cutoff=400, sub=1.0), self.s(t), gain)
            t += 0.125

    def pads(self, t0: float, t1: float, gain: float = 0.45, cutoff: float = 3200):
        t = t0
        while t < t1 - 1e-9:
            ch = self.chord(t)
            p = I.pad(ch["pad"] + [ch["pad"][0] + 12], 2.0, attack=0.05, release=0.25, cutoff=cutoff, seed=int(t))
            place(self.st["pads"], p, self.s(t), gain)
            t += 2.0

    def arps(self, t0: float, t1: float, layers: int = 2, gain: float = 1.0):
        seqs = [([0, 1, 2, 3, 2, 1, 2, 3], 2, 0.0, 12), ([3, 2, 0, 1, 3, 0, 2, 1], 1, 0.35, 24),
                ([0, 2, 1, 3, 1], 3, -0.4, 24), ([1, 0, 3], 2, -0.6, 12)]
        t = t0
        k = 0
        while t < t1 - 1e-9:
            ch = self.chord(t)
            for li in range(min(layers, len(seqs))):
                seq, step, pn, octv = seqs[li]
                if k % step == 0:
                    m = ch["pad"][seq[(k // step) % len(seq)]] + octv
                    place(self.st["keys"], pan(I.pluck(m, 0.16, 0.9, seed=li), pn), self.s(t), [0.26, 0.18, 0.18, 0.16][li] * gain)
            t += 0.125
            k += 1

    def hook(self, t0: float, t1: float, gain: float = 0.5):
        """Supersaw hook built from the mnemonic, one statement per bar, following the harmony."""
        t = t0
        while t < t1 - 1e-9:
            shift = self.chord(t)["shift"]
            for step, m, length in HOOK:
                place(self.st["lead"], supersaw(m + shift, length * 0.125 * 0.92, seed=step), self.s(t) + step * SIXTEENTH_N, gain)
            t += 2.0

    # --------------------------------------------------------------------- sections

    def build(self) -> dict[str, np.ndarray]:
        self.drums()
        ev = self.cue["events"]

        # 0–6 CHAOS: a pop per window, a quickening pulse, drone, riser, half a beat of silence
        silent = self.at("silence")
        for i, e in enumerate(x for x in ev if x["id"].startswith("chaos.window")):
            place(self.st["ui"], pan(I.window_pop(64 + (i * 5) % 17, seed=200 + i), ((i * 3) % 7 - 3) / 4), e["sample"], 0.8)
        for k in range(int(silent / 0.25)):
            place(self.st["bass"], I.bass(28, 0.14, cutoff=240, sub=1.0), self.s(k * 0.25), 0.3 + 0.35 * (k * 0.25 / silent))
        drone = I.pad([40, 41, 52, 53, 64], silent, attack=3.0, release=0.02, cutoff=1400, seed=7)
        place(self.st["pads"], drone[:, : self.s(silent)], 0, 0.8)
        place(self.st["fx"], I.noise_riser(silent - 0.5, 300, 12000, seed=33), self.s(0.5), 0.9)
        col = self.at("collapse.start")
        place(self.st["fx"], I.reverse_swell(silent - col, [52, 59, 64, 71]), self.s(col), 1.0)

        # 6 PRODUCT HIT: sub, bell mnemonic, supersaw stab; 6–10 half-time rise
        hit = self.at("hit.product")
        place(self.st["fx"], I.sub_boom(2.6, 70, 32), self.s(hit), 1.0)
        self.motif(hit, gain=1.0)
        stab = supersaw(52, 1.4, cutoff=3000) + supersaw(59, 1.4, cutoff=3000) + supersaw(64, 1.4, cutoff=3000)
        place(self.st["lead"], stab, self.s(hit), 0.35)
        self.pads(hit, 10.0, gain=0.6, cutoff=2400)
        self.bassline(hit, 10.0, "half")
        self.arps(8.0, 10.0, layers=1, gain=0.8)
        place(self.st["fx"], I.noise_riser(2.0, 500, 12000, seed=34), self.s(8.0), 0.7)

        # 10–22 GROOVE: rolling bass, pads, arps; the hook enters with the providers
        self.bassline(10.0, 22.0, "roll")
        self.pads(10.0, 22.0, gain=0.42)
        self.arps(10.0, 22.0, layers=2)
        self.hook(16.0, 22.0, gain=0.3)

        # 22–30 SWARM: one mnemonic note and one arp layer per agent launch, build into "Parallel."
        launches = [e for e in ev if e["id"].startswith("swarm.launch")]
        for i, e in enumerate(launches):
            place(self.st["logo"], pan(I.agent_launch(MOTIF[i % 4] + 12, seed=300 + i), (i - 1.5) / 2), e["sample"], 0.55)
        for b in range(11, 14):
            bt = b * 2.0
            self.arps(bt, bt + 2.0, layers=max(2, sum(1 for e in launches if e["t"] <= bt + 1.0)))
        self.bassline(22.0, 28.0, "roll")
        self.pads(22.0, 28.0, gain=0.45)
        self.hook(22.0, 28.0, gain=0.38)
        par = self.at("copy.parallel")
        place(self.st["fx"], I.sub_boom(1.8, 72, 34), self.s(par), 1.0)
        place(self.st["lead"], supersaw(64, 0.9, cutoff=6000) + supersaw(71, 0.9, cutoff=6000), self.s(par), 0.45)
        self.arps(par, 29.75, layers=4, gain=1.1)
        place(self.st["fx"], I.noise_riser(1.75, 600, 14000, seed=35), self.s(par), 0.9)

        # 30–36 DROP (KalVoice): full energy, the hook in front; the mic tones ride on top
        place(self.st["fx"], I.sub_boom(2.2, 75, 33), self.s(self.at("hit.voice")), 1.0)
        self.bassline(30.0, 36.0, "drop")
        self.pads(30.0, 36.0, gain=0.5, cutoff=4200)
        self.hook(30.0, 36.0, gain=0.55)
        self.arps(30.0, 36.0, layers=2, gain=0.8)

        # 36–42 BUILD LOOP
        self.bassline(36.0, 42.0, "roll")
        self.pads(36.0, 42.0, gain=0.45)
        self.arps(36.0, 42.0, layers=3)
        place(self.st["fx"], I.noise_riser(2.0, 500, 12000, seed=37), self.s(40.0), 0.6)

        # 42–48 PIPELINE: a mnemonic note per gate, rising pulse, riser, snare roll (cue)
        stages = [e for e in ev if e["id"].startswith("pipe.stage")]
        for i, e in enumerate(stages):
            place(self.st["logo"], pan(I.bell(MOTIF[i % 4] + 12 * (i // 4), 1.1, index=1.8), (i - 3) / 4), e["sample"], 0.5)
        self.bassline(42.0, 48.0, "drop")
        self.pads(42.0, 48.0, gain=0.5, cutoff=4200)
        self.arps(42.0, 48.0, layers=4)
        self.hook(44.0, 46.0, gain=0.4)
        place(self.st["fx"], I.rising_pulse(48.0 - stages[0]["t"], 52, 76, 6.0), stages[0]["sample"], 0.5)
        place(self.st["fx"], I.noise_riser(2.0, 400, 15000, seed=36), self.s(46.0), 0.95)

        # 48 SHIP: the biggest drop; 48–54 full energy through the beat-cut montage
        ship = self.at("hit.ship")
        place(self.st["fx"], I.ship_impact(), self.s(ship), 1.1)
        place(self.st["fx"], I.sub_boom(2.8, 80, 32), self.s(ship), 1.0)
        self.motif(ship, gain=0.9)
        self.bassline(48.0, 54.0, "drop")
        self.pads(48.0, 54.0, gain=0.55, cutoff=5200)
        self.hook(48.0, 54.0, gain=0.6)
        self.arps(48.0, 54.0, layers=3)
        for e in (x for x in ev if x["id"].startswith("montage.")):
            place(self.st["fx"], I.whoosh(0.25, up=True, seed=int(e["t"] * 10)), e["sample"] - int(0.12 * SR), 0.4)

        # 54–60 END: inward swell, the full sonic logo over E major, decay to silence at 60.000
        t0, t1 = self.scene("endcard")
        logo = self.at("end.logo")
        place(self.st["fx"], I.reverse_swell(logo - t0, [52, 59, 64, 71], seed=50), self.s(t0), 0.9)
        self.motif(logo, gain=1.0, dur=3.2)
        self.motif(logo, gain=0.4, octave=1, dur=2.4)
        chord = sum(supersaw(m, 2.2, cutoff=4000, seed=m) for m in [52, 59, 64, 68, 71])
        place(self.st["lead"], chord, self.s(logo), 0.3)
        place(self.st["fx"], I.sub_boom(3.2, 60, 32), self.s(logo), 0.9)
        place(self.st["pads"], I.pad(FINAL["pad"], t1 - logo - 1.3, attack=0.2, release=1.1, cutoff=3600, seed=60), self.s(logo), 0.8)
        place(self.st["bass"], I.bass(FINAL["bass"] - 12, t1 - logo - 1.5, cutoff=140, sub=1.0), self.s(logo), 0.55)
        place(self.st["logo"], I.test_pass(83), self.s(self.at("end.cta")), 0.3)

        # sidechain pump on everything tonal, derived from the same cue kicks
        sc = self.sidechain()
        for k in ("bass", "pads", "keys", "lead"):
            self.st[k] = self.st[k] * sc
        return self.st


def mix(stems: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    out = {}
    room = make_ir(2.0, 1.4, 0.012, 5200, stream=900, width=1.0)
    hall = make_ir(3.4, 2.6, 0.02, 4400, stream=901, width=1.2)
    gains = {"drums": 0, "bass": -1, "pads": -4, "keys": -3, "lead": -2, "logo": -1, "fx": -3, "ui": -5}
    for k, x in stems.items():
        y = x.copy()
        if k == "drums":
            y = filt(y, "hp", 28)
            y = y + 0.06 * convolve(y, room)
        elif k == "bass":
            y = filt(filt(y, "hp", 30, 0.7), "lp", 6000)
        elif k == "pads":
            y = filt(y, "hp", 160, 0.6)
            y = y + 0.25 * convolve(y, hall)
        elif k == "keys":
            y = filt(y, "hp", 220)
            y = y + 0.3 * pingpong(y, 3 * SIXTEENTH_N, 0.4, 5, 5000) + 0.15 * convolve(y, hall)
        elif k == "lead":
            y = filt(y, "hp", 180)
            y = y + 0.25 * pingpong(y, 3 * SIXTEENTH_N, 0.35, 4, 6500) + 0.2 * convolve(y, hall)
        elif k == "logo":
            y = filt(y, "hp", 180)
            y = y + 0.3 * pingpong(y, 3 * SIXTEENTH_N, 0.38, 4, 6000) + 0.35 * convolve(y, hall)
        elif k == "fx":
            y = filt(y, "hp", 22)
            y = y + 0.1 * convolve(y, hall)
        elif k == "ui":
            y = filt(y, "hp", 120)
            y = y + 0.1 * convolve(y, room)
        out[k] = y * db(gains[k])
    return out
