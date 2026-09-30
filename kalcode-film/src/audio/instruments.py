"""Synthesized instruments and sound-design voices for the KalCode launch film.

Every sound is generated here from oscillators, filtered noise and envelopes (seeded).
No samples, loops, recordings or third-party audio are used anywhere.
"""

from __future__ import annotations

import numpy as np

from dsp import (SR, env_adsr, env_exp, fade_edges, filt, filt_sweep, midi_hz, one_pole_lp, pan, rng, saw,
                 sine, square, tri)


def n_of(sec: float) -> int:
    return max(1, int(sec * SR))


# ------------------------------------------------------------------ drums

def kick(punch: float = 1.0, decay: float = 0.32) -> np.ndarray:
    n = n_of(decay * 1.6)
    t = np.arange(n) / SR
    f = 44 + 120 * np.exp(-t / 0.028) + 40 * np.exp(-t / 0.006)
    body = sine(f, n) * env_exp(n, decay, 0.0008)
    click = filt(rng(11).standard_normal(n) * env_exp(n, 0.004), "hp", 2500) * 0.25 * punch
    return np.tanh(1.4 * (body + click)) * 0.95


def snare(seed: int = 3) -> np.ndarray:
    n = n_of(0.35)
    noise = rng(seed).standard_normal(n)
    nz = filt(filt(noise, "bp", 3800, 0.6), "hp", 900) * env_exp(n, 0.11)
    tone = (sine(196, n) * 0.6 + sine(310, n) * 0.3) * env_exp(n, 0.05)
    return fade_edges(0.8 * nz + 0.55 * tone)


def clap(seed: int = 4) -> np.ndarray:
    n = n_of(0.3)
    noise = rng(seed).standard_normal(n)
    e = np.zeros(n)
    for k, off in enumerate([0.0, 0.009, 0.018, 0.028]):
        i = int(off * SR)
        e[i:] += env_exp(n - i, 0.012 if k < 3 else 0.12) * (0.8 if k < 3 else 1.0)
    return fade_edges(filt(filt(noise, "bp", 1500, 0.9), "hp", 600) * e * 0.9)


def hat(open_: bool = False, seed: int = 5) -> np.ndarray:
    n = n_of(0.35 if open_ else 0.07)
    # metallic: six detuned squares + noise, high-passed
    fr = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0]
    metal = sum(square(f * 4.1, n) for f in fr) / 6
    nz = rng(seed).standard_normal(n)
    x = filt(0.6 * metal + 0.5 * nz, "hp", 7000)
    return fade_edges(x * env_exp(n, 0.12 if open_ else 0.018) * 0.55)


def tick(freq: float = 3200, seed: int = 6) -> np.ndarray:
    """Tiny mechanical tick for fragmented rhythm and key texture."""
    n = n_of(0.03)
    nz = rng(seed).standard_normal(n)
    return fade_edges(filt(nz, "bp", freq, 2.5) * env_exp(n, 0.004) + sine(freq * 0.5, n) * env_exp(n, 0.003) * 0.3)


# ------------------------------------------------------------------- tonal

def bass(m: int, dur: float, cutoff: float = 520, sub: float = 0.8) -> np.ndarray:
    n = n_of(dur)
    f = midi_hz(m)
    body = 0.55 * saw(f, n) + 0.35 * square(f * 1.001, n, width=0.42)
    env = env_adsr(n, 0.004, 0.12, 0.55, 0.05, gate=dur - 0.03)
    cut = cutoff + 1300 * env_exp(n, 0.06)
    x = filt_sweep(body * env, "lp", cut, q=0.9)
    x = x + sub * sine(f, n) * env
    return fade_edges(np.tanh(1.3 * x) * 0.7)


def pluck(m: float, dur: float = 0.4, bright: float = 1.0, seed: int = 0) -> np.ndarray:
    n = n_of(dur + 0.3)
    f = midi_hz(m)
    x = 0.5 * saw(f, n) + 0.5 * saw(f * 1.004, n, 0.37)
    env = env_exp(n, dur * 0.55, 0.002)
    cut = 500 + 5200 * bright * env_exp(n, 0.07)
    return fade_edges(filt_sweep(x * env, "lp", cut, q=1.1) * 0.6)


