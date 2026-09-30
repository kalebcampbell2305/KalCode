"""Score + sound design for the 16 s proof, locked to proof.blend frames (60 fps)."""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synth import *  # noqa: E402,F403

HERE = os.path.dirname(os.path.abspath(__file__))
cues = json.load(open(os.path.join(HERE, "proof_cues.json")))
DUR = 16.0
m = Mix(DUR)
S = f2s
SIX = BEAT / 4

# ---------------------------------------------------------------- 1. chaos (0 - 4.85 s)
# driving A-minor pulse: bass 16ths with the filter opening, hats thickening, kick from bar 2
end_chaos = S(284)
t = 0.0
k = 0
while t < end_chaos:
    prog = t / end_chaos
    note = (45, 45, 57, 45, 45, 52, 45, 55)[k % 8] if prog < 0.6 else (45, 57, 45, 58, 45, 57, 60, 58)[k % 8]
    m.add("music", t, bass_note(note, SIX * 0.9, cutoff=260 + 2600 * prog ** 1.6, gain=0.26 + 0.1 * prog), pan=0.0)
    if k % 2 == 1 or prog > 0.45:
        m.add("drums", t, hat(), gain=0.35 + 0.4 * prog, pan=0.25 * np.sin(k))
    if t >= BEAT * 2 and k % 4 == 0:
        m.add("drums", t, kick(0.85))
    if prog > 0.5 and k % 8 == 4:
        m.add("drums", t, clap(), gain=0.55, send=0.25)
    t += SIX
    k += 1
# every window that pops in gets a small UI ping, pitched across the chord
ping_notes = (81, 84, 88, 86, 91, 93, 88)
for i, f in enumerate(sorted(cues["pop"])):
    m.add("sfx", S(f), tick(midi(ping_notes[i % len(ping_notes)]), 0.08, 0.16), pan=((i * 37) % 11 - 5) / 6, send=0.35)
for f in cues["flash"]:
    if f < 280:
        m.add("sfx", S(f), bell(96, 0.5, ratio=2, index=1.2, gain=0.05), pan=0.5, send=0.4)
# dissonant pad under the chaos, and the riser into the collapse
m.add("music", 0.0, pad([45, 52, 58, 63], end_chaos + 0.2, gain=0.1, attack=2.5, release=0.3, cutoff=1400), send=0.2)
m.add("sfx", S(150), riser(S(290) - S(150), 200, 11000, 0.3))
m.add("sfx", S(250), whoosh(S(291) - S(250), 300, 8000, 0.4, rev=True))

# ---------------------------------------------------------------- collapse + silence
m.add("drums", S(291), impact(1.5), gain=1.0, send=0.25)

# ---------------------------------------------------------------- 2. introducing
m.add("music", S(328), shimmer(4.0, 81, 0.05), send=0.6)                         # the line
m.add("sfx", S(328), whoosh(0.5, 2000, 9000, 0.12))
m.add("music", S(340), pad([57, 64, 69, 76], 5.8, gain=0.12, attack=1.6, release=1.8, cutoff=1500), send=0.4)
sonic_logo(m, S(372) - BEAT)                                                    # resolves on the wordmark
m.add("sfx", S(372), whoosh(0.7, 1500, 9000, 0.1))

# ---------------------------------------------------------------- 3. window forms
for f, g in ((548, 0.34), (560, 0.3), (572, 0.3)):
    m.add("sfx", S(f), whoosh(0.9, 250, 4200, g), pan=-0.3 if f == 560 else 0.2, send=0.2)
for f in (612, 620, 626):
    m.add("drums", S(f), kick(0.45, 70), send=0.1)
    m.add("sfx", S(f), tick(1800, 0.05, 0.22), send=0.2)

# ---------------------------------------------------------------- beat returns (on the downbeat after the window lands)
start = round(S(630) / BEAT) * BEAT
t = start
k = 0
chord_bass = (45, 45, 41, 41, 48, 48, 43, 43)  # Am F C G, half-bar each
while t < DUR - 0.1:
    bar = int((t - start) / (BEAT * 2)) % 8
    root = chord_bass[bar]
    if k % 4 == 0:
        m.add("drums", t, kick(0.8))
    if k % 8 == 4:
        m.add("drums", t, clap(), gain=0.45, send=0.25)
    if k % 2 == 1:
        m.add("drums", t, hat(), gain=0.32)
    m.add("music", t, bass_note(root + (12 if k % 4 == 3 else 0), SIX * 0.85, cutoff=1400, gain=0.22))
    t += SIX
    k += 1
m.add("music", start, pad([57, 60, 64, 69], 2.0, gain=0.07, cutoff=2200), send=0.3)

# ---------------------------------------------------------------- 4. terminal
for c in range(9):
    m.add("sfx", S(706 + 3 * c), key_click(), pan=0.1)
m.add("sfx", S(733), key_click() * 1.4)
for c in range(4):  # test files land
    m.add("sfx", S(733 + 3 * (4 + c * 2)), tick(midi(88 + c * 2), 0.09, 0.14), send=0.3)
m.add("sfx", S(733 + 3 * 16), bell(88, 1.2, gain=0.09), send=0.4)             # 45 passed
m.add("sfx", S(800), whoosh(0.5, 600, 6000, 0.2))

# ---------------------------------------------------------------- 5. KalVoice
m.add("voice", S(846), bell(76, 1.4, ratio=2.0, index=1.0, gain=0.16), send=0.5)   # activate
m.add("voice", S(846) + 0.09, bell(83, 1.4, ratio=2.0, index=1.0, gain=0.14), send=0.5)
m.add("voice", S(848), voice_texture(S(906) - S(848), 0.09), send=0.2)
m.add("voice", S(848), shimmer(S(906) - S(848) + 0.6, 88, 0.035), send=0.5)
m.add("voice", S(906), zap(0.2, 700, 3400, 0.16), send=0.3)                         # route
m.add("voice", S(916), bell(88, 2.2, ratio=3.0, index=1.6, gain=0.16), send=0.55)  # focus lock
m.add("voice", S(916), bell(81, 2.2, ratio=3.0, index=1.2, gain=0.1), send=0.55)
m.add("drums", S(916), sub_drop(1.2, 70, 40) * 0.4)

mix = render(m, duckers=[(S(846), S(930), 9)])
out = os.path.join(HERE, "proof_mix.wav")
write_wav(out, mix[:, : int(DUR * SR)])
print("wrote", out)
