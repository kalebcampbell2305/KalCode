"""Original DSP primitives for the KalCode launch film score.

Everything here is synthesized from mathematics and a pinned RNG seed. No samples,
recordings, loops or third-party sound material are read anywhere in the pipeline.
"""

from __future__ import annotations

import numpy as np
from scipy import signal

SR = 48_000
BPM = 120
BEAT = 60.0 / BPM                    # 0.5 s
BEAT_N = 24_000                      # samples per beat at 48 kHz (exact)
BAR_N = BEAT_N * 4                   # 96 000
SIXTEENTH_N = BEAT_N // 4            # 6 000
BARS = 30
TOTAL_N = BAR_N * BARS               # 2 880 000 samples = 60.000 s
SEED = 20260930


def rng(stream: int) -> np.random.Generator:
    """Independent, reproducible random stream per instrument."""
    return np.random.default_rng([SEED, stream])


def pos(bar: float, beat: float = 1.0, six: float = 0.0) -> int:
    """Sample index of a 1-based bar/beat plus sixteenths."""
    return int(round(((bar - 1) * 4 + (beat - 1) + six / 4.0) * BEAT_N))


def midi_hz(m: float) -> float:
    return 440.0 * 2.0 ** ((m - 69.0) / 12.0)


def db(x: float) -> float:
    return 10.0 ** (x / 20.0)


# ---------------------------------------------------------------- oscillators

def _polyblep(t: np.ndarray, dt: np.ndarray) -> np.ndarray:
    out = np.zeros_like(t)
    a = t < dt
    x = t[a] / dt[a]
    out[a] = x + x - x * x - 1.0
    b = t > 1.0 - dt
    x = (t[b] - 1.0) / dt[b]
    out[b] = x * x + x + x + 1.0
    return out


def phase_of(freq: np.ndarray | float, n: int, phase0: float = 0.0) -> np.ndarray:
    f = np.broadcast_to(np.asarray(freq, dtype=np.float64), (n,))
    return (phase0 + np.cumsum(f) / SR) % 1.0


def saw(freq, n: int, phase0: float = 0.0) -> np.ndarray:
    f = np.broadcast_to(np.asarray(freq, dtype=np.float64), (n,))
    ph = phase_of(f, n, phase0)
    dt = np.clip(f / SR, 1e-9, 0.5)
    return 2.0 * ph - 1.0 - _polyblep(ph, dt)


def square(freq, n: int, phase0: float = 0.0, width: float = 0.5) -> np.ndarray:
    return 0.5 * (saw(freq, n, phase0) - saw(freq, n, (phase0 + width) % 1.0))


def sine(freq, n: int, phase0: float = 0.0) -> np.ndarray:
    return np.sin(2.0 * np.pi * phase_of(freq, n, phase0))


def tri(freq, n: int, phase0: float = 0.0) -> np.ndarray:
    ph = phase_of(freq, n, phase0)
    return 4.0 * np.abs(ph - 0.5) - 1.0


# ------------------------------------------------------------------ envelopes

def env_adsr(n: int, a: float, d: float, s: float, r: float, gate: float | None = None) -> np.ndarray:
    """Linear-attack, exponential decay/release envelope. Times in seconds."""
    t = np.arange(n) / SR
    gate = n / SR - r if gate is None else gate
    e = np.empty(n)
    atk = t < a
    e[atk] = t[atk] / max(a, 1e-6)
    dec = ~atk
    e[dec] = s + (1.0 - s) * np.exp(-(t[dec] - a) / max(d, 1e-6))
    rel = t >= gate
    if rel.any():
        g_level = s + (1.0 - s) * np.exp(-max(gate - a, 0.0) / max(d, 1e-6)) if gate > a else gate / max(a, 1e-6)
        e[rel] = g_level * np.exp(-(t[rel] - gate) / max(r, 1e-6))
    return e


def env_exp(n: int, decay: float, attack: float = 0.0005) -> np.ndarray:
    t = np.arange(n) / SR
    return np.minimum(t / max(attack, 1e-6), 1.0) * np.exp(-t / decay)


