// 0:10–0:16 — Your workspace. The KalCode window lands (Code surface, workspace kalcode):
// a terminal starts the website dev server, splits right into the Browser pane, splits down
// into a Dashboard pane; then the sidebar moves to Threads, where the agents live.
import type React from "react";
import { C } from "../brand/tokens";
import { camAt, Camera, LowerThird } from "../components/camera";
import { cf, scene, useStage } from "../components/core";
import { copy } from "../data/copy";
import { clamp01, drift, ease, lerp, magneticSnap, prog, springIn, terminalType } from "../motion";
import { Cockpit, CodeHeader, PaneCanvas, lerpRect, type Rect } from "../ui/Cockpit";
import { StatusChip } from "../ui/kit";
import { BrowserBody, SitePage, TerminalBody, type Thread, type TLine } from "../ui/surfaces";
import { ThreadsView } from "../ui/ThreadsView";

export const DEV_LINES = (frame: number, start: number) => {
  const cmd = terminalType("pnpm dev:website", frame, start, 22, 11);
  const out: { text: string; color?: string }[] = [{ text: `PS ~\\Projects\\kalcode> ${cmd}`, color: C.text }];
  const after = start + 50;
  if (frame > after) out.push({ text: "> astro dev", color: C.muted });
  if (frame > after + 14) out.push({ text: " astro  v7.3 ready", color: C.workingText });
  if (frame > after + 24) out.push({ text: " ┃ Local    http://localhost:4321/", color: C.text2 });
  if (frame > after + 34) out.push({ text: " watching for file changes…", color: C.muted });
  return out;
};

export const DashMini: React.FC<{
  rows: { t: string; p: string; s: string; tone: "working" | "done" | "idle" | "failed" }[];
  summary: string;
}> = ({ rows, summary }) => (
  <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
    <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
      <span style={{ fontSize: 22, color: C.text }}>Dashboard</span>
      <span style={{ fontSize: 15, color: C.muted }}>{summary}</span>
    </div>
    {rows.map((r) => (
      <div
        key={r.t}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 14px",
          borderRadius: 10,
          background: C.surface2,
          border: `1px solid ${C.border}`,
        }}
      >
        <span style={{ fontSize: 17, color: C.text }}>{r.t}</span>
        <span style={{ fontSize: 14.5, color: C.muted }}>{r.p}</span>
        <div style={{ flex: 1 }} />
        <StatusChip tone={r.tone} label={r.s} scale={0.85} />
      </div>
    ))}
  </div>
);

// Sample thread activity (fictional; KalCode renders the provider's normalized events).
export const HERO_TRANSCRIPT = (frame: number, start: number): TLine[] => {
  const all: TLine[] = [
    { text: "> Make the dashboard cards easier to scan.", color: C.text },
    { text: "● Reading apps/desktop/src/surfaces/dashboard", color: C.text2 },
    { text: "● Editing apps/desktop/src/surfaces/dashboard/AgentCard.tsx", color: C.text2 },
    { text: "  + 24 lines  − 11 lines", color: C.workingText },
    { text: "● Running pnpm --filter desktop test", color: C.text2 },
  ];
  return all.filter((_, i) => frame >= start + i * 9);
};

export const THREADS: Thread[] = [
  { title: "Dashboard cards", provider: "Claude Code", account: "Personal", status: "Editing", tone: "working" },
  { title: "Checkout webhooks", provider: "Codex", account: "Personal", status: "Thinking", tone: "working" },
  { title: "Pricing page copy", provider: "Claude Code", account: "Personal", status: "Ready", tone: "idle" },
];

