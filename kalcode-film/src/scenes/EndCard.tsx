// 0:54–1:00 — Everything collapses into the lane light; the mark resolves on the full sonic
// logo; tagline; the live site's CTA, URL and platforms. Held, breathing, to 60.000.
import type React from "react";
import { C, FONT } from "../brand/tokens";
import { Bloom, cf, scene, useStage } from "../components/core";
import { copy } from "../data/copy";
import { clamp01, drift, ease, lerp, prog, reveal, shipHit, springIn } from "../motion";
import { Symbol, Wordmark } from "../ui/kit";

export const EndCard: React.FC<{ frame: number }> = ({ frame }) => {
  const { W, H, portrait } = useStage();
  const { start } = scene("endcard");
  if (frame < start) return null;
  const logo = cf("end.logo");
  const h = shipHit(frame, logo);
  const s = springIn(frame, logo, { damping: 13, stiffness: 110, mass: 1 });
  const lanesIn = prog(frame, start + 10, logo - start - 10, ease.inOut); // four lines of light converge
  const breathe = 0.5 + 0.5 * Math.sin(((frame - logo) / 60) * Math.PI * 0.5);
  const cy = portrait ? H * 0.3 : H * 0.29;
  const sym = portrait ? 280 : 220;
  const btn = springIn(frame, cf("end.cta"), { damping: 15, stiffness: 180 });

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <svg
        width={W}
        height={H}
        style={{ position: "absolute", inset: 0, filter: "drop-shadow(0 0 8px rgba(76,141,255,0.9))" }}
      >
        {[0, 1, 2, 3].map((k) => {
          // the four lanes return: horizontal light converging from both edges into the mark
          const y = cy + (k - 1.5) * 26 * (1 - lanesIn);
          const fromLeft = k % 2 === 0;
          const x0 = fromLeft ? -40 : W + 40;
          const tip = lerp(x0, W / 2, lanesIn);
          const tail = lerp(x0, W / 2, clamp01((lanesIn - 0.3) / 0.7) ** 1.6);
          return frame < logo + 2 ? (
            <line
              key={k}
              x1={tail}
              y1={y}
              x2={tip}
              y2={y}
              stroke="rgba(141,182,255,0.95)"
              strokeWidth={3}
              strokeLinecap="round"
            />
          ) : null;
        })}
      </svg>
      <Bloom x={W / 2} y={cy} r={W * 0.5} o={(0.35 + 0.1 * breathe) * s + 0.9 * h.flash} />
      <div
        style={{
          position: "absolute",
          left: W / 2 - (W * 0.9 * h.ring) / 2,
          top: cy - (W * 0.9 * h.ring) / 2,
          width: W * 0.9 * h.ring,
          height: W * 0.9 * h.ring,
          borderRadius: "50%",
          border: `2px solid rgba(141,182,255,${0.6 * h.ringOpacity})`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: W / 2 - sym / 2,
          top: cy - sym / 2,
          opacity: clamp01(s * 1.5),
          transform: `scale(${lerp(0.4, 1, s)}) rotate(${drift(frame, 91, 0.3) * 1.5}deg)`,
          filter: `brightness(${1 + 0.6 * h.flash + 0.06 * breathe})`,
        }}
      >
        <Symbol size={sym} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: cy + sym / 2 + (portrait ? 50 : 36),
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: portrait ? 34 : 26,
          fontFamily: FONT.ui,
        }}
      >
        <div style={reveal(frame, logo + 10, 34, 20)}>
          <Wordmark width={portrait ? 700 : 540} />
        </div>
        <div
          style={{
            ...reveal(frame, cf("end.line"), 30, 16),
            fontSize: portrait ? 42 : 36,
            color: C.text2,
            letterSpacing: "0.01em",
            textAlign: "center",
            padding: "0 40px",
          }}
        >
          {copy.tagline}
        </div>
        <div style={{ height: portrait ? 50 : 22 }} />
        <div
          style={{
            opacity: clamp01(btn * 1.4),
            transform: `translateY(${(1 - btn) * 20}px) scale(${0.96 + 0.04 * btn})`,
            display: "flex",
            alignItems: "center",
            gap: 14,
            height: portrait ? 96 : 84,
            padding: portrait ? "0 52px" : "0 44px",
            borderRadius: 999,
            background: `linear-gradient(180deg, ${C.btnTop}, ${C.btnBottom})`,
            border: "1px solid rgba(170,205,255,0.5)",
            boxShadow: `0 0 ${40 + 20 * breathe}px -6px rgba(76,141,255,0.7)`,
            color: "#fff",
            fontSize: portrait ? 40 : 34,
            fontWeight: 500,
          }}
        >
          {copy.cta}
        </div>
        <div
          style={{
            ...reveal(frame, cf("end.url"), 30, 16),
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: portrait ? 18 : 12,
          }}
        >
          <span style={{ fontSize: portrait ? 64 : 56, color: C.text, letterSpacing: "-0.01em" }}>{copy.url}</span>
          <span style={{ fontSize: 34, color: C.muted, textAlign: "center", padding: "0 40px" }}>
            {portrait ? (
              <>
                {copy.ctaSub}
                <br />
                {copy.platforms}
              </>
            ) : (
              `${copy.ctaSub}  ·  ${copy.platforms}`
            )}
          </span>
        </div>
      </div>
    </div>
  );
};
