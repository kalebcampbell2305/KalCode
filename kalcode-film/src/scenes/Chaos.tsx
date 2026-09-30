// 0:00–0:06 — Too many windows. Separate terminals, provider CLIs on separate accounts,
// a browser, docs, git and build output stack up; focus jumps between them; then everything
// accelerates inward to a single point and half a beat of silence.
import type React from "react";
import { C, FONT } from "../brand/tokens";
import { CUE, Headline, Scrim, cf, cues, useStage } from "../components/core";
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
  const { W, H, portrait } = useStage();
  const pops = cues("chaos.window.");
  const collapse = cf("collapse.start");
  const silence = cf("silence");
  const k = prog(frame, collapse, silence - collapse, ease.anticipate); // inward acceleration
  const cx = W / 2;
  const cy = H / 2;
  // focus jumps to the newest window on every pop
  const lastPop = pops.filter((p) => p.frame <= frame).length - 1;
  // slow camera drift + creeping push while chaos builds
  const push = lerp(1, 1.08, prog(frame, 0, collapse, ease.inOut));
  const camX = drift(frame, 3, 0.6) * 14;
  const camY = drift(frame, 5, 0.6) * 9;

  if (frame >= silence) return null;

  return (
    <div style={{ position: "absolute", inset: 0, perspective: 1800, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `translate(${camX}px, ${camY}px) scale(${push})`,
          transformStyle: "preserve-3d",
        }}
      >
        {pops.map((p, i) => {
          if (frame < p.frame) return null;
          const r = rng(1000 + i * 31);
          const w = WINDOWS[i % WINDOWS.length];
          const big = i < 3 ? 1.3 : 1;
          const ww = ((portrait ? 640 : 660) + r() * 260) * big;
          const hh = (300 + r() * 170) * big;
          // spread across frame; later windows land closer to centre, so the pile thickens
          const spread = i < 3 ? 0.35 + 0.2 * i : 1 - i / (pops.length * 1.6);
          const x0 = cx + (r() - 0.5) * (W - ww * 0.6) * spread - ww / 2;
          const y0 = cy + (r() - 0.5) * (H - hh * 0.8) * spread - hh / 2;
          const z = i < 3 ? 60 - i * 40 : -300 + r() * 380 + i * 12;
          const s = springIn(frame, p.frame, { damping: 13, stiffness: 240, mass: 0.6 });
          const rot = (r() - 0.5) * 7;
          const focus = i === lastPop ? 1 : 0;
          const age = clamp01((frame - p.frame) / 90);
          // collapse: everything flies to centre, scaling down, with motion streaks
          const tx = lerp(x0, cx - ww / 2, k);
          const ty = lerp(y0, cy - hh / 2, k);
          const sc = lerp(lerp(0.9, 1, s), 0.04, clamp01(k));
          const depthBlur = focus ? 0 : Math.max(0, (-z / 300) * 2.2) * (0.4 + age);
          const streak =
            Math.abs(k) > 0.02
              ? Math.min(
                  14,
                  Math.abs(
                    prog(frame, collapse, silence - collapse, ease.anticipate) -
                      prog(frame - 1, collapse, silence - collapse, ease.anticipate),
                  ) * 300,
                )
              : 0;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: ww,
                height: hh,
                transform: `translate3d(${tx}px, ${ty}px, ${z * (1 - clamp01(k))}px) rotate(${rot * (1 - clamp01(k))}deg) scale(${sc})`,
                opacity: clamp01(s * 2) * (1 - clamp01((k - 0.85) / 0.15)),
                filter: `blur(${depthBlur + streak}px) brightness(${focus ? 1.12 : 0.9 - 0.18 * age})`,
                borderRadius: 10,
                overflow: "hidden",
                background: C.surface1,
                border: `1px solid ${focus ? C.borderLit : C.border}`,
                boxShadow: focus
                  ? "0 0 0 1px rgba(92,150,255,0.4), 0 30px 80px -20px rgba(0,0,0,0.9), 0 0 40px -12px rgba(76,141,255,0.5)"
                  : "0 30px 80px -24px rgba(0,0,0,0.9)",
                zIndex: i,
              }}
            >
              <TitleBar title={w.title} focus={focus} />
              <Body w={w} frame={frame} start={p.frame} seed={i + 1} />
            </div>
          );
        })}
      </div>
      {/* copy */}
      <Scrim amount={0.5 * prog(frame, cf("copy.too_many") - 8, 20) * (1 - clamp01(k * 3))} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 26,
          padding: portrait ? "0 80px" : 0,
        }}
      >
        <Headline
          text={copy.tooMany}
          frame={frame}
          start={cf("copy.too_many")}
          size={portrait ? 104 : 120}
          exit={collapse}
          style={{ textShadow: "0 4px 40px rgba(3,5,11,0.95), 0 0 80px rgba(3,5,11,0.9)" }}
        />
        <Headline
          text={copy.switching}
          frame={frame}
          start={cf("copy.switching")}
          size={portrait ? 50 : 52}
          weight={400}
          color={C.text2}
          exit={collapse}
          tracking="-0.01em"
          style={{ textShadow: "0 2px 24px rgba(3,5,11,0.95)" }}
        />
      </div>
    </div>
  );
};

export const CHAOS_END = () => CUE.scenes[0].end.frame;