def fade_edges(x: np.ndarray, fin: float = 0.002, fout: float = 0.004) -> np.ndarray:
    n = x.shape[-1]
    i = min(int(fin * SR), n)
    o = min(int(fout * SR), n)
    w = np.ones(n)
    if i:
        w[:i] = np.linspace(0, 1, i)
    if o:
        w[n - o:] *= np.linspace(1, 0, o)
    return x * w


# -------------------------------------------------------------------- filters

def _biquad(kind: str, f: float, q: float = 0.707, gain_db: float = 0.0):
    f = float(np.clip(f, 10.0, SR * 0.45))
    w = 2 * np.pi * f / SR
    cw, sw = np.cos(w), np.sin(w)
    al = sw / (2 * q)
    A = 10 ** (gain_db / 40)
    if kind == "lp":
        b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]; a = [1 + al, -2 * cw, 1 - al]
    elif kind == "hp":
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]; a = [1 + al, -2 * cw, 1 - al]
    elif kind == "bp":
        b = [al, 0, -al]; a = [1 + al, -2 * cw, 1 - al]
    elif kind == "peak":
        b = [1 + al * A, -2 * cw, 1 - al * A]; a = [1 + al / A, -2 * cw, 1 - al / A]
    elif kind == "lowshelf":
        sq = 2 * np.sqrt(A) * al
        b = [A * ((A + 1) - (A - 1) * cw + sq), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sq)]
        a = [(A + 1) + (A - 1) * cw + sq, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sq]
    elif kind == "highshelf":
        sq = 2 * np.sqrt(A) * al
        b = [A * ((A + 1) + (A - 1) * cw + sq), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sq)]
        a = [(A + 1) - (A - 1) * cw + sq, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sq]
    else:
        raise ValueError(kind)
    b = np.asarray(b) / a[0]
    a = np.asarray(a) / a[0]
    return b, a


def filt(x: np.ndarray, kind: str, f: float, q: float = 0.707, gain_db: float = 0.0) -> np.ndarray:
    b, a = _biquad(kind, f, q, gain_db)
    return signal.lfilter(b, a, x, axis=-1)


def filt_sweep(x: np.ndarray, kind: str, cutoff: np.ndarray, q: float = 0.707, block: int = 64) -> np.ndarray:
    """Time-varying biquad, coefficients updated per block with carried state."""
    mono = x.ndim == 1
    xs = x[None, :] if mono else x
    cutoff = np.broadcast_to(np.asarray(cutoff, dtype=np.float64), (xs.shape[-1],))
    out = np.zeros_like(xs)
    zi = np.zeros((xs.shape[0], 2))
    for s in range(0, xs.shape[-1], block):
        e = min(s + block, xs.shape[-1])
        b, a = _biquad(kind, float(cutoff[s]), q)
        # Transposed direct form II state is valid across coefficient changes for slow sweeps.
        out[:, s:e], zi = signal.lfilter(b, a, xs[:, s:e], axis=-1, zi=zi)
    return out[0] if mono else out


def one_pole_lp(x: np.ndarray, f: float) -> np.ndarray:
    a = np.exp(-2 * np.pi * f / SR)
    return signal.lfilter([1 - a], [1, -a], x, axis=-1)


# --------------------------------------------------------------- utilities

def place(buf: np.ndarray, x: np.ndarray, at: int, gain: float = 1.0) -> None:
    """Add mono or stereo x into stereo buf at sample `at`, clipped to bounds."""
    if x.ndim == 1:
        x = np.stack([x, x])
    if at < 0:
        x = x[:, -at:]
        at = 0
    n = min(x.shape[1], buf.shape[1] - at)
    if n > 0:
        buf[:, at:at + n] += gain * x[:, :n]


def pan(x: np.ndarray, p: float) -> np.ndarray:
    """Equal-power pan, p in [-1, 1]."""
    th = (p + 1) * np.pi / 4
    return np.stack([np.cos(th) * x, np.sin(th) * x])


def sat(x: np.ndarray, drive: float = 1.0) -> np.ndarray:
    return np.tanh(drive * x) / np.tanh(drive)


