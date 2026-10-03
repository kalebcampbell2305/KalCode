"""Original score + sound design for the 60 s master, locked to film.blend cues (60 fps)."""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synth import *  # noqa: E402,F403

HERE = os.path.dirname(os.path.abspath(__file__))
C = json.load(open(os.path.join(HERE, "film_cues.json")))
DUR = 60.0
m = Mix(DUR + 1)
S = f2s
SIX = BEAT / 4
BAR = BEAT * 4


def cues(k):
    return sorted(C.get(k, []))


# ---------------------------------------------------------------- ACT 1: chaos
end_chaos = S(284)
t, k = 0.0, 0
while t < end_chaos:
    prog = t / end_chaos
    note = (45, 45, 57, 45, 45, 52, 45, 55)[k % 8] if prog < 0.6 else (45, 57, 45, 58, 45, 57, 60, 58)[k % 8]
    m.add("music", t, bass_note(note, SIX * 0.9, cutoff=260 + 2600 * prog ** 1.6, gain=0.26 + 0.1 * prog))
    if k % 2 == 1 or prog > 0.45:
        m.add("drums", t, hat(), gain=0.3 + 0.4 * prog, pan=0.25 * np.sin(k))
    if t >= BEAT * 2 and k % 4 == 0:
        m.add("drums", t, kick(0.85))
    if prog > 0.5 and k % 8 == 4:
        m.add("drums", t, clap(), gain=0.5, send=0.25)
    t += SIX
    k += 1
ping = (81, 84, 88, 86, 91, 93, 88)
for i, f in enumerate(cues("pop")):
    m.add("sfx", S(f), tick(midi(ping[i % 7]), 0.08, 0.15), pan=((i * 37) % 11 - 5) / 6, send=0.35)
for f in cues("snap")[::2]:
    if f < 280:
        m.add("sfx", S(f), whoosh(0.25, 1500, 6000, 0.06), pan=0.4 * np.sin(f))
m.add("music", 0.0, pad([45, 52, 58, 63], end_chaos + 0.2, gain=0.1, attack=2.5, release=0.3, cutoff=1400), send=0.2)
m.add("sfx", S(150), riser(S(290) - S(150), 200, 11000, 0.3))
m.add("sfx", S(250), whoosh(S(291) - S(250), 300, 8000, 0.4, rev=True))
m.add("drums", S(291), impact(1.5), send=0.25)

# ---------------------------------------------------------------- introducing
m.add("music", S(318), shimmer(3.6, 81, 0.05), send=0.6)
m.add("sfx", S(318), whoosh(0.5, 2000, 9000, 0.12))
m.add("music", S(328), pad([57, 64, 69, 76], 5.2, gain=0.12, attack=1.4, release=1.8, cutoff=1500), send=0.4)
sonic_logo(m, S(356) - BEAT)
m.add("sfx", S(356), whoosh(0.7, 1500, 9000, 0.1))

# ---------------------------------------------------------------- window forms
for i, f in enumerate(cues("whoosh")):
    m.add("sfx", S(f), whoosh(0.9, 250, 4200, 0.3), pan=(-0.3, 0.3, 0.0)[i % 3], send=0.2)
for f in cues("land"):
    m.add("drums", S(f), kick(0.45, 70), send=0.1)
    m.add("sfx", S(f), tick(1800, 0.05, 0.2), send=0.2)
m.add("sfx", S(562), shimmer(1.0, 93, 0.03), send=0.5)

# ---------------------------------------------------------------- the groove (from 10.0 s)
PROG = [(45, [57, 60, 64]), (41, [57, 60, 65]), (48, [55, 60, 64]), (43, [55, 59, 62])]  # Am F C G


