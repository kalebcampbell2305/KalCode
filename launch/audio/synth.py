"""KalCode launch film: original score + sound design, synthesized offline (48 kHz stereo).

Everything here is generated from oscillators, filtered noise and envelopes: no samples, no
stock music. A film cue sheet (frame-accurate at 60 fps) drives the arrangement.
"""
import numpy as np
from scipy import signal

SR = 48000
BPM = 120
BEAT = 60 / BPM
FPS = 60
rng = np.random.default_rng(11)


def f2s(frame):
    return frame / FPS


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


class Mix:
    def __init__(self, seconds):
        self.n = int(seconds * SR) + SR
        self.bus = {k: np.zeros((2, self.n)) for k in ("music", "drums", "sfx", "voice", "verb")}

    def add(self, bus, t, x, gain=1.0, pan=0.0, send=0.0):
        i = int(t * SR)
        if i >= self.n:
            return
        if x.ndim == 1:
            l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
            x = np.vstack([x * l * 1.4142, x * r * 1.4142])
        x = x.copy()
        k = min(x.shape[1] // 4, int(0.02 * SR))
        if k > 0:
            x[:, -k:] *= np.linspace(1, 0, k)
        m = min(x.shape[1], self.n - i)
        self.bus[bus][:, i : i + m] += x[:, :m] * gain
        if send:
            self.bus["verb"][:, i : i + m] += x[:, :m] * gain * send


# ------------------------------------------------------------------ primitives


def env_adsr(n, a=0.005, d=0.1, s=0.7, r=0.2, hold=None):
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    h_n = max(0, n - a_n - d_n - r_n) if hold is None else int(hold * SR)
    e = np.concatenate([
        np.linspace(0, 1, a_n, endpoint=False),
        np.linspace(1, s, d_n, endpoint=False),
        np.full(h_n, s),
        np.linspace(s, 0, r_n),
    ])
    return e[:n] if len(e) >= n else np.pad(e, (0, n - len(e)))


def exp_decay(n, tau):
    return np.exp(-np.arange(n) / (tau * SR))


def saw(freq, n, detune=0.0):
    """Band-limited saw by additive synthesis (freq may be an array)."""
    f = np.broadcast_to(np.asarray(freq, float), (n,)) * (1 + detune)
    ph = 2 * np.pi * np.cumsum(f) / SR
    out = np.zeros(n)
    kmax = int(min(40, SR / 2 / max(20.0, float(np.max(f)))))
    for k in range(1, kmax + 1):
        out += np.sin(k * ph) / k
    return out * 0.6


def sine(freq, n, phase=0.0):
    f = np.broadcast_to(np.asarray(freq, float), (n,))
    return np.sin(2 * np.pi * np.cumsum(f) / SR + phase)


def noise(n):
    return rng.standard_normal(n)


def lp(x, fc, order=2):
    sos = signal.butter(order, min(fc, SR * 0.45), "low", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def hp(x, fc, order=2):
    sos = signal.butter(order, fc, "high", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def bp(x, lo, hi, order=2):
    sos = signal.butter(order, [lo, min(hi, SR * 0.45)], "band", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def sweep_filter(x, fc_start, fc_end, kind="low", block=256, q_order=2, curve=1.0):
    """Time-varying Butterworth filter processed in blocks (cutoff moves exponentially)."""
    out = np.zeros_like(x)
    nb = (len(x) + block - 1) // block
    zi = None
    for b in range(nb):
        t = (b / max(1, nb - 1)) ** curve
        fc = fc_start * (fc_end / fc_start) ** t
        if kind == "band":
            sos = signal.butter(q_order, [fc * 0.7, min(fc * 1.4, SR * 0.45)], "band", fs=SR, output="sos")
        else:
            sos = signal.butter(q_order, min(fc, SR * 0.45), kind, fs=SR, output="sos")
        if zi is None:
            zi = np.zeros((sos.shape[0], 2))
        seg = x[b * block : (b + 1) * block]
        y, zi = signal.sosfilt(sos, seg, zi=zi)
        out[b * block : b * block + len(seg)] = y
    return out


def soft(x, drive=1.5):
    return np.tanh(x * drive) / np.tanh(drive)


# ------------------------------------------------------------------ instruments


def kick(gain=1.0, tone=48):
    n = int(0.55 * SR)
    t = np.arange(n) / SR
    f = tone + 110 * np.exp(-t / 0.035)
    body = sine(f, n) * exp_decay(n, 0.2)
    click = hp(noise(n), 3000) * exp_decay(n, 0.004) * 0.25
    return soft((body + click) * gain, 1.6)


def sub_drop(dur=2.2, f0=62, f1=26):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.35)
    return soft(sine(f, n) * exp_decay(n, dur / 5.5), 1.3)


def impact(dur=1.5):
    n = int(dur * SR)
    thump = kick(1.2, 40)
    nz = lp(noise(n), 1400) * exp_decay(n, 0.25) * 0.5
    out = sub_drop(dur) * 0.9 + nz
    out[: len(thump)] += thump
    return out


def hat(open_=False):
    n = int((0.18 if open_ else 0.04) * SR)
    return hp(noise(n), 7500, 4) * exp_decay(n, 0.05 if open_ else 0.009) * 0.45


def clap():
    n = int(0.3 * SR)
    x = np.zeros(n)
    for k, d in enumerate((0, 0.011, 0.023)):
        i = int(d * SR)
        m = n - i
        x[i:] += bp(noise(m), 900, 5200) * exp_decay(m, 0.012 if k < 2 else 0.12)
    return x * 0.5


def tick(freq=3200, dur=0.03, gain=0.35):
    n = int(dur * SR)
    return (sine(freq, n) * exp_decay(n, 0.006) + hp(noise(n), 5000) * exp_decay(n, 0.002) * 0.4) * gain


def key_click():
    n = int(0.03 * SR)
    return (bp(noise(n), 1800, 7000) * exp_decay(n, 0.0035) + sine(2400, n) * exp_decay(n, 0.002) * 0.3) * 0.28


def bell(note, dur=2.4, ratio=3.5, index=2.2, gain=0.3):
    """FM bell: bright, clean, a little glassy."""
    n = int(dur * SR)
    fc = midi(note)
    e = exp_decay(n, dur / 3.2)
    mod = sine(fc * ratio, n) * index * fc * exp_decay(n, dur / 6)
    out = np.sin(2 * np.pi * np.cumsum(fc + mod) / SR) * e
    out += sine(fc * 2.001, n) * e * 0.18
    a = int(0.004 * SR)
    out[:a] *= np.linspace(0, 1, a)
    return out * gain


def pluck(note, dur=0.5, gain=0.25, bright=4200):
    n = int(dur * SR)
    x = (saw(midi(note), n) + saw(midi(note), n, 0.004)) * 0.5
    x = sweep_filter(x, bright, 300, "low")
    return x * exp_decay(n, dur / 3.5) * gain


def pad(notes, dur, gain=0.12, attack=1.2, release=1.4, cutoff=1800):
    n = int(dur * SR)
    x = np.zeros((2, n))
    for k, nt in enumerate(notes):
        for d, side in ((-0.006, 0), (0.0, None), (0.007, 1)):
            v = saw(midi(nt), n, d)
            if side is None:
                x += v * 0.5
            else:
                x[side] += v
    x = np.vstack([lp(x[0], cutoff), lp(x[1], cutoff)])
    e = env_adsr(n, attack, 0.3, 0.85, release)
    return x * e * gain / len(notes)


def bass_note(note, dur, cutoff=900, gain=0.35):
    n = int(dur * SR)
    x = saw(midi(note), n) * 0.7 + sine(midi(note - 12), n) * 0.5
    x = lp(x, cutoff, 2)
    return soft(x * env_adsr(n, 0.004, 0.08, 0.6, 0.05), 1.4) * gain


def riser(dur, f0=300, f1=9000, gain=0.25):
    n = int(dur * SR)
    x = sweep_filter(noise(n), f0, f1, "band", curve=1.6)
    t = np.linspace(0, 1, n)
    tone = sine(midi(57) * 2 ** (t * 2.0), n) * 0.12
    return (x * 0.6 + tone) * (t ** 1.8) * gain


def whoosh(dur=0.6, f0=500, f1=5000, gain=0.3, rev=False):
    n = int(dur * SR)
    x = sweep_filter(noise(n), f0, f1, "band")
    e = np.sin(np.linspace(0, np.pi, n)) ** 2
    out = x * e * gain
    return out[::-1] if rev else out


def shimmer(dur, root=76, gain=0.08):
    """Airy high cluster with slow beating: KalVoice / reveal air."""
    n = int(dur * SR)
    x = np.zeros(n)
    for k, iv in enumerate((0, 7, 12, 19)):
        x += sine(midi(root + iv) * (1 + 0.0015 * np.sin(2 * np.pi * (0.3 + k * 0.17) * np.arange(n) / SR)), n) / (k + 1)
    return x * env_adsr(n, dur * 0.35, 0.2, 0.8, dur * 0.4) * gain


def voice_texture(dur, gain=0.12):
    """Listening: band-passed breath modulated like a waveform."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    mod = 0.55 + 0.45 * np.abs(np.sin(2 * np.pi * 3.1 * t) * np.sin(2 * np.pi * 1.3 * t + 1))
    x = bp(noise(n), 1400, 4800) * mod * env_adsr(n, 0.08, 0.1, 0.9, 0.15)
    return x * gain


def zap(dur=0.22, f0=600, f1=3200, gain=0.22):
    n = int(dur * SR)
    t = np.linspace(0, 1, n)
    return sine(f0 * (f1 / f0) ** t, n) * (1 - t) ** 1.5 * gain


# ------------------------------------------------------------------ sonic logo


def sonic_logo(m, t, big=True):
    """KalCode signature: two rising bell notes resolving into an open A chord with sub."""
    m.add("music", t, bell(69, 2.0, gain=0.22), pan=-0.2, send=0.5)          # A4
    m.add("music", t + BEAT / 2, bell(76, 2.2, gain=0.22), pan=0.2, send=0.5)  # E5
    t3 = t + BEAT
    for nt, g, p in ((81, 0.2, 0.0), (85, 0.12, -0.3), (88, 0.1, 0.3), (83, 0.08, 0.1)):
        m.add("music", t3, bell(nt, 3.6, gain=g), pan=p, send=0.6)
    m.add("music", t3, pad([57, 64, 69, 71, 76], 5.0, gain=0.16, attack=0.05, release=2.5, cutoff=2600), send=0.4)
    if big:
        m.add("drums", t3, sub_drop(2.0, 55, 32) * 0.55)
        m.add("drums", t3, kick(0.9, 44))


# ------------------------------------------------------------------ reverb + master


def reverb_ir(dur=2.4):
    n = int(dur * SR)
    t = np.arange(n) / SR
    env = np.exp(-t / (dur / 6.5))
    ir = np.vstack([lp(noise(n), 7000) * env, lp(noise(n), 7000) * env])
    ir[:, : int(0.012 * SR)] = 0
    return ir / np.sqrt(np.sum(ir ** 2, axis=1, keepdims=True))


def render(m, duckers=()):
    """duckers: [(t0, t1, depth_db)] music ducks (e.g. under KalVoice)."""
    ir = reverb_ir()
    verb = np.vstack([signal.fftconvolve(m.bus["verb"][c], ir[c])[: m.n] for c in range(2)]) * 0.9
    music = m.bus["music"].copy()
    g = np.ones(m.n)
    for t0, t1, db in duckers:
        a, b = int(t0 * SR), int(t1 * SR)
        k = int(0.12 * SR)
        depth = 10 ** (-db / 20)
        seg = np.ones(m.n)
        seg[a:b] = depth
        seg[max(0, a - k) : a] = np.linspace(1, depth, a - max(0, a - k))
        seg[b : b + k] = np.linspace(depth, 1, len(seg[b : b + k]))
        g = np.minimum(g, seg)
    music *= g
    mix = music + m.bus["drums"] + m.bus["sfx"] * 0.9 + m.bus["voice"] + verb
    mix = np.vstack([hp(mix[0], 24), hp(mix[1], 24)])
    peak = np.max(np.abs(mix)) + 1e-9
    return (mix / peak * 0.7).astype(np.float32)


def write_wav(path, x):
    from scipy.io import wavfile

    wavfile.write(path, SR, (np.clip(x, -1, 1).T * 32767).astype(np.int16))
