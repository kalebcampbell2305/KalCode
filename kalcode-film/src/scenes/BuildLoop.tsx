// 0:36–0:42 — Build it. See it. The Code surface: the thread's progress (Dashboard pane),
// the dev server (terminal) and the Browser pane, laid out left→right as CODE → BUILD →
// BROWSER. A light packet carries the change across; the browser reloads into the new hero.
import type React from "react";
import { C, FONT } from "../brand/tokens";
import { Camera, camAt } from "../components/camera";
import { cf, scene, useStage } from "../components/core";
import { BeatLines, LightSweep } from "../components/fx";
import { copy } from "../data/copy";
import { drift, ease, lerp, prog, springIn } from "../motion";
import { AtlasPage } from "../ui/atlas";
import { Cockpit, CodeHeader, PaneCanvas, SURF } from "../ui/Cockpit";
import { StatusChip } from "../ui/kit";
import { BrowserBody, TerminalBody } from "../ui/surfaces";

export const BuildLoop: React.FC<{ frame: number }> = ({ frame }) => {
  const { W, H, portrait } = useStage();
  const { start, end } = scene("buildloop");
  if (frame < start - 20 || frame >= end + 24) return null;
  const refresh = cf("build.refresh");
  const comp = cf("build.component");
  const done = cf("build.done");
  const spin = prog(frame, refresh, 24, ease.inOut);
  const morph = prog(frame, comp, 36, ease.emphasized);
  const k = cf("build.keys");

  const term: { text: string; color?: string }[] = [
    { text: "PS ~\\Projects\\atlas> pnpm dev", color: C.text },
    { text: "  VITE v8.3  ready", color: C.workingText },
    { text: "  ➜  Local:   http://localhost:5173/", color: C.text2 },
  ];
  const ups = [
    [k + 10, "  hmr update /src/components/PlanCard.tsx"],
    [k + 40, "  hmr update /src/routes/pricing.tsx"],
    [k + 72, "  hmr update /src/components/PlanCard.tsx"],
    [refresh - 8, "  page reload /pricing"],
  ] as const;
  for (const [f, t] of ups)
    if (frame >= f) term.push({ text: t, color: t.includes("reload") ? C.accentText : C.muted });

  const editing = frame < done;
  const activity =
    frame < k + 30
      ? "Reading apps/web/src/routes/pricing.tsx"
      : frame < refresh - 20
        ? "Editing apps/web/src/components/PlanCard.tsx"
        : frame < done
          ? "Running a command · pnpm --filter web test"
          : "Ready";

  const dash = (
    <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12, fontFamily: FONT.ui }}>
      <div style={{ fontSize: 21, color: C.text }}>Dashboard</div>
      <div
        style={{
          padding: "16px 18px",
          borderRadius: 14,
          background: C.surface2,
          border: `1px solid ${editing ? C.borderLitSoft : C.border}`,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 20, color: C.text }}>Pricing page</span>
          <span style={{ fontSize: 15, color: C.muted }}>Claude Code · Work</span>
          <div style={{ flex: 1 }} />
          <StatusChip
            tone={editing ? "working" : "done"}
            label={editing ? "Working" : "Done"}
            pulse={editing ? 0.5 + 0.5 * Math.sin(frame / 12) : 0}
          />
        </div>
        <div
          style={{
            fontFamily: FONT.mono,
            fontSize: 16,
            color: C.text2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {activity}
        </div>
      </div>
    </div>
  );

  const keys = portrait
    ? [
        { f: start - 6, s: 1.0, fx: 620, fy: 700, ry: 10 },
        { f: refresh - 34, s: 0.95, fx: 700, fy: 640, ry: 6 },
        { f: refresh + 6, s: 1.0, fx: 1380, fy: 520, ry: -8 },
        { f: end, s: 0.95, fx: 1350, fy: 520, ry: 4 },
      ]
    : [
        { f: start - 6, s: 1.3, fx: 640, fy: 740, ry: 14, rx: 4 },
        { f: refresh - 34, s: 1.12, fx: 720, fy: 660, ry: 8, rx: 2 },
        { f: refresh + 6, s: 1.08, fx: 1350, fy: 560, ry: -8, rx: 2 },
        { f: done, s: 1.0, fx: 1260, fy: 540, ry: -4 },
        { f: end, s: 0.92, fx: 1100, fy: 540, ry: 6, rx: -2 },
      ];
  const cam = camAt(keys, frame, ease.emphasized);
  cam.fx += drift(frame, 61, 0.5) * 6;
  const sx = W / 2;
  const sy = portrait ? H * 0.42 : H * 0.455;
  const toStage = (x: number, y: number) => ({ x: sx + (x - cam.fx) * cam.s, y: sy + (y - cam.fy) * cam.s });

  // CODE → BUILD → BROWSER: one packet of light crossing the panes before the reload
  const cw = SURF.w - 40;
  const ch = SURF.h - 80;
  const P = (fx: number, fy: number) => toStage(SURF.x + 20 + fx * cw, SURF.y + 64 + fy * ch);
  const a = P(0.19, 0.22);
  const b = P(0.19, 0.7);
  const c = P(0.68, 0.5);
  const t = prog(frame, refresh - 34, 34, ease.inOut);
  const seg =
    t < 0.5
      ? { x: lerp(a.x, b.x, t * 2), y: lerp(a.y, b.y, t * 2) }
      : { x: lerp(b.x, c.x, (t - 0.5) * 2), y: lerp(b.y, c.y, (t - 0.5) * 2) };
  const pkOn = t > 0 && t < 1;
  const enter = springIn(frame, start - 20, { damping: 18, stiffness: 120 });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: prog(frame, start - 6, 8) * (1 - prog(frame, end - 2, 8, ease.in)),
      }}
    >
      <Camera cam={cam} blur={lerp(5, 0, enter)}>
        <Cockpit active="Code" status={<span>3 panes · 1 running</span>}>
          <CodeHeader workspace="atlas" path="~\Projects\atlas" />
          <PaneCanvas
            panes={[
              { id: "d", rect: { x: 0, y: 0, w: 0.38, h: 0.42 }, lit: frame < refresh - 34 ? 1 : 0, content: dash },
              {
                id: "t",
                rect: { x: 0, y: 0.42, w: 0.38, h: 0.58 },
                lit: t > 0 && t < 0.55 ? 1 : 0,
                content: <TerminalBody lines={term} caret frame={frame} size={17.5} />,
              },
              {
                id: "b",
                rect: { x: 0.38, y: 0, w: 0.62, h: 1 },
                lit: t >= 0.5 ? 1 : 0,
                content: (
                  <BrowserBody url="http://localhost:5173/pricing" spin={spin}>
                    <div style={{ position: "absolute", inset: 0, opacity: 1 - morph, filter: `blur(${morph * 8}px)` }}>
                      <AtlasPage variant="old" />
                    </div>
                    <div style={{ position: "absolute", inset: 0, opacity: morph }}>
                      <AtlasPage variant="new" t={morph} />
                      <LightSweep frame={frame} at={comp} dur={30} strength={0.35} />
                    </div>
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background: `rgba(169,200,255,${0.18 * Math.max(0, 1 - Math.abs((frame - comp) / 10))})`,
                      }}
                    />
                  </BrowserBody>
                ),
              },
            ]}
          />
        </Cockpit>
      </Camera>
      {pkOn ? (
        <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
          <path
            d={`M ${a.x} ${a.y} L ${b.x} ${b.y} L ${c.x} ${c.y}`}
            fill="none"
            stroke="rgba(141,182,255,0.35)"
            strokeWidth={3}
            pathLength={1}
            strokeDasharray={`${t} 1`}
            style={{ filter: "drop-shadow(0 0 8px rgba(76,141,255,0.9))" }}
          />
          <circle cx={seg.x} cy={seg.y} r={30} fill="rgba(76,141,255,0.25)" />
          <circle cx={seg.x} cy={seg.y} r={10} fill="#a9c8ff" />
        </svg>
      ) : null}
      <BeatLines
        frame={frame}
        portrait={portrait}
        size={portrait ? 96 : 92}
        lines={[
          { at: cf("copy.build_it"), text: copy.buildIt },
          { at: cf("copy.see_it"), text: copy.seeIt },
        ]}
        until={end - 6}
      />
    </div>
  );
};
