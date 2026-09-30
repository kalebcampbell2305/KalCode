// 0:50–0:54 — The camera pulls back: every thread, the dev server and the release were the
// "kalcode" workspace — KalCode's own repository. Real stack labels attach to the monorepo,
// and the app's own version ticks from 0.1.6 to 0.1.7.
import type React from "react";
import { C, FONT } from "../brand/tokens";
import { Camera, camAt, LowerThird } from "../components/camera";
import { Bloom, cf, scene, useStage } from "../components/core";
import { copy } from "../data/copy";
import { clamp01, ease, lerp, prog, springIn } from "../motion";
import { Cockpit, CodeHeader, PaneCanvas } from "../ui/Cockpit";
import { StatusChip } from "../ui/kit";
import { TerminalBody } from "../ui/surfaces";

const STACK = [
  { dir: "apps/desktop", label: "Tauri · React · TypeScript" },
  { dir: "apps/website", label: "Astro · Cloudflare Workers" },
  { dir: "apps/api", label: "Cloudflare Workers · Stripe" },
  { dir: "crates/", label: "Rust" },
  { dir: "crates/kalvoice", label: "whisper.cpp · llama.cpp" },
  { dir: "packages/ui", label: "design tokens" },
];

const DONE = [
  "Dashboard cards",
  "Checkout webhooks",
  "Push-to-talk hint",
  "Pricing page copy",
  "Download page",
  "Release 0.1.7",
];

export const SelfHosting: React.FC<{ frame: number }> = ({ frame }) => {
  const { W, H, portrait } = useStage();
  const { start, end } = scene("selfhost");
  if (frame < start - 20 || frame >= end + 30) return null;
  const upd = cf("self.update");
  const collapse = cf("end.collapse");
  const k = prog(frame, collapse, 36, ease.in); // collapses toward the end card

  const keys = portrait
    ? [
        { f: start - 20, s: 2.2, fx: 480, fy: 104 },
        { f: start + 16, s: 2.0, fx: 500, fy: 104 },
        { f: start + 90, s: 0.8, fx: 900, fy: 520 },
        { f: end, s: 0.78, fx: 900, fy: 520 },
      ]
    : [
        { f: start - 20, s: 3.0, fx: 520, fy: 104 },
        { f: start + 16, s: 2.7, fx: 540, fy: 104 },
        { f: start + 90, s: 0.8, fx: 960, fy: 540 },
        { f: end, s: 0.78, fx: 960, fy: 540 },
      ];
  const cam = camAt(keys, frame, ease.inOut);
  const version = frame >= upd ? "0.1.7" : "0.1.6";
  const vGlow = frame >= upd ? Math.exp(-(frame - upd) / 24) : 0;

  const tree = (
    <TerminalBody
      size={24}
      lines={[
        { text: "PS ~\\Projects\\kalcode> ls", color: C.text },
        ...STACK.map((s, i) => ({
          text: frame >= start + 30 + i * 6 ? `  ${s.dir.padEnd(18)} ${s.label}` : "",
          color: i % 2 ? C.text2 : C.text2,
        })),
      ]}
    />
  );
  const dash = (
    <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 10, fontFamily: FONT.ui }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <span style={{ fontSize: 21, color: C.text }}>Dashboard</span>
        <span style={{ fontSize: 15, color: C.muted }}>6 agents · 0 working · 0 waiting for you · 6 done · 0 idle</span>
      </div>
      {DONE.map((t, i) => (
        <div
          key={t}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderRadius: 10,
            background: C.surface2,
            border: `1px solid ${C.border}`,
            opacity: springIn(frame, start + 20 + i * 4),
          }}
        >
          <span style={{ fontSize: 17, color: C.text }}>{t}</span>
          <div style={{ flex: 1 }} />
          <StatusChip tone="done" label="Done" scale={0.85} />
        </div>
      ))}
    </div>
  );

  // collapse: everything rushes to the centre where the mark will resolve
  const sc = lerp(1, 0.02, clamp01(k));
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: prog(frame, start - 4, 6) * (1 - prog(frame, collapse + 30, 8)),
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `scale(${sc})`,
          transformOrigin: "50% 45%",
          filter: k > 0.05 ? `blur(${k * 10}px)` : undefined,
        }}
      >
        <Camera cam={cam}>
          <Cockpit active="Code" version={version} status={<span>kalcode · 6 threads done · 2 panes</span>}>
            <CodeHeader />
            <PaneCanvas
              panes={[
                { id: "tree", rect: { x: 0, y: 0, w: 0.55, h: 1 }, lit: 1, content: tree },
                { id: "dash", rect: { x: 0.55, y: 0, w: 0.45, h: 1 }, content: dash },
              ]}
            />
            {/* the version tick: a small glow at the sidebar build label */}
            <div
              style={{
                position: "absolute",
                left: -300 + 20,
                bottom: 12 - 36,
                width: 180,
                height: 40,
                borderRadius: 10,
                boxShadow: `0 0 ${40 * vGlow}px ${10 * vGlow}px rgba(76,141,255,${0.6 * vGlow})`,
                border: `1px solid rgba(92,150,255,${0.8 * vGlow})`,
              }}
            />
          </Cockpit>
        </Camera>
        <Bloom x={W / 2} y={H / 2} r={600} o={0.3 * prog(frame, start, 60) * (1 - k)} />
      </div>
      <LowerThird
        frame={frame}
        size={portrait ? 96 : 96}
        lines={[
          { at: cf("copy.build_kalcode"), text: copy.buildKalCode },
          { at: cf("copy.inside"), text: copy.inside, until: collapse - 4 },
        ]}
      />
    </div>
  );
};