def bell(m: float, dur: float = 2.2, index: float = 2.4, ratio: float = 3.5, bright: float = 1.0) -> np.ndarray:
    """Two-operator FM bell: the sonic-logo voice."""
    n = n_of(dur)
    f = midi_hz(m)
    t = np.arange(n) / SR
    idx = index * bright * np.exp(-t / 0.35)
    mod = np.sin(2 * np.pi * f * ratio * t) * idx
    car = np.sin(2 * np.pi * f * t + mod)
    shimmer = np.sin(2 * np.pi * f * 2.0 * t + 0.4 * mod) * 0.18 * np.exp(-t / 0.5)
    env = env_exp(n, dur * 0.33, 0.0015)
    return fade_edges((car + shimmer) * env * 0.55)


def pad(notes: list[int], dur: float, attack: float = 0.6, release: float = 0.9, cutoff: float = 2200,
        detune: float = 0.12, seed: int = 21) -> np.ndarray:
    """Detuned saw ensemble, stereo, low-passed. Returns (2, n)."""
    n = n_of(dur + release)
    g = rng(seed)
    out = np.zeros((2, n))
    for m in notes:
        f = midi_hz(m)
        for v in range(5):
            cents = (v - 2) * detune * 10
            ff = f * 2 ** (cents / 1200)
            x = saw(ff, n, g.random())
            out += pan(x, (v - 2) / 2.2)
    env = env_adsr(n, attack, 1.0, 0.85, release, gate=dur)
    out *= env
    out = filt(out, "lp", cutoff, 0.6)
    return out / (len(notes) * 5) * 1.6


def sub_boom(dur: float = 2.4, f0: float = 58, f1: float = 34) -> np.ndarray:
    n = n_of(dur)
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.35)
    return sine(f, n) * env_exp(n, dur * 0.35, 0.002)


def noise_riser(dur: float, f0: float = 400, f1: float = 9000, seed: int = 31, curve: float = 2.2) -> np.ndarray:
    n = n_of(dur)
    t = np.linspace(0, 1, n)
    nz = rng(seed).standard_normal((2, n))
    cut = f0 * (f1 / f0) ** (t ** curve)
    x = filt_sweep(nz, "bp", cut, q=1.4)
    return x * (t ** 1.8) * 0.5


def reverse_swell(dur: float, notes: list[int], seed: int = 32) -> np.ndarray:
    """Inward-accelerating swell ending at a hard stop (the 'suck-in' before the hit)."""
    n = n_of(dur)
    t = np.linspace(0, 1, n)
    out = np.zeros((2, n))
    for k, m in enumerate(notes):
        f = midi_hz(m) * (1 + 0.5 * t ** 3)  # pitch rises as it accelerates inward
        out += pan(saw(f, n) * 0.3 + sine(f / 2, n) * 0.4, (-1) ** k * 0.5)
    nz = rng(seed).standard_normal((2, n))
    out += filt_sweep(nz, "bp", 300 * (40 ** t), q=1.0) * 0.6
    env = t ** 3.2
    out = filt_sweep(out * env, "lp", 400 * (30 ** t), q=0.7)
    out[:, -64:] *= np.linspace(1, 0, 64)
    return out * 0.5


# ------------------------------------------------------------- sound design

def pane_snap(seed: int = 41) -> np.ndarray:
    """Tactile mechanical click with a small tonal body."""
    n = n_of(0.12)
    nz = rng(seed).standard_normal(n)
    click = filt(nz, "bp", 2400, 1.8) * env_exp(n, 0.006)
    thunk = sine(185 * (1 + 0.8 * np.exp(-np.arange(n) / SR / 0.01)), n) * env_exp(n, 0.03)
    return fade_edges(0.9 * click + 0.6 * thunk)


def agent_launch(m: float = 83, seed: int = 42) -> np.ndarray:
    """Clean digital impulse: a short upward chirp into a pitched ping."""
    n = n_of(0.5)
    t = np.arange(n) / SR
    chirp_f = 700 + 2600 * np.clip(t / 0.045, 0, 1)
    chirp = sine(chirp_f, n) * np.where(t < 0.05, 1.0, 0.0) * env_exp(n, 0.03)
    ping = bell(m, 0.5, index=1.2, ratio=2.0) * 0.8
    ping = np.pad(ping, (0, max(0, n - len(ping))))[:n]
    return fade_edges(0.35 * chirp + ping)


def key_texture(count: int, span: float, seed: int = 43) -> np.ndarray:
    """Low-level terminal key texture: seeded soft ticks over `span` seconds."""
    n = n_of(span + 0.05)
    g = rng(seed)
    out = np.zeros(n)
    for _ in range(count):
        at = int(g.random() * span * SR)
        tk = tick(2200 + g.random() * 1800, seed=int(g.integers(1e6)))
        out[at:at + len(tk)] += tk[: n - at] * (0.4 + 0.6 * g.random())
    return out * 0.5