def stereo(n: int) -> np.ndarray:
    return np.zeros((2, n))


def rms_db(x: np.ndarray) -> float:
    return 20 * np.log10(np.sqrt(np.mean(np.square(x))) + 1e-12)


def make_ir(seconds: float, rt60: float, predelay: float, damp_hz: float, stream: int, width: float = 1.0) -> np.ndarray:
    """Synthetic stereo reverb impulse: decorrelated noise with frequency-dependent decay."""
    g = rng(stream)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    decay = np.exp(-6.9078 * t / rt60)
    ir = g.standard_normal((2, n)) * decay
    # Darker tail: progressively stronger low-pass as the tail evolves.
    early = one_pole_lp(ir, damp_hz * 2.5)
    late = one_pole_lp(ir, damp_hz * 0.6)
    mix = np.clip(t / (rt60 * 0.5), 0, 1)
    ir = early * (1 - mix) + late * mix
    mid = (ir[0] + ir[1]) / 2
    side = (ir[0] - ir[1]) / 2 * width
    ir = np.stack([mid + side, mid - side])
    pre = int(predelay * SR)
    ir = np.concatenate([np.zeros((2, pre)), ir], axis=1)
    ir /= np.sqrt(np.sum(ir ** 2) / 2)
    return ir


def convolve(x: np.ndarray, ir: np.ndarray) -> np.ndarray:
    if x.ndim == 1:
        x = np.stack([x, x])
    out = np.stack([
        signal.fftconvolve(x[0], ir[0])[: x.shape[1]],
        signal.fftconvolve(x[1], ir[1])[: x.shape[1]],
    ])
    return out


def pingpong(x: np.ndarray, delay_n: int, feedback: float, taps: int, lp_hz: float) -> np.ndarray:
    """Finite ping-pong echo built from explicit taps (deterministic, no recursion)."""
    if x.ndim == 1:
        x = np.stack([x, x])
    mono = (x[0] + x[1]) / 2
    out = np.zeros_like(x)
    tap = mono.copy()
    for k in range(1, taps + 1):
        tap = one_pole_lp(tap, lp_hz) * feedback
        side = k % 2  # alternate channels
        d = delay_n * k
        if d >= x.shape[1]:
            break
        out[side, d:] += tap[: x.shape[1] - d]
    return out


def true_peak(x: np.ndarray) -> np.ndarray:
    """Per-sample 4x-oversampled absolute peak across channels."""
    up = signal.resample_poly(x, 4, 1, axis=-1)
    return np.max(np.abs(up), axis=0).reshape(-1, 4).max(axis=1)[: x.shape[1]]


def lookahead_limiter(x: np.ndarray, ceiling_db: float, lookahead_ms: float = 2.5, release_ms: float = 80.0) -> np.ndarray:
    """Offline zero-latency brick-wall limiter on 4x-oversampled (true) peaks.

    A centred minimum window followed by a centred moving average of the same length
    guarantees the gain at every peak is at or below the required reduction, while the
    ramp into it is smooth. Release is a one-pole recovery that may never exceed it.
    """
    from scipy.ndimage import minimum_filter1d, uniform_filter1d
    ceiling = db(ceiling_db)
    need = np.minimum(1.0, ceiling / np.maximum(true_peak(x), 1e-12))
    L = max(1, int(lookahead_ms * 1e-3 * SR))
    m = minimum_filter1d(need, size=2 * L + 1, mode="nearest")
    s = uniform_filter1d(m, size=2 * L + 1, mode="nearest")
    s = np.minimum(s, m)  # the average may not exceed the local minimum requirement
    s = minimum_filter1d(s, size=2 * L + 1, mode="nearest")
    s = uniform_filter1d(s, size=2 * L + 1, mode="nearest")
    rel = np.exp(-1.0 / (release_ms * 1e-3 * SR))
    slow = signal.lfilter([1 - rel], [1, -rel], s - 1.0, zi=[0.0])[0] + 1.0
    g = np.minimum(s, slow)
    return x * g
