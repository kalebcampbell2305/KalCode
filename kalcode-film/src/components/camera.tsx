import type React from "react";
import { C } from "../brand/tokens";
import { ease, lerp, prog, window as win } from "../motion";
import { Headline, useStage } from "./core";

/** A camera key: place window point (fx, fy) at the stage point (sx, sy) at scale s. */
export type CamKey = {
  f: number;
  s: number;
  fx: number;
  fy: number;
  sx?: number;
  sy?: number;
  rx?: number;
  ry?: number;
};

/** Interpolate camera keys with an ease per segment (deterministic). */
export const camAt = (keys: CamKey[], frame: number, e = ease.inOut) => {
  if (frame <= keys[0].f) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (frame <= b.f) {
      const t = prog(frame, a.f, b.f - a.f, e);
      const L = (x?: number, y?: number, d = 0) => lerp(x ?? d, y ?? d, t);
      return {
        f: frame,
        s: L(a.s, b.s),
        fx: L(a.fx, b.fx),
        fy: L(a.fy, b.fy),
        sx: L(a.sx, b.sx, NaN),
        sy: L(a.sy, b.sy, NaN),
        rx: L(a.rx, b.rx),
        ry: L(a.ry, b.ry),
      };
    }
  }
  return keys[keys.length - 1];
};

/** Renders a 1920×1080 window under a camera, with optional 3D tilt. */
export const Camera: React.FC<{
  cam: CamKey;
  children: React.ReactNode;
  blur?: number;
  opacity?: number;
  w?: number;
  h?: number;
}> = ({ cam, children, blur = 0, opacity = 1, w = 1920, h = 1080 }) => {
  const { W, H, portrait } = useStage();
  const sx = Number.isFinite(cam.sx) ? (cam.sx as number) : W / 2;
  const sy = Number.isFinite(cam.sy) ? (cam.sy as number) : portrait ? H * 0.42 : H * 0.455;
  return (
    <div style={{ position: "absolute", inset: 0, perspective: 2400, perspectiveOrigin: `${sx}px ${sy}px`, opacity }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: w,
          height: h,
          transformOrigin: `${cam.fx}px ${cam.fy}px`,
          transform: `translate(${sx - cam.fx}px, ${sy - cam.fy}px) scale(${cam.s}) rotateX(${cam.rx ?? 0}deg) rotateY(${cam.ry ?? 0}deg)`,
          filter: blur > 0.05 ? `blur(${blur}px)` : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
};

/** Lower-third copy: the newest line replaces the previous one; each rises from a mask. */
export const LowerThird: React.FC<{
  frame: number;
  lines: { at: number; text: string; until?: number }[];
  size?: number;
}> = ({ frame, lines, size }) => {
  const { H, portrait } = useStage();
  const sz = size ?? (portrait ? 84 : 76);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: portrait ? H * 0.3 : 300,
          background: "linear-gradient(180deg, rgba(5,8,15,0) 0%, rgba(5,8,15,0.85) 55%, rgba(5,8,15,0.95) 100%)",
          opacity: Math.max(
            0,
            ...lines.map((l, i) => win(frame, l.at - 14, (l.until ?? lines[i + 1]?.at ?? 1e9) + 20, 14, 18)),
          ),
        }}
      />
      {lines.map((l, i) => {
        const next = lines[i + 1]?.at ?? l.until ?? 1e9;
        const end = l.until ?? next;
        if (frame < l.at - 2 || frame >= end + 2) return null;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: portrait ? H * 0.1 : 70,
              display: "flex",
              justifyContent: "center",
              padding: portrait ? "0 60px" : 0,
            }}
          >
            <Headline text={l.text} frame={frame} start={l.at} size={sz} exit={end - 14} gap={4} color={C.text} />
          </div>
        );
      })}
    </>
  );
};
