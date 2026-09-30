// 0:00–0:06 — Too many windows. Separate terminals, provider CLIs on separate accounts,
// a browser, docs, git and build output stack up; focus jumps between them; then everything
// accelerates inward to a single point and half a beat of silence.
import type React from "react";
import { C, FONT } from "../brand/tokens";
import { CUE, cf, cues, Scrim, useStage } from "../components/core";
import { EnergyTrace, KineticText } from "../components/fx";
import { Plane, Space } from "../components/space";
import { copy } from "../data/copy";
import { clamp01, drift, ease, lerp, prog, rng, springIn, terminalType } from "../motion";

type Win = { title: string; kind: "term" | "browser" | "doc" | "git" | "log" | "chat"; lines: string[] };

// Sanitized, fictional content. No real sessions, accounts, emails or paths.
const WINDOWS: Win[] = [
  {
    title: "Terminal — claude",
    kind: "term",
    lines: ["$ claude", "> fix the login redirect", "Reading src/auth/session.ts"],
  },
  { title: "Terminal — codex", kind: "term", lines: ["$ codex", "> review the billing webhook", "Thinking…"] },
  { title: "Browser — localhost:4321", kind: "browser", lines: [] },
  {
    title: "Terminal — claude (second account)",
    kind: "term",
    lines: ["$ claude", "Usage limit reached.", "Try again later."],
  },
  {
    title: "git — main",
    kind: "git",
    lines: [
      "* 3f2a91c fix: token refresh",
      "* 8c01d4e feat: voice pane",
      "| * 71b9e02 wip: dashboard",
      "|/",
      "* 5d7e3a0 chore: release",
    ],
  },
  { title: "Docs — CLI reference", kind: "doc", lines: [] },
  {
    title: "Terminal — pnpm test",
    kind: "log",
    lines: ["✓ account.test.ts (12)", "✓ session.test.ts (8)", "✗ refresh.test.ts (1)", "Tests  1 failed | 20 passed"],
  },
  {
    title: "Terminal — codex (work account)",
    kind: "term",
    lines: ["$ codex", "> update the pricing page", "Editing apps/website/…"],
  },
  {
    title: "Chat",
    kind: "chat",
    lines: ["did the build pass?", "which terminal was that in", "check the other window"],
  },
  {
    title: "Terminal — build",
    kind: "log",
    lines: ["> vite build", "transforming (1284) modules", "✓ built in 14.2s"],
  },
  { title: "Terminal — claude (work)", kind: "term", lines: ["$ claude", "> write the e2e test", "Working…"] },
  { title: "Release checklist", kind: "doc", lines: [] },
  {
    title: "Terminal — dev server",
    kind: "log",
    lines: ["VITE ready", "➜ Local: http://localhost:5173/", "page reload src/App.tsx"],
  },
  { title: "Browser — Docs", kind: "browser", lines: [] },
  { title: "Terminal — deploy", kind: "log", lines: ["$ wrangler deploy", "Uploading…", "Is this the right account?"] },
  { title: "Terminal — claude", kind: "term", lines: ["$ claude", "> which branch am I on", "…"] },
  {
    title: "git — status",
    kind: "git",
    lines: ["M apps/desktop/src/App.tsx", "M crates/voice/src/lib.rs", "?? notes.md"],
  },
  { title: "Terminal — codex", kind: "term", lines: ["$ codex", "> run the migration", "Waiting for you"] },
];

const TitleBar: React.FC<{ title: string; focus: number }> = ({ title, focus }) => (
  <div
    style={{
      height: 36,
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "0 12px",
      background: focus > 0.5 ? "#131d31" : "#0c1322",
      borderBottom: `1px solid ${C.borderSubtle}`,
      fontFamily: FONT.ui,
      fontSize: 15,
      color: focus > 0.5 ? C.text : C.muted,
      whiteSpace: "nowrap",
      overflow: "hidden",
    }}
  >
    {[0, 1, 2].map((i) => (
      <span key={i} style={{ width: 10, height: 10, borderRadius: 9, background: "rgba(142,170,220,0.22)" }} />
    ))}
    <span style={{ marginLeft: 8 }}>{title}</span>
  </div>
);

const Body: React.FC<{ w: Win; frame: number; start: number; seed: number }> = ({ w, frame, start, seed }) => {
  if (w.kind === "browser" || w.kind === "doc") {
    const r = rng(seed);
    return (
      <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ height: 18, width: `${40 + r() * 30}%`, borderRadius: 4, background: "rgba(142,170,220,0.2)" }} />
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            style={{ height: 9, width: `${55 + r() * 40}%`, borderRadius: 3, background: "rgba(142,170,220,0.09)" }}
          />
        ))}
      </div>
    );
  }
  return (
    <div style={{ padding: "12px 16px", fontFamily: FONT.mono, fontSize: 19, lineHeight: 1.55, color: C.text2 }}>
      {w.lines.map((l, i) => {
        const shown = terminalType(l, frame, start + 6 + i * 16, 34, seed * 7 + i);
        const bad = l.startsWith("✗") || l.includes("failed") || l.includes("limit");
        return (
          <div
            key={i}
            style={{ whiteSpace: "pre", color: bad ? C.failedText : l.startsWith("✓") ? C.workingText : undefined }}
          >
            {shown}
          </div>
        );
      })}
    </div>
  );
};

