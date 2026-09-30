// 0:06–0:10 — The hit. The collapsed point of light becomes the KalCode mark; the headline
// lands with the sonic logo; then the mark travels into the corner of the one KalCode window.
import type React from "react";
import { C } from "../brand/tokens";
import { Bloom, Headline, cf, scene, useStage } from "../components/core";
import { clamp01, drift, ease, lerp, prog, shipHit, springIn } from "../motion";
import { Symbol, Wordmark } from "../ui/kit";
import { copy } from "../data/copy";

export const Introduce: React.FC<{ frame: number }> = ({ frame }) => {
  const { W, H, portrait } = useStage();
  const { start, end } = scene("introduce");
  if (frame < start - 2 || frame >= end + 30) return null;
  const hit = cf("hit.product");
  const h = shipHit(frame, hit);
  const s = springIn(frame, hit, { damping: 11, stiffness: 120, mass: 1 });
  const push = cf("intro.push");
  const out = prog(frame, push, end + 30 - push, ease.inOut); // the mark recedes into the workspace
  const hOut = prog(frame, push, 20, ease.in); // copy clears before the window arrives
  const cx = W / 2;
  const cy = H / 2 - (portrait ? 180 : 110);
  const size = (portrait ? 300 : 260) * lerp(0.5, 1, s) * lerp(1, 0.55, out);
  const orbit = (frame - hit) / 60;
  return (
    <div style={{ position: "absolute", inset: 0, opacity: 1 - prog(frame, end + 6, 24, ease.in) }}>
      <Bloom x={cx} y={cy} r={W * 0.55 * (0.6 + 0.4 * s)} o={0.55 * s * (1 - out) + 0.9 * h.flash} />
      {/* shock ring on the hit */}
      <div
        style={{
          position: "absolute",
          left: cx - 40 - h.ring * W * 0.45,
          top: cy - 40 - h.ring * W * 0.45,
          width: 80 + h.ring * W * 0.9,
          height: 80 + h.ring * W * 0.9,
          borderRadius: "50%",
          border: `2px solid rgba(141,182,255,${0.7 * h.ringOpacity})`,
          boxShadow: `0 0 40px rgba(76,141,255,${0.4 * h.ringOpacity})`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: cx - size / 2,
          top: cy - size / 2 - out * (portrait ? 260 : 120),
          width: size,
          height: size,
          transform: `rotate(${drift(frame, 9, 0.3) * 2}deg)`,
          opacity: clamp01(s * 1.5) * (1 - out),
          filter: `brightness(${1 + 0.8 * h.flash + 0.08 * Math.sin(orbit * 2)})`,
        }}
      >
        <Symbol size={size} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: cy + (portrait ? 210 : 175),
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: portrait ? 34 : 26,
          padding: portrait ? "0 70px" : 0,
          transform: `translateY(${-hOut * 40}px)`,
          opacity: 1 - hOut,
          filter: hOut > 0.01 ? `blur(${hOut * 12}px)` : undefined,
        }}
      >
        <Headline
          text={copy.introducing}
          frame={frame}
          start={cf("copy.introducing")}
          size={portrait ? 108 : 124}
          dim={["Introducing"]}
          gap={9}
        />
        <Headline
          text={copy.positioning}
          frame={frame}
          start={cf("copy.positioning")}
          size={portrait ? 52 : 50}
          weight={400}
          color={C.text2}
          gap={3}
          tracking="-0.005em"
        />
      </div>
      {/* the wordmark rides in under the headline for brand recall */}
      <div
        style={{
          position: "absolute",
          left: cx - 110,
          top: H - (portrait ? 260 : 120),
          opacity: prog(frame, cf("copy.positioning") + 20, 30) * (1 - hOut) * 0.75,
        }}
      >
        <Wordmark width={220} color={C.muted} />
      </div>
    </div>
  );
};
