import type React from "react";
import { createContext, useContext } from "react";
import cueJson from "../../cue_sheet.json";
import { C, FONT } from "../brand/tokens";
import { clamp01, ease, prog, reveal } from "../motion";

// ------------------------------------------------------------------ stage

export type Stage = { W: number; H: number; portrait: boolean };
export const StageCtx = createContext<Stage>({ W: 1920, H: 1080, portrait: false });
export const useStage = () => useContext(StageCtx);

// ------------------------------------------------------------------- cues

type Stamp = { t: number; bar: number; beat: number; frame: number; sample: number };
export type CueEvent = Stamp & { id: string; [k: string]: unknown };
export type CueScene = { id: string; start: Stamp; end: Stamp; title?: string };
export const CUE = cueJson as unknown as { scenes: CueScene[]; events: CueEvent[]; fps: number; duration: number };

const byId = new Map(CUE.events.map((e) => [e.id, e]));
/** Frame of a cue event (absolute film frame). Throws if the id is missing, so typos fail the build. */
export const cf = (id: string): number => {
  const e = byId.get(id);
  if (!e) throw new Error(`missing cue ${id}`);
  return e.frame;
};
export const cues = (prefix: string) => CUE.events.filter((e) => e.id.startsWith(prefix));
export const scene = (id: string) => {
  const s = CUE.scenes.find((x) => x.id === id);
  if (!s) throw new Error(`missing scene ${id}`);
  return { start: s.start.frame, end: s.end.frame };
};

// ---------------------------------------------------------------- copy

/** Display copy: each word rises out of a mask on its own stagger. */
export const Headline: React.FC<{
  text: string;
  frame: number;
  start: number;
  size?: number;
  weight?: number;
  color?: string;
  dim?: string[]; // words rendered in the secondary tone
  gap?: number;
  exit?: number; // frame the line leaves
  align?: "left" | "center";
  style?: React.CSSProperties;
  tracking?: string;
}> = ({
  text,
  frame,
  start,
  size = 96,
  weight = 500,
  color = C.text,
  dim = [],
  gap = 5,
  exit,
  align = "center",
  style,
  tracking = "-0.025em",
}) => {
  const words = text.split(" ");
  const out = exit !== undefined ? prog(frame, exit, 16, ease.in) : 0;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: align === "center" ? "center" : "flex-start",
        columnGap: size * 0.26,
        fontFamily: FONT.display,
        fontSize: size,
        fontWeight: weight,
        letterSpacing: tracking,
        lineHeight: 1.08,
        color,
        opacity: 1 - out,
        transform: `translateY(${-out * 20}px)`,
        filter: out > 0.001 ? `blur(${out * 10}px)` : undefined,
        ...style,
      }}
    >
      {words.map((w, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            overflow: "hidden",
            paddingBottom: size * 0.12,
            marginBottom: -size * 0.12,
          }}
        >
          <span
            style={{
              display: "inline-block",
              ...reveal(frame, start + i * gap, 30, size * 0.55),
              color: dim.includes(w) ? C.muted : undefined,
            }}
          >
            {w}
          </span>
        </span>
      ))}
    </div>
  );
};

/** Full-frame darkening behind copy so it reads over busy UI. */
export const Scrim: React.FC<{ amount: number; radial?: boolean }> = ({ amount, radial = true }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background: radial
        ? `radial-gradient(ellipse 70% 60% at 50% 50%, rgba(3,5,11,${0.92 * amount}) 0%, rgba(3,5,11,${0.6 * amount}) 70%, rgba(3,5,11,${0.35 * amount}) 100%)`
        : `rgba(3,5,11,${0.82 * amount})`,
      pointerEvents: "none",
    }}
  />
);

/** The brand's recurring light: a soft Constellation-blue bloom. */
export const Bloom: React.FC<{ x: number; y: number; r: number; o: number; color?: string }> = ({
  x,
  y,
  r,
  o,
  color = "76,141,255",
}) => (
  <div
    style={{
      position: "absolute",
      left: x - r,
      top: y - r,
      width: r * 2,
      height: r * 2,
      borderRadius: "50%",
      background: `radial-gradient(circle, rgba(${color},${0.55 * o}) 0%, rgba(${color},${0.18 * o}) 35%, rgba(${color},0) 70%)`,
      pointerEvents: "none",
    }}
  />
);

/** Film-grain-free backdrop: Space with the app's own two soft radial lights. */
export const Backdrop: React.FC<{ glow?: number }> = ({ glow = 1 }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background: C.bg,
      backgroundImage: `radial-gradient(90rem 40rem at 78% -18%, rgba(76,141,255,${0.075 * glow}), transparent 62%), radial-gradient(60rem 30rem at -10% 110%, rgba(76,141,255,${0.035 * glow}), transparent 60%)`,
    }}
  />
);

export const fadeIn = (frame: number, start: number, dur = 12) => clamp01((frame - start) / dur);