export const Chaos: React.FC<{ frame: number }> = ({ frame }) => {
  const { portrait } = useStage();
  const pops = cues("chaos.window.");
  const collapse = cf("collapse.start");
  const silence = cf("silence");
  if (frame >= silence) return null;
  const k = prog(frame, collapse, silence - collapse, ease.anticipate); // implode (dips outward first)
  const build = prog(frame, 0, collapse, ease.inOut);
  const lastPop = pops.filter((p) => p.frame <= frame).length - 1;

  // world poses: seeded, later windows nearer the camera and nearer the centre
  const poses = pops.map((_p, i) => {
    const r = rng(1000 + i * 31);
    const spread = i < 3 ? 0.45 : 1 - i / (pops.length * 1.5);
    const w = ((portrait ? 700 : 660) + r() * 260) * (i < 3 ? 1.25 : 1);
    const h = (300 + r() * 170) * (i < 3 ? 1.25 : 1);
    return {
      w,
      h,
      x: (r() - 0.5) * (portrait ? 900 : 2300) * spread,
      y: (r() - 0.5) * (portrait ? 1900 : 1150) * spread,
      z: i < 3 ? -200 * i : -1300 + r() * 900 + i * 40,
      rx: (r() - 0.5) * 22,
      ry: (r() - 0.5) * 34,
      rz: (r() - 0.5) * 6,
    };
  });
  const focusZ = lastPop >= 0 ? poses[lastPop].z : 0;
  // camera: dollies in and orbits as the pile grows; a handheld tremor rises with the pressure
  const shake = 4 + 14 * build;
  const cam = {
    x: drift(frame, 3, 1.2) * shake,
    y: drift(frame, 5, 1.2) * shake * 0.6,
    z: lerp(700, -150, build),
    rx: lerp(7, -3, build) + drift(frame, 7, 0.8) * 1.2,
    ry: lerp(-12, 10, build),
    rz: drift(frame, 9, 0.9) * 1.5 * build,
  };

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Space cam={cam}>
        {pops.map((p, i) => {
          if (frame < p.frame) return null;
          const P = poses[i];
          const s = springIn(frame, p.frame, { damping: 13, stiffness: 190, mass: 0.7 });
          const focus = i === lastPop ? 1 : 0;
          const kk = clamp01(k);
          const pose = {
            x: lerp(P.x, 0, kk),
            y: lerp(P.y, 0, kk),
            z: lerp(lerp(P.z - 1200, P.z, s), 0, kk),
            rx: P.rx * (1 - kk) + (1 - s) * 30,
            ry: P.ry * (1 - kk) + (1 - s) * -40,
            rz: P.rz * (1 - kk),
            s: lerp(1, 0.04, kk),
            o: clamp01(s * 2.5) * (1 - clamp01((k - 0.85) / 0.15)),
          };
          // rack focus: sharp at the newest window's depth, softer with distance from it
          const dof = focus ? 0 : Math.min(9, Math.abs(P.z - focusZ) / 170);
          return (
            <Plane key={i} pose={{ ...pose, z: (pose.z ?? 0) + i * 2 }} w={P.w} h={P.h} blur={dof * (1 - kk)}>
              <div
                style={{
                  width: P.w,
                  height: P.h,
                  borderRadius: 10,
                  overflow: "hidden",
                  background: "#0e1729",
                  border: `1px solid ${focus ? C.borderLit : "rgba(142,170,220,0.24)"}`,
                  boxShadow: focus
                    ? "0 30px 80px -20px rgba(0,0,0,0.9), 0 0 50px -12px rgba(76,141,255,0.6)"
                    : "0 30px 80px -24px rgba(0,0,0,0.9)",
                  filter: `brightness(${focus ? 1.35 : 1.05})`,
                }}
              >
                <TitleBar title={WINDOWS[i % WINDOWS.length].title} focus={focus} />
                <Body w={WINDOWS[i % WINDOWS.length]} frame={frame} start={p.frame} seed={i + 1} />
              </div>
              {focus ? <EnergyTrace w={P.w} h={P.h} r={10} frame={frame} start={p.frame} speed={1.6} /> : null}
            </Plane>
          );
        })}
      </Space>
      <Scrim amount={0.45 * prog(frame, cf("copy.too_many") - 8, 20) * (1 - clamp01(k * 3))} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 26,
          padding: portrait ? "0 70px" : 0,
        }}
      >
        <KineticText
          text={copy.tooMany}
          frame={frame}
          land={cf("copy.too_many")}
          per={6}
          size={portrait ? 110 : 128}
          exit={collapse}
        />
        <KineticText
          text={copy.switching}
          frame={frame}
          land={cf("copy.switching")}
          per={3}
          size={portrait ? 52 : 54}
          weight={400}
          color={C.text2}
          exit={collapse}
          tracking="-0.01em"
        />
      </div>
    </div>
  );
};

export const CHAOS_END = () => CUE.scenes[0].end.frame;
