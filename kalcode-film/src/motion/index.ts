import type React from "react";
// The film's motion grammar. Every value is a pure function of the frame number:
// no Date.now(), no unseeded randomness, no CSS transitions or animations.
import { Easing, interpolate, spring } from "remotion";

export const FPS = 60;
export const BEAT = 30; // frames per beat at 120 BPM
export const BAR = 120; // frames per bar

// Product motion tokens (packages/ui tokens.css) plus two film eases.
export const ease = {
  out: Easing.bezier(0.22, 1, 0.36, 1),
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
  expo: Easing.bezier(0.16, 1, 0.3, 1),
  standard: Easing.bezier(0.2, 0, 0, 1),
  emphasized: Easing.bezier(0.05, 0.7, 0.1, 1),
  in: Easing.bezier(0.55, 0, 1, 0.45),
  // anticipation: dips below zero before travelling (for collapses and pulls)
  anticipate: Easing.bezier(0.6, -0.35, 0.735, 0.045),
  linear: (t: number) => t,
};

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const mix = lerp;

/** 0→1 progress of `frame` through [start, start+dur], eased. */
export const prog = (frame: number, start: number, dur: number, e: (t: number) => number = ease.out) =>
  e(clamp01((frame - start) / Math.max(1, dur)));

/** 1 inside the window, eased in and out at the edges. */
export const window = (frame: number, start: number, end: number, fadeIn = 12, fadeOut = 12) =>
  Math.min(prog(frame, start, fadeIn, ease.standard), 1 - prog(frame, end - fadeOut, fadeOut, ease.inOut));

/** Spring with overshoot and follow-through, starting at `start`. */
export const springIn = (
  frame: number,
  start: number,
  cfg: { damping?: number; stiffness?: number; mass?: number } = {},
) =>
  frame < start
    ? 0
    : spring({ frame: frame - start, fps: FPS, config: { damping: 14, stiffness: 170, mass: 0.9, ...cfg } });

/** Stiff, slightly overshooting snap for panes landing into place. */
export const magneticSnap = (frame: number, start: number) =>
  springIn(frame, start, { damping: 17, stiffness: 320, mass: 0.7 });

/** Stagger helper: start frame of item i. */
export const stagger = (start: number, i: number, gap = 4) => start + i * gap;

/** Text / element reveal: rises out of a mask with a short blur. Returns style. */
export const reveal = (frame: number, start: number, dur = 26, dist = 34) => {
  const p = prog(frame, start, dur, ease.expo);
  return {
    opacity: clamp01(p * 1.4),
    transform: `translateY(${(1 - p) * dist}px)`,
    filter: p < 0.999 ? `blur(${(1 - p) * 10}px)` : undefined,
  } as React.CSSProperties;
};

/** Exit: sinks and blurs out. */
export const conceal = (frame: number, start: number, dur = 16, dist = -18) => {
  const p = prog(frame, start, dur, ease.in);
  return {
    opacity: 1 - p,
    transform: `translateY(${p * dist}px)`,
    filter: p > 0.001 ? `blur(${p * 8}px)` : undefined,
  } as React.CSSProperties;
};

/** Number of characters visible when streaming text at `cps` characters per second. */
export const streamText = (text: string, frame: number, start: number, cps = 60) =>
  text.slice(0, Math.max(0, Math.floor(((frame - start) / FPS) * cps)));

/** Terminal typing with a seeded, human cadence (never uniform). */
export const terminalType = (text: string, frame: number, start: number, cps = 26, seed = 1) => {
  if (frame < start) return "";
  const r = rng(seed);
  let t = start;
  let n = 0;
  for (; n < text.length; n++) {
    t += (FPS / cps) * (0.55 + r() * 0.9) * (text[n] === " " ? 1.3 : 1);
    if (t > frame) break;
  }
  return text.slice(0, n);
};

/** Mulberry32 — seeded, deterministic. */
export const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Deterministic smooth noise in [-1, 1] (sum of seeded sines). Used for drift and breathing. */
export const drift = (frame: number, seed = 0, speed = 1) => {
  const r = rng(seed * 9973 + 17);
  let v = 0;
  for (let k = 0; k < 3; k++) {
    const f = (0.12 + r() * 0.35) * speed * (k + 1);
    v += Math.sin((frame / FPS) * f * Math.PI * 2 + r() * 6.283) / (k + 1);
  }
  return v / 1.83;
};

/** Camera push: continuous scale from a to b over the window, with a soft settle. */
export const cameraPush = (frame: number, start: number, dur: number, from = 1, to = 1.06, e = ease.inOut) =>
  lerp(from, to, prog(frame, start, dur, e));

/** Focus rack: blur in px for a layer as focus pulls through it (0 = sharp). */
export const focusRack = (frame: number, start: number, dur: number, fromBlur: number, toBlur: number) =>
  lerp(fromBlur, toBlur, prog(frame, start, dur, ease.inOut));

/** SVG path growth: stroke-dashoffset for a path of `len`. */
export const branchGrow = (frame: number, start: number, dur: number, len: number, e = ease.inOut) =>
  len * (1 - prog(frame, start, dur, e));

/** A light packet travelling 0→1 along a pipeline, repeating every `period` frames after `start`. */
export const pipelinePulse = (frame: number, start: number, period: number) =>
  frame < start ? -1 : ((frame - start) % period) / period;

/** Agent launch: a quick scale/brightness pop with a trailing ring. */
export const agentLaunch = (frame: number, start: number) => {
  const s = springIn(frame, start, { damping: 12, stiffness: 260, mass: 0.6 });
  const ring = prog(frame, start, 36, ease.out);
  return { scale: lerp(0.86, 1, s), opacity: clamp01(s * 1.6), ring, ringOpacity: frame < start ? 0 : 1 - ring };
};

/** Ship hit: flash + shock ring + a short camera kick. */
export const shipHit = (frame: number, at: number) => {
  const dt = frame - at;
  if (dt < 0) return { flash: 0, ring: 0, ringOpacity: 0, kick: 0 };
  const flash = Math.exp(-dt / 7);
  const ring = prog(frame, at, 50, ease.expo);
  return { flash, ring, ringOpacity: 1 - ring, kick: Math.exp(-dt / 10) * Math.cos(dt * 0.9) };
};

/** Velocity-based motion blur (px) for an element moving along one axis. */
export const motionBlur = (pos: (f: number) => number, frame: number, amount = 0.35, max = 18) =>
  Math.min(max, Math.abs(pos(frame) - pos(frame - 1)) * amount);

export const interp = interpolate;
