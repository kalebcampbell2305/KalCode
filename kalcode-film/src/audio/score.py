"""Original KalCode launch score: 120 BPM, 4/4, 30 bars, E minor resolving to E major.

Sonic mnemonic: B4 - E5 - F#5 - B5 (a rising fourth, a step, a rising fourth) on the
16th-note grid 0 . . 3 . . 6 . 8, voiced on an FM bell. It opens the product reveal,
answers each agent launch one note at a time, climbs the release pipeline and resolves
the end card over E major (add9).

All section boundaries and hits are read from cue_sheet.json; nothing is eyeballed.
"""

from __future__ import annotations

import numpy as np

import instruments as I
from dsp import BAR_N, BEAT_N, SIXTEENTH_N, SR, TOTAL_N, convolve, db, filt, make_ir, pan, pingpong, place, stereo

MOTIF = [71, 76, 78, 83]  # B4 E5 F#5 B5
MOTIF_STEPS = [0, 3, 6, 8]  # 16ths

# i - VI - III - VII in E minor, one chord per bar: Em9, Cmaj7(#11), G6/9, D6/F#
PROG = [
    {"bass": 40, "pad": [55, 59, 62, 66]},
    {"bass": 36, "pad": [52, 55, 59, 66]},
    {"bass": 43, "pad": [59, 62, 64, 69]},
    {"bass": 42, "pad": [57, 62, 64, 66]},
]
FINAL = {"bass": 40, "pad": [52, 59, 64, 66, 68, 71]}  # E major add9: the resolution