def mic_on() -> np.ndarray:
    """KalVoice activation: soft rising fifth with an airy edge."""
    n = n_of(0.7)
    a = sine(midi_hz(76), n) * env_adsr(n, 0.004, 0.08, 0.0, 0.1)
    b_n = n_of(0.6)
    b = sine(midi_hz(83), b_n) * env_exp(b_n, 0.22, 0.004)
    out = a.copy()
    off = n_of(0.09)
    out[off:off + b_n] += b[: n - off]
    air = filt(rng(44).standard_normal(n), "hp", 6000) * env_exp(n, 0.08) * 0.08
    return fade_edges((out * 0.5 + air))


def mic_off() -> np.ndarray:
    n = n_of(0.5)
    a = sine(midi_hz(83), n) * env_exp(n, 0.06)
    b = np.zeros(n)
    off = n_of(0.07)
    b[off:] = sine(midi_hz(76), n - off) * env_exp(n - off, 0.16)
    return fade_edges((a + b) * 0.4)


def air_sweep(dur: float = 0.55, seed: int = 45) -> np.ndarray:
    """Browser refresh: air impulse sweeping upward."""
    n = n_of(dur)
    t = np.linspace(0, 1, n)
    nz = rng(seed).standard_normal((2, n))
    x = filt_sweep(nz, "bp", 600 * (18 ** t), q=0.9)
    env = np.sin(np.pi * np.clip(t, 0, 1)) ** 2
    return x * env * 0.35


def rising_pulse(dur: float, m0: float, m1: float, rate_hz: float = 8.0) -> np.ndarray:
    """Git convergence: a tonal pulse that rises in pitch and rate."""
    n = n_of(dur)
    t = np.linspace(0, 1, n)
    f = midi_hz(m0) * (midi_hz(m1) / midi_hz(m0)) ** t
    gate = 0.5 + 0.5 * np.sign(np.sin(2 * np.pi * np.cumsum(rate_hz * (1 + 2 * t)) / SR))
    gate = one_pole_lp(gate, 200)
    x = (tri(f, n) * 0.6 + sine(f * 2, n) * 0.25) * gate * (0.3 + 0.7 * t)
    return fade_edges(x * 0.5)


def test_pass(root: float = 88) -> np.ndarray:
    """Short harmonic confirmation: major-third dyad, glassy."""
    a = bell(root, 0.45, index=0.8, ratio=2.0)
    b = bell(root + 4, 0.45, index=0.8, ratio=2.0)
    out = a.copy()
    off = n_of(0.035)
    out[off:] += b[: len(out) - off]
    return out * 0.6


def fail_blip() -> np.ndarray:
    n = n_of(0.18)
    return fade_edges(square(midi_hz(58), n, width=0.3) * env_exp(n, 0.05) * 0.25)


def ship_impact(seed: int = 46) -> np.ndarray:
    """Large but controlled impact: sub drop, body, air tail. Returns (2, n)."""
    n = n_of(2.8)
    boom = sub_boom(2.8, 70, 32) * 1.0
    body = np.tanh(2.0 * sine(midi_hz(40) * (1 + np.exp(-np.arange(n) / SR / 0.04)), n) * env_exp(n, 0.25))
    nz = rng(seed).standard_normal((2, n))
    air = filt(nz, "hp", 2500) * env_exp(n, 0.35, 0.001) * 0.18
    mid = boom * 0.9 + body * 0.5
    return np.stack([mid, mid]) + air


def whoosh(dur: float = 0.6, up: bool = True, seed: int = 47) -> np.ndarray:
    n = n_of(dur)
    t = np.linspace(0, 1, n)
    nz = rng(seed).standard_normal((2, n))
    cut = 300 * (25 ** (t if up else 1 - t))
    env = np.sin(np.pi * t) ** 1.5
    return filt_sweep(nz, "bp", cut, q=0.8) * env * 0.4


def window_pop(m: float, seed: int = 48) -> np.ndarray:
    """A window appearing in the chaos: a short, slightly detuned blip."""
    n = n_of(0.16)
    x = (square(midi_hz(m), n, width=0.25) * 0.5 + sine(midi_hz(m) * 1.5, n) * 0.3) * env_exp(n, 0.045)
    return fade_edges(filt(x, "lp", 3500) * 0.5)