export const Workspace: React.FC<{ frame: number }> = ({ frame }) => {
  const { portrait } = useStage();
  const { start, end } = scene("workspace");
  if (frame < start - 40 || frame >= end + 24) return null;
  const open = cf("ws.open");
  const sB = magneticSnap(frame, cf("ws.split.browser"));
  const sD = magneticSnap(frame, cf("ws.split.dash"));
  const toThreads = prog(frame, cf("ws.threads"), 24, ease.emphasized);
  const arrive = springIn(frame, open - 36, { damping: 16, stiffness: 90, mass: 1 });

  // pane geometry: terminal → split right (browser) → split down (dashboard)
  const full: Rect = { x: 0, y: 0, w: 1, h: 1 };
  const left: Rect = { x: 0, y: 0, w: 0.5, h: 1 };
  const rightFull: Rect = { x: 0.5, y: 0, w: 0.5, h: 1 };
  const rightTop: Rect = { x: 0.5, y: 0, w: 0.5, h: 0.6 };
  const rightBot: Rect = { x: 0.5, y: 0.6, w: 0.5, h: 0.4 };
  const term = lerpRect(full, left, sB);
  const browser = lerpRect({ x: 1, y: 0, w: 0.0, h: 1 }, lerpRect(rightFull, rightTop, sD), sB);
  const dash = lerpRect({ x: 0.5, y: 1, w: 0.5, h: 0 }, rightBot, sD);
  const load = prog(frame, cf("ws.browser.load"), 30, ease.out);

  // camera: arrive from depth, lean toward each new pane, settle
  const keys = portrait
    ? [
        { f: open - 36, s: 0.3, fx: 960, fy: 540 },
        { f: open + 10, s: 0.7, fx: 960, fy: 560 },
        { f: cf("copy.your_terminals"), s: 1.1, fx: 760, fy: 520 },
        { f: cf("copy.your_browser"), s: 1.1, fx: 1420, fy: 420 },
        { f: cf("ws.threads") + 20, s: 1.0, fx: 1200, fy: 460 },
        { f: end + 30, s: 1.02, fx: 1200, fy: 460 },
      ]
    : [
        { f: open - 36, s: 0.42, fx: 960, fy: 540 },
        { f: open + 12, s: 0.8, fx: 960, fy: 540 },
        { f: cf("copy.your_terminals"), s: 0.86, fx: 860, fy: 540 },
        { f: cf("copy.your_browser"), s: 0.86, fx: 1240, fy: 480 },
        { f: cf("ws.threads") + 20, s: 0.9, fx: 1120, fy: 470 },
        { f: end + 30, s: 0.95, fx: 1120, fy: 470 },
      ];
  const cam = camAt(keys, frame, ease.inOut);
  cam.fx += drift(frame, 21, 0.5) * 6;
  cam.fy += drift(frame, 22, 0.5) * 4;

  const code = (
    <>
      <CodeHeader
        hot={frame > cf("ws.split.browser") - 12 && frame < cf("ws.split.browser") + 10 ? "Layout" : undefined}
      />
      <PaneCanvas
        panes={[
          {
            id: "t",
            rect: term,
            lit: frame < cf("ws.split.browser") ? 1 : 0,
            content: <TerminalBody lines={DEV_LINES(frame, open + 6)} caret frame={frame} />,
          },
          {
            id: "b",
            rect: browser,
            opacity: clamp01(sB * 3),
            lit: frame >= cf("ws.split.browser") && frame < cf("ws.split.dash") ? 1 : 0,
            content: (
              <BrowserBody url="http://localhost:4321/" spin={load}>
                <div style={{ position: "absolute", inset: 0, opacity: load }}>
                  <SitePage variant="home" scale={0.9} />
                </div>
              </BrowserBody>
            ),
          },
          {
            id: "d",
            rect: dash,
            opacity: clamp01(sD * 3),
            lit: frame >= cf("ws.split.dash") && frame < cf("ws.threads") ? 1 : 0,
            content: (
              <DashMini
                summary="2 agents · 2 working · 0 waiting for you · 0 done · 0 idle"
                rows={[
                  { t: "Dashboard cards", p: "Claude Code", s: "Working", tone: "working" },
                  { t: "Checkout webhooks", p: "Codex", s: "Working", tone: "working" },
                ]}
              />
            ),
          },
        ]}
      />
    </>
  );

  const threads = (
    <ThreadsView
      frame={frame}
      threads={THREADS}
      selected={0}
      enterAt={cf("ws.threads") + 6}
      transcript={HERO_TRANSCRIPT(frame, cf("ws.threads") + 10)}
    />
  );

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: clamp01(arrive * 1.4) * (1 - prog(frame, end - 2, 8, ease.in)),
      }}
    >
      <Camera cam={cam} blur={lerp(6, 0, clamp01(arrive))}>
        <Cockpit
          active={toThreads > 0.5 ? "Threads" : "Code"}
          status={
            <span>
              {toThreads > 0.5 ? "3 threads · 2 working" : `${sD > 0.5 ? 3 : sB > 0.5 ? 2 : 1} panes · 1 running`}
            </span>
          }
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              opacity: 1 - toThreads,
              transform: `translateX(${-toThreads * 60}px)`,
            }}
          >
            {code}
          </div>
          <div
            style={{
              position: "absolute",
              inset: 0,
              opacity: toThreads,
              transform: `translateX(${(1 - toThreads) * 60}px)`,
            }}
          >
            {threads}
          </div>
        </Cockpit>
      </Camera>
      <LowerThird
        frame={frame}
        lines={[
          { at: cf("copy.your_project"), text: copy.yourProject },
          { at: cf("copy.your_terminals"), text: copy.yourTerminals },
          { at: cf("copy.your_browser"), text: copy.yourBrowser },
          { at: cf("copy.your_agents"), text: copy.yourAgents, until: end - 12 },
        ]}
      />
    </div>
  );
};