class Score:
    def __init__(self, cue: dict):
        self.cue = cue
        self.ev = {e["id"]: e for e in cue["events"]}
        self.sc = {s["id"]: s for s in cue["scenes"]}
        self.st = {k: stereo(TOTAL_N) for k in ["drums", "bass", "pads", "keys", "logo", "fx", "ui"]}

    # helpers
    def s(self, t: float) -> int:
        return int(round(t * SR))

    def scene(self, sid: str) -> tuple[float, float]:
        s = self.sc[sid]
        return s["start"]["t"], s["end"]["t"]

    def at(self, eid: str) -> float:
        return self.ev[eid]["t"]

    def bars(self, t0: float, t1: float):
        b = int(round(t0 * SR / BAR_N))
        while b * BAR_N < int(round(t1 * SR)):
            yield b
            b += 1

    # ------------------------------------------------------------- sections

    def chaos(self):
        t0, t1 = self.scene("chaos")
        cut = self.at("collapse.start")  # everything accelerates inward
        silent = self.at("silence")
        # Fragmented rhythm: 3-against-4 ticks that thicken as windows stack.
        for k in range(int((silent - t0) / 0.125)):
            t = t0 + k * 0.125
            dens = (t - t0) / (silent - t0)
            if k % 3 == 0 or (dens > 0.45 and k % 2 == 0) or dens > 0.8:
                place(self.st["drums"], pan(I.tick(2600 + 900 * (k % 5), seed=100 + k), ((k * 7) % 5 - 2) / 3),
                      self.s(t), 0.5 + 0.7 * dens)
        # Low pulse on the half-beat, pitch E1 with a tense F against it.
        for k in range(int((cut - t0) / 0.5)):
            t = t0 + k * 0.5
            place(self.st["bass"], I.bass(28, 0.22, cutoff=260, sub=1.0), self.s(t), 0.55 + 0.25 * (t / cut))
        drone = I.pad([40, 41, 52, 53], cut - t0 + 0.2, attack=2.5, release=0.2, cutoff=900, seed=7)
        place(self.st["pads"], drone[:, : self.s(silent - t0)], self.s(t0), 0.75)
        # Each window that appears gets a detuned pop.
        for i, e in enumerate(x for x in self.cue["events"] if x["id"].startswith("chaos.window")):
            place(self.st["ui"], pan(I.window_pop(64 + (i * 5) % 17, seed=200 + i), ((i * 3) % 7 - 3) / 4), e["sample"], 0.75)
        # Accelerate inward, then half a beat of silence before the hit.
        sw = I.reverse_swell(silent - cut, [52, 59, 64, 71])
        place(self.st["fx"], sw, self.s(cut), 0.9)
        rs = I.noise_riser(silent - t0 - 1.0, 300, 7000, seed=33)
        place(self.st["fx"], rs, self.s(t0 + 1.0), 0.55)

    def motif(self, t: float, stem: str = "logo", gain: float = 1.0, octave: int = 0, dur: float = 2.6, notes=None):
        for m, step in zip(notes or MOTIF, MOTIF_STEPS):
            b = I.bell(m + 12 * octave, dur if step == 8 else dur * 0.6)
            place(self.st[stem], pan(b, -0.15 + 0.1 * step / 8), self.s(t) + step * SIXTEENTH_N, gain)

    def introduce(self):
        t0, t1 = self.scene("introduce")
        hit = self.at("hit.product")
        place(self.st["fx"], I.ship_impact(), self.s(hit), 0.8)
        place(self.st["drums"], I.kick(1.2, 0.5), self.s(hit), 0.9)
        self.motif(hit, gain=1.0)
        p = I.pad(PROG[0]["pad"] + [71], t1 - hit, attack=0.9, release=0.8, cutoff=2600)
        place(self.st["pads"], p, self.s(hit), 0.8)
        place(self.st["bass"], I.bass(28, t1 - hit - 0.2, cutoff=180, sub=1.0), self.s(hit), 0.5)
        # Soft pulse re-enters on bar 5 so the push into the workspace has motion.
        for k in range(8):
            place(self.st["keys"], pan(I.pluck(64 + [0, 7, 12, 7][k % 4], 0.25, 0.5), 0.3 * (-1) ** k),
                  self.s(t0 + 2.0) + k * BEAT_N // 2, 0.25 + 0.03 * k)
        place(self.st["fx"], I.noise_riser(1.5, 500, 8000, seed=34), self.s(t1 - 1.5), 0.35)

    def groove(self, t0: float, t1: float, level: float = 1.0, hats: bool = True, snare: bool = True,
               arps: int = 1, bass_pattern: str = "eighths", cutoff: float = 2600):
        for b in self.bars(t0, t1):
            ch = PROG[b % 4]
            bs = b * BAR_N
            for beat in range(4):
                place(self.st["drums"], I.kick(1.0), bs + beat * BEAT_N, 0.85 * level)
                if snare and beat in (1, 3):
                    place(self.st["drums"], I.clap(seed=b * 4 + beat), bs + beat * BEAT_N, 0.42 * level)
            if hats:
                for k in range(16):
                    g = 0.28 if k % 4 == 2 else 0.14
                    place(self.st["drums"], pan(I.hat(k % 8 == 6, seed=b * 16 + k), 0.25), bs + k * SIXTEENTH_N, g * level)
            if bass_pattern == "eighths":
                for k in range(8):
                    if k % 8 in (0, 3, 4, 6, 7) or level > 1.05:
                        oct_ = 12 if k in (3, 7) else 0
                        place(self.st["bass"], I.bass(ch["bass"] + oct_, 0.22, cutoff=480 + 200 * level),
                              bs + k * 2 * SIXTEENTH_N, 0.62)
            elif bass_pattern == "syncopated":
                for k in (0, 3, 6, 10, 11, 14):
                    place(self.st["bass"], I.bass(ch["bass"] + (12 if k in (6, 14) else 0), 0.18, cutoff=620),
                          bs + k * SIXTEENTH_N, 0.62)
            p = I.pad(ch["pad"], 2.0 - 0.05, attack=0.08, release=0.3, cutoff=cutoff)
            place(self.st["pads"], p, bs, 0.42 * level)
            # interlocking arps: each additional layer is one more lane of work
            arp_sets = [
                ([0, 1, 2, 3, 2, 1, 2, 3], 2, 0.0),     # 8ths, chord tones
                ([3, 2, 0, 1, 3, 0, 2, 1], 1, 0.4),     # 16ths
                ([0, 2, 1, 3, 1], 3, -0.4),             # 5-step dotted 8ths (polymeter)
                ([2, 3], 4, 0.6),                        # quarters high
                ([1, 0, 3], 2, -0.6),                    # 3-step 8ths
                ([3, 1, 2, 0, 3, 2], 1, 0.2),           # 16ths low register
            ]
            for li in range(min(arps, len(arp_sets))):
                seq, step16, pn = arp_sets[li]
                oct_ = [12, 12, 24, 24, 0, 0][li]
                for k in range(0, 16, step16):
                    idx = seq[(k // step16 + b * 3) % len(seq)]
                    m = ch["pad"][idx] + oct_
                    place(self.st["keys"], pan(I.pluck(m, 0.18 if step16 == 1 else 0.3, 0.7 + 0.1 * li, seed=li), pn),
                          bs + k * SIXTEENTH_N, [0.3, 0.2, 0.22, 0.16, 0.2, 0.16][li] * level)

    def workspace_providers(self):
        t0, _ = self.scene("workspace")
        _, t1 = self.scene("providers")
        self.groove(t0, self.scene("workspace")[1], level=0.8, hats=True, snare=False, arps=1, cutoff=2200)
        self.groove(self.scene("providers")[0], t1, level=0.95, arps=2, cutoff=2600)

    def swarm(self):
        t0, t1 = self.scene("swarm")
        par = self.at("copy.parallel")
        # layers enter with the lanes (one arp per launched lane)
        launches = [e for e in self.cue["events"] if e["id"].startswith("swarm.launch")]
        for b in self.bars(t0, par):
            bt = b * BAR_N / SR
            n = sum(1 for e in launches if e["t"] <= bt + 1.0)
            self.groove(bt, bt + 2.0, level=1.0 + 0.02 * n, arps=max(1, n), cutoff=2600 + 250 * n)
        for i, e in enumerate(launches):
            place(self.st["logo"], pan(I.agent_launch(MOTIF[i % 4] + 12, seed=300 + i), (i - 2.5) / 3), e["sample"], 0.42)
        # "Parallel." hit, then a one-bar lift with a snare roll into the drop.
        place(self.st["drums"], I.kick(1.3, 0.45), self.s(par), 1.0)
        place(self.st["fx"], I.sub_boom(1.6, 64, 36), self.s(par), 0.6)
        self.groove(par, t1 - 0.5, level=1.15, arps=6, cutoff=4200)
        for k in range(12):
            place(self.st["drums"], I.snare(seed=400 + k), self.s(par + 0.5) + k * SIXTEENTH_N + (k // 8) * SIXTEENTH_N,
                  0.12 + 0.03 * k)
        place(self.st["fx"], I.noise_riser(1.9, 500, 11000, seed=35), self.s(par), 0.55)
        # 1/4 beat of air before the KalVoice drop

    def kalvoice(self):
        t0, t1 = self.scene("kalvoice")
        # Hero transition: sub impact, then a half-time, spacious groove under the voice moment.
        place(self.st["fx"], I.sub_boom(2.2, 60, 33), self.s(t0), 0.75)
        place(self.st["drums"], I.kick(1.2, 0.5), self.s(t0), 0.95)
        self.motif(t0, gain=0.55, octave=0)
        for b in self.bars(t0, t1):
            ch = PROG[b % 4]
            bs = b * BAR_N
            place(self.st["drums"], I.kick(0.8, 0.4), bs, 0.7)
            place(self.st["drums"], I.kick(0.7, 0.35), bs + 10 * SIXTEENTH_N, 0.45)
            place(self.st["drums"], I.clap(seed=b), bs + 2 * BEAT_N, 0.3)
            for k in range(0, 16, 2):
                place(self.st["drums"], pan(I.hat(False, seed=500 + b * 8 + k), -0.2), bs + k * SIXTEENTH_N, 0.09)
            place(self.st["bass"], I.bass(ch["bass"], 1.9, cutoff=260, sub=1.0), bs, 0.55)
            place(self.st["pads"], I.pad(ch["pad"] + [ch["pad"][0] + 12], 2.0, attack=0.5, release=0.8, cutoff=1800), bs, 0.55)
        # the listening voice: sparse bell echoes while the waveform moves
        a, b = self.at("voice.press"), self.at("voice.release")
        k = 0
        t = a + 0.5
        while t < b:
            place(self.st["keys"], pan(I.bell(MOTIF[k % 4] + 12, 0.8, index=0.7), 0.5 * (-1) ** k), self.s(t), 0.12)
            t += 0.75
            k += 1

    def build_loop(self):
        t0, t1 = self.scene("buildloop")
        self.groove(t0, t1, level=1.0, arps=3, bass_pattern="syncopated", cutoff=3000)

    def pipeline(self):
        t0, t1 = self.scene("pipeline")
        ship = self.at("hit.ship")
        stages = [e for e in self.cue["events"] if e["id"].startswith("pipe.stage")]
        self.groove(t0, ship, level=1.15, arps=6, cutoff=3600)
        # the motif climbs one note per passing gate
        for i, e in enumerate(stages):
            place(self.st["logo"], pan(I.bell(MOTIF[i % 4] + 12 * (i // 4), 1.1, index=1.6), (i - 3) / 4), e["sample"], 0.34)
        place(self.st["fx"], I.rising_pulse(ship - stages[0]["t"], 52, 76, 6.0), stages[0]["sample"], 0.35)
        place(self.st["fx"], I.noise_riser(1.9, 400, 12000, seed=36), self.s(ship - 1.9), 0.5)
        # SHIP: large, controlled.
        place(self.st["fx"], I.ship_impact(), self.s(ship), 1.0)
        place(self.st["drums"], I.kick(1.4, 0.6), self.s(ship), 1.0)
        self.motif(ship, gain=0.8, octave=0)
        self.groove(ship + 0.0, t1, level=1.2, arps=4, cutoff=4800, hats=True)

    def selfhost(self):
        t0, t1 = self.scene("selfhost")
        # emotional pullback: drums out, low-passed pad, motif softly an octave down
        for b in self.bars(t0, t1):
            ch = PROG[b % 4]
            place(self.st["pads"], I.pad(ch["pad"], 2.0, attack=0.4, release=1.2, cutoff=1400, seed=b), b * BAR_N, 0.62)
            place(self.st["bass"], I.bass(ch["bass"] - 12, 1.9, cutoff=160, sub=1.0), b * BAR_N, 0.45)
        self.motif(t0 + 0.5, stem="keys", gain=0.4, octave=-1, dur=2.0)
        place(self.st["fx"], I.whoosh(1.2, up=False, seed=48), self.s(t0 - 0.2), 0.4)

    def endcard(self):
        t0, t1 = self.scene("endcard")
        logo = self.at("end.logo")
        place(self.st["fx"], I.whoosh(0.9, up=True, seed=49), self.s(t0 + 0.1), 0.5)
        place(self.st["fx"], I.reverse_swell(logo - t0, [52, 59, 64, 71], seed=50), self.s(t0), 0.45)
        # full sonic identity: bell motif, doubled an octave up, over E major add9
        self.motif(logo, gain=1.0, dur=3.2)
        self.motif(logo, gain=0.35, octave=1, dur=2.4)
        place(self.st["drums"], I.kick(1.1, 0.6), self.s(logo), 0.8)
        place(self.st["fx"], I.sub_boom(3.0, 55, 32), self.s(logo), 0.6)
        tail = t1 - logo
        place(self.st["pads"], I.pad(FINAL["pad"], tail - 1.2, attack=0.25, release=1.1, cutoff=3200, seed=60),
              self.s(logo), 0.75)
        place(self.st["bass"], I.bass(FINAL["bass"] - 12, tail - 1.4, cutoff=140, sub=1.0), self.s(logo), 0.5)
        # a last, quiet confirmation on the CTA
        cta = self.at("end.cta")
        place(self.st["logo"], I.test_pass(83), self.s(cta), 0.25)

    # ---------------------------------------------------------------- build

    def build(self) -> dict[str, np.ndarray]:
        self.chaos()
        self.introduce()
        self.workspace_providers()
        self.swarm()
        self.kalvoice()
        self.build_loop()
        self.pipeline()
        self.selfhost()
        self.endcard()
        return self.st


def mix(stems: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    out = {}
    room = make_ir(2.2, 1.6, 0.012, 5200, stream=900, width=1.0)
    hall = make_ir(3.6, 2.8, 0.02, 4200, stream=901, width=1.2)
    for k, x in stems.items():
        y = x.copy()
        if k == "drums":
            y = filt(y, "hp", 30)
            y = y + 0.08 * convolve(y, room)
        elif k == "bass":
            y = filt(filt(y, "hp", 32, 0.7), "lp", 5000)
        elif k == "pads":
            y = filt(y, "hp", 140, 0.6)  # keep lows for bass + kick only
            y = y + 0.28 * convolve(y, hall)
        elif k == "keys":
            y = filt(y, "hp", 200)
            y = y + 0.35 * pingpong(y, 3 * SIXTEENTH_N, 0.42, 5, 5000) + 0.2 * convolve(y, hall)
        elif k == "logo":
            y = filt(y, "hp", 180)
            y = y + 0.3 * pingpong(y, 3 * SIXTEENTH_N, 0.38, 4, 6000) + 0.35 * convolve(y, hall)
        elif k == "fx":
            y = filt(y, "hp", 22)
            y = y + 0.12 * convolve(y, hall)
        elif k == "ui":
            y = filt(y, "hp", 120)
            y = y + 0.12 * convolve(y, room)
        out[k] = y * {"drums": db(0), "bass": db(-1), "pads": db(-3), "keys": db(-2), "logo": db(-1), "fx": db(-3),
                      "ui": db(-4)}[k]
    return out
