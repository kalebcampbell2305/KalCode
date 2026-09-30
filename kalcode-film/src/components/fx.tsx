// Motion-design primitives: electric energy traces, specular light sweeps, the living light
// field behind everything, and kinetic type that LANDS on a beat with momentum.
import type React from "react";
import { C, FONT } from "../brand/tokens";
import { clamp01, drift, ease, lerp, prog, spring01 } from "../motion";

/** A comet of Constellation light racing around a rounded rectangle, with a soft full-edge glow. */
export const EnergyTrace: React.FC<{
  w: number;
  h: number;
  r?: number;
  frame: number;
  start: number;
  on?: number;
  speed?: number;
  color?: string;
}> = ({ w, h, r = 15, frame, start, on = 1, speed = 1, color = "141,182,255" }) => {
  if (on <= 0.001 || frame < start) return null;
  const per = 2 * (w + h - 4 * r) + 2 * Math.PI * r;
  const t = (frame - start) * 14 * speed;
  const intro = clamp01((frame - start) / 18);
  const head = per * 0.16;
  return (
    <svg
      width={w + 40}
      height={h + 40}
      style={{ position: "absolute", left: -20, top: -20, pointerEvents: "none", overflow: "visible", opacity: on }}
    >
      <defs>
        <filter id={`g${w}x${h}`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect
        x={20}
        y={20}
        width={w}
        height={h}
        rx={r}
        fill="none"
        stroke={`rgba(${color},${0.35 * intro})`}
        strokeWidth={1.5}
      />
      <g filter={`url(#g${w}x${h})`}>
        <rect
          x={20}
          y={20}
          width={w}
          height={h}
          rx={r}
          fill="none"
          stroke={`rgba(${color},0.95)`}
          strokeWidth={2.5}
          strokeDasharray={`${head * intro} ${per}`}
          strokeDashoffset={-t}
          strokeLinecap="round"
        />
        <rect
          x={20}
          y={20}
          width={w}
          height={h}
          rx={r}
          fill="none"
          stroke={`rgba(${color},0.6)`}
          strokeWidth={2}
          strokeDasharray={`${head * 0.5 * intro} ${per}`}
          strokeDashoffset={-t - per / 2}
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
};

/** A diagonal specular sheen that crosses a surface once (e.g. on a beat or a state change). */
export const LightSweep: React.FC<{ frame: number; at: number; dur?: number; strength?: number }> = ({
  frame,
  at,
  dur = 26,
  strength = 0.18,
}) => {
  const p = prog(frame, at, dur, ease.inOut);
  if (p <= 0 || p >= 1) return null;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", borderRadius: "inherit" }}>
      <div
        style={{
          position: "absolute",
          top: "-50%",
          bottom: "-50%",
          width: "35%",
          left: `${lerp(-45, 115, p)}%`,
          transform: "rotate(18deg)",
          background: `linear-gradient(90deg, rgba(169,200,255,0) 0%, rgba(169,200,255,${strength}) 50%, rgba(169,200,255,0) 100%)`,
          mixBlendMode: "screen",
        }}
      />
    </div>
  );
};

/** The living background: two slow Constellation light pools and a faint horizon, breathing. */
export const LightField: React.FC<{ frame: number; W: number; H: number; intensity?: number; pulse?: number }> = ({
  frame,
  W,
  H,
  intensity = 1,
  pulse = 0,
}) => {
  const a = drift(frame, 101, 0.25);
  const b = drift(frame, 102, 0.2);
  const k = intensity * (1 + 0.35 * pulse);
  return (
    <div style={{ position: "absolute", inset: 0, background: C.bg, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(${W * 0.55}px ${H * 0.55}px at ${W * (0.72 + 0.06 * a)}px ${H * (0.12 + 0.05 * b)}px, rgba(76,141,255,${0.16 * k}), transparent 70%),
            radial-gradient(${W * 0.5}px ${H * 0.5}px at ${W * (0.18 - 0.05 * b)}px ${H * (0.95 + 0.04 * a)}px, rgba(58,120,234,${0.1 * k}), transparent 70%),
            radial-gradient(${W * 0.9}px ${H * 0.25}px at 50% ${H * 0.62}px, rgba(76,141,255,${0.035 * k}), transparent 70%)`,
        }}
      />
    </div>
  );
};

/**
 * Kinetic type: each word travels in from depth/below and LANDS exactly on `land` (a beat frame),
 * with anticipation before and a small overshoot/settle after. Velocity drives a motion streak.
 */
export const KineticText: React.FC<{
  text: string;
  frame: number;
  land: number;
  size?: number;
  weight?: number;
  color?: string;
  dim?: string[];
  per?: number; // frames between words
  exit?: number;
  align?: "center" | "left";
  from?: "below" | "depth" | "left" | "right";
  style?: React.CSSProperties;
  tracking?: string;
}> = ({
  text,
  frame,
  land,
  size = 110,
  weight = 600,
  color = C.text,
  dim = [],
  per = 5,
  exit,
  align = "center",
  from = "below",
  style,
  tracking = "-0.035em",
}) => {
  const words = text.split(" ");
  const out = exit !== undefined ? prog(frame, exit, 12, ease.in) : 0;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: align === "center" ? "center" : "flex-start",
        columnGap: size * 0.27,
        fontFamily: FONT.display,
        fontSize: size,
        fontWeight: weight,
        letterSpacing: tracking,
        lineHeight: 1.04,
        color,
        perspective: 900,
        ...style,
      }}
    >
      {words.map((w, i) => {
        const L0 = land + i * per; // this word's landing frame
        const travel = 14;
        const t = (frame - (L0 - travel)) / travel; // 0 → 1 arrives exactly at L0
        const arrive = ease.expo(clamp01(t));
        const settle = frame >= L0 ? spring01(frame - L0) : 0;
        const vel = frame < L0 && t > 0 ? 1 - arrive : 0;
        const ex = out;
        const dx = from === "left" ? -1 : from === "right" ? 1 : 0;
        const dy = from === "below" ? 1 : 0;
        const dz = from === "depth" ? 1 : 0;
        const tx = dx * (1 - arrive) * size * 3;
        const ty = dy * (1 - arrive) * size * 1.2 - (frame >= L0 ? (1 - settle) * size * 0.06 : 0) - ex * size * 0.3;
        const tz = dz * (1 - arrive) * -1600;
        const sc = frame >= L0 ? 1 + (1 - settle) * 0.06 : 1;
        const streak = t > 0 && t < 1 ? vel * 14 : 0;
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity: (t <= 0 ? 0 : clamp01(t * 3)) * (1 - ex),
              transform: `translate3d(${tx}px, ${ty}px, ${tz}px) scale(${sc})`,
              filter: streak + ex * 10 > 0.3 ? `blur(${streak + ex * 10}px)` : undefined,
              color: dim.includes(w) ? C.muted : undefined,
              textShadow: "0 6px 40px rgba(3,5,11,0.9)",
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

/**
 * Beat-landing lower third: each line lands on its beat and leaves before the next arrives,
 * over a soft floor gradient. `until` ends the last line.
 */
export const BeatLines: React.FC<{
  frame: number;
  lines: { at: number; text: string; end?: number }[];
  until: number;
  size?: number;
  bottom?: number;
  portrait?: boolean;
}> = ({ frame, lines, until, size, bottom, portrait }) => {
  const sz = size ?? (portrait ? 96 : 88);
  const first = lines[0]?.at ?? 0;
  const floor = Math.min(prog(frame, first - 20, 16), 1 - prog(frame, until + 6, 14));
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: portrait ? 560 : 320,
          background: "linear-gradient(180deg, rgba(5,8,15,0), rgba(5,8,15,0.88) 60%, rgba(5,8,15,0.96))",
          opacity: floor,
          pointerEvents: "none",
        }}
      />
      {lines.map((l, i) => {
        const end = l.end ?? (i + 1 < lines.length ? lines[i + 1].at - 28 : until);
        if (frame < l.at - 16 || frame >= end + 14) return null;
        return (
          <div
            key={l.text}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: bottom ?? (portrait ? 190 : 78),
              display: "flex",
              justifyContent: "center",
              padding: "0 50px",
            }}
          >
            <KineticText text={l.text} frame={frame} land={l.at} per={4} size={sz} exit={end} />
          </div>
        );
      })}
    </>
  );
};