def section(t0, t1, drums=True, clap_on=True, arp=False, bass_cut=1400, hat_g=0.3, half=False, filt=None):
    t, k = t0, 0
    while t < t1 - 1e-6:
        bar = int((t - 10.0) / (BEAT * 2)) % 4
        root, chord = PROG[bar]
        if drums:
            if (k % 8 == 0) if half else (k % 4 == 0):
                m.add("drums", t, kick(0.8))
            if clap_on and k % 8 == 4:
                m.add("drums", t, clap(), gain=0.42, send=0.25)
            if k % 2 == 1:
                m.add("drums", t, hat(), gain=hat_g)
            if k % 16 == 14:
                m.add("drums", t, hat(True), gain=hat_g * 0.7)
        cut = bass_cut if filt is None else filt(t)
        m.add("music", t, bass_note(root + (12 if k % 4 == 3 else 0), SIX * 0.85, cutoff=cut, gain=0.2))
        if arp:
            n = chord[k % 3] + (12 if (k // 3) % 2 else 0)
            m.add("music", t, pluck(n + 12, 0.28, 0.07, bright=3200 if filt is None else min(3200, filt(t) * 2)),
                  pan=0.35 * np.sin(k * 0.7), send=0.3)
        if k % 8 == 0:
            m.add("music", t, pad(chord + [chord[0] + 12], BEAT * 2, gain=0.05, attack=0.2, release=0.4, cutoff=2000), send=0.3)
        t += SIX
        k += 1


section(10.0, S(1200))                                   # one workspace + Providers
section(S(1200), S(1540), arp=True, hat_g=0.36)          # four panes
section(S(1540), S(1940), arp=True, hat_g=0.42)          # six panes
section(S(1940), S(2122), arp=True, hat_g=0.38)          # Build. Test. Ship.
section(S(2122), S(2602), arp=True, hat_g=0.36)          # multi-agent
section(S(2602), S(3022), drums=True, clap_on=False, arp=True, half=True, hat_g=0.18)   # KalVoice breakdown
section(S(3022), S(3250), arp=True, hat_g=0.42)          # cockpit
section(S(3250), S(3340), drums=False, arp=True, filt=lambda t: 500 + 2800 * ((t - S(3250)) / (S(3340) - S(3250))) ** 2)
m.add("sfx", S(1840), riser(S(1948) - S(1840), 300, 9000, 0.25))
m.add("sfx", S(3200), riser(S(3350) - S(3200), 200, 10000, 0.22))

# ---------------------------------------------------------------- act sfx
for f in cues("key"):
    m.add("sfx", S(f), key_click(), pan=0.1)
m.add("sfx", S(703), key_click() * 1.4)
for f in cues("enter"):
    if f > 1000:  # the agent CLIs launching in each pane
        m.add("sfx", S(f), key_click() * 1.2, pan=0.2 * np.sin(f))
for f in cues("pane"):
    if f > 1000:  # Layout presets: 4 panes, 6 panes
        m.add("sfx", S(f), whoosh(0.6, 400, 5000, 0.2), pan=0.3, send=0.2)
        m.add("drums", S(f) + 0.1, kick(0.5, 60), send=0.1)
for i, f in enumerate(cues("pass")):
    m.add("sfx", S(f), tick(midi(88 + i * 2), 0.09, 0.13), send=0.3)
m.add("sfx", S(751), bell(88, 1.2, gain=0.09), send=0.4)
m.add("sfx", S(784), whoosh(0.6, 400, 5000, 0.22), pan=0.5)
for f in cues("state"):
    if f > 700:
        m.add("sfx", S(f), whoosh(0.35, 800, 7000, 0.1), send=0.15)
for i, f in enumerate(cues("card")):
    m.add("sfx", S(f), whoosh(0.5, 400, 5000, 0.14), pan=(-0.6, -0.2, 0.2, 0.6)[i % 4], send=0.2)
    m.add("sfx", S(f) + 0.12, pluck(76 + (0, 3, 7, 10)[i % 4], 0.5, 0.1), pan=(-0.6, -0.2, 0.2, 0.6)[i % 4], send=0.4)
for f in cues("status"):
    m.add("sfx", S(f), tick(midi(93), 0.1, 0.12), send=0.35)
for on, off in zip(cues("voice_on"), cues("voice_off")):
    m.add("voice", S(on), bell(76, 1.4, ratio=2.0, index=1.0, gain=0.16), send=0.5)
    m.add("voice", S(on) + 0.09, bell(83, 1.4, ratio=2.0, index=1.0, gain=0.14), send=0.5)
    m.add("voice", S(on) + 0.03, voice_texture(S(off) - S(on), 0.09), send=0.2)
    m.add("voice", S(on) + 0.03, shimmer(S(off) - S(on) + 0.6, 88, 0.035), send=0.5)
m.add("voice", S(2746), zap(0.2, 700, 3400, 0.16), send=0.3)
m.add("voice", S(2756), bell(88, 2.2, ratio=3.0, index=1.6, gain=0.16), send=0.55)
m.add("voice", S(2756), bell(81, 2.2, ratio=3.0, index=1.2, gain=0.1), send=0.55)
m.add("drums", S(2756), sub_drop(1.2, 70, 40) * 0.35)
m.add("voice", S(2878), bell(84, 1.6, ratio=2.0, index=0.8, gain=0.12), send=0.5)       # sent
m.add("voice", S(2878) + 0.12, bell(88, 1.6, ratio=2.0, index=0.8, gain=0.1), send=0.5)
for f in (1948, 1962, 1976):  # Build. Test. Ship.
    m.add("drums", S(f), kick(1.0, 46))
    m.add("music", S(f), pad([57, 64, 69], 0.5, gain=0.14, attack=0.005, release=0.3, cutoff=3500), send=0.4)
m.add("sfx", S(3074), whoosh(0.6, 600, 8000, 0.16))
m.add("drums", S(3250), impact(1.2) * 0.6, send=0.3)                                        # not another wrapper
m.add("music", S(3250), pad([57, 64, 69, 71], 1.0, gain=0.12, attack=0.01, release=0.6, cutoff=3000), send=0.5)

# ---------------------------------------------------------------- end card: sonic signature
m.add("drums", S(3352), impact(1.6) * 0.7, send=0.4)
sonic_logo(m, S(3364) - BEAT)
m.add("music", S(3364), shimmer(4.0, 81, 0.05), send=0.6)
m.add("music", S(3404), pad([57, 64, 69, 76, 83], 3.2, gain=0.1, attack=0.8, release=1.6, cutoff=2400), send=0.5)

mix = render(m, duckers=[(S(2684), S(2762), 8), (S(2812), S(2882), 8)])
n = int(DUR * SR)
mix = mix[:, :n]
fade = int(1.2 * SR)
mix[:, -fade:] *= np.linspace(1, 0, fade) ** 2
write_wav(os.path.join(HERE, "film_mix.wav"), mix)
print("wrote film_mix.wav")
