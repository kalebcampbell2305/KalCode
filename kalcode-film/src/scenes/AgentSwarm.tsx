// 0:22–0:30 — Four agents, one project. The Dashboard ("Every agent KalCode runs, live")
// fills with four threads launched on the beat. Each thread becomes a LANE of light that
// leaves its card and runs to one `main` line; passing work travels as a packet and lands as
// a commit. One lane fails its tests (red, stalled), is fixed, and passes. Then: "Parallel."
import type React from "react";
import { C, FONT, R } from "../brand/tokens";
import { camAt, Camera, LowerThird } from "../components/camera";
import { cf, Headline, scene, useStage } from "../components/core";
import { copy } from "../data/copy";
import { agentLaunch, drift, ease, lerp, prog } from "../motion";
import { Cockpit, SurfaceTitle } from "../ui/Cockpit";
import { StatusChip, type Tone } from "../ui/kit";

// Four = the verified Stable concurrency (Resource Governor, max_agents 4).
export const LANES = [
  {
    title: "Dashboard cards",
    area: "Desktop UI",
    provider: "Claude Code",
    account: "Personal",
    stack: "React · TypeScript",
    file: "apps/desktop/src/surfaces/dashboard/AgentCard.tsx",
    commit: "feat(desktop): dashboard cards",
    pass: "swarm.pass.0",
  },
  {
    title: "Checkout webhooks",
    area: "API",
    provider: "Codex",
    account: "Personal",
    stack: "Cloudflare Workers · Stripe",
    file: "apps/api/src/stripe.ts",
    commit: "fix(api): webhook retries",
    pass: "swarm.pass.1",
  },
  {
    title: "Push-to-talk hint",
    area: "KalVoice",
    provider: "Codex",
    account: "Work",
    stack: "Rust · whisper.cpp",
    file: "crates/kalvoice/src/shortcuts.rs",
    commit: "feat(kalvoice): hold-F8 hint",
    pass: "swarm.pass.2",
  },
  {
    title: "Pricing page copy",
    area: "Website",
    provider: "Claude Code",
    account: "Work",
    stack: "Astro · Cloudflare Workers",
    file: "apps/website/src/pages/pricing.astro",
    commit: "docs(website): pricing copy",
    pass: "swarm.pass.3",
  },
] as const;

const CARD = { x: 328, y0: 244, pitch: 146, w: 680, h: 128 };
const FAIL_LANE = 1;

type LaneState = { chip: string; tone: Tone; activity: string; done: boolean; failed: boolean };
export const laneState = (i: number, frame: number): LaneState => {
  const L = cf(`swarm.launch.${i}`);
  const pass = cf(LANES[i].pass);
  const d = frame - L;
  if (frame >= pass) return { chip: "Done", tone: "done", activity: "Ready", done: true, failed: false };
  if (i === FAIL_LANE) {
    const fail = cf("swarm.fail");
    const fix = cf("swarm.fix");
    if (frame >= fix)
      return {
        chip: "Working",
        tone: "working",
        activity: frame >= fix + 16 ? "Running a command · pnpm test" : "Editing apps/api/src/stripe.ts",
        done: false,
        failed: false,
      };
    if (frame >= fail)
      return { chip: "Working", tone: "failed", activity: "pnpm test · 1 failed", done: false, failed: true };
  }
  if (d < 0) return { chip: "", tone: "idle", activity: "", done: false, failed: false };
  const act =
    d < 20 ? "Starting" : d < 50 ? "Thinking" : d < 110 ? `Editing ${LANES[i].file}` : "Running a command · pnpm test";
  return { chip: "Working", tone: "working", activity: act, done: false, failed: false };
};

const AgentCard: React.FC<{ i: number; frame: number }> = ({ i, frame }) => {
  const l = LANES[i];
  const L = cf(`swarm.launch.${i}`);
  const a = agentLaunch(frame, L);
  const st = laneState(i, frame);
  const y = CARD.y0 + i * CARD.pitch;
  if (frame < L - 2) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: CARD.x - 300,
        top: y - 70,
        width: CARD.w,
        height: CARD.h,
        transform: `scale(${a.scale})`,
        transformOrigin: "0% 50%",
        opacity: a.opacity,
        borderRadius: R.lg * 1.5,
        background: C.surface1,
        border: `1px solid ${st.failed ? "rgba(239,95,107,0.55)" : st.done ? C.border : C.borderLitSoft}`,
        boxShadow: st.failed
          ? "0 0 30px -8px rgba(239,95,107,0.6)"
          : !st.done
            ? "0 0 26px -10px rgba(76,141,255,0.55)"
            : undefined,
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        fontFamily: FONT.ui,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 23, color: C.text }}>{l.title}</span>
        <span style={{ fontSize: 16, color: C.muted }}>
          {l.provider} · {l.account}
        </span>
        <div style={{ flex: 1 }} />
        {st.chip ? (
          <StatusChip
            tone={st.tone === "failed" ? "failed" : st.tone}
            label={st.failed ? "Failed" : st.chip}
            pulse={st.tone === "working" ? 0.5 + 0.5 * Math.sin(frame / 12) : 0}
          />
        ) : null}
      </div>
      <div
        style={{
          fontFamily: FONT.mono,
          fontSize: 17,
          color: st.failed ? C.failedText : C.text2,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {st.activity}
      </div>
      <div style={{ fontSize: 14.5, color: C.faint }}>
        {l.area} · {l.stack}
      </div>
      {/* launch ring */}
      <div
        style={{
          position: "absolute",
          inset: -2,
          borderRadius: R.lg * 1.5,
          border: `2px solid rgba(141,182,255,${0.8 * a.ringOpacity})`,
          transform: `scale(${1 + 0.08 * a.ring})`,
        }}
      />
    </div>
  );
};

export const AgentSwarm: React.FC<{ frame: number }> = ({ frame }) => {
  const { W, H, portrait } = useStage();
  const { start, end } = scene("swarm");
  if (frame < start - 20 || frame >= end + 6) return null;
  const par = cf("copy.parallel");
  const parT = prog(frame, par - 4, 24, ease.expo);
  const exit = prog(frame, end - 12, 12, ease.in);

  const s1 = portrait ? 1.0 : 1.2;
  const keys = [
    { f: start - 6, s: portrait ? 0.9 : 1.08, fx: 700, fy: 480 },
    { f: cf("swarm.launch.0") + 6, s: s1, fx: 668, fy: 500 },
    { f: par, s: s1 * 1.03, fx: 668, fy: 505 },
    { f: end, s: s1 * 1.08, fx: 668, fy: 505 },
  ];
  const cam = camAt(keys, frame);
  cam.fy += drift(frame, 41, 0.5) * 4;
  const sx = portrait ? W * 0.5 : W * 0.25;
  const sy = portrait ? H * 0.3 : H * 0.5;
  cam.sx = sx;
  cam.sy = sy;

  // lanes live in stage space, anchored to each card's right edge through the camera
  const toStage = (x: number, y: number) => ({ x: sx + (x - cam.fx) * cam.s, y: sy + (y - cam.fy) * cam.s });
  const mainX = portrait ? W * 0.5 : W - 150;
  const working = LANES.filter((_, i) => {
    const s = laneState(i, frame);
    return s.chip === "Working";
  }).length;
  const done = LANES.filter((_, i) => laneState(i, frame).done).length;
  const agents = LANES.filter((_, i) => frame >= cf(`swarm.launch.${i}`)).length;

  const lanes = LANES.map((l, i) => {
    const L = cf(`swarm.launch.${i}`);
    const card = toStage(CARD.x + CARD.w, CARD.y0 + i * CARD.pitch + CARD.h / 2 - 0);
    const x0 = portrait ? toStage(CARD.x + CARD.w / 2, 0).x : card.x + 8;
    const y0 = card.y;
    const grow = prog(frame, L + 4, 40, ease.inOut);
    const st = laneState(i, frame);
    const pass = cf(l.pass);
    const pk = prog(frame, pass - 30, 30, ease.inOut); // packet arrives on pass
    const col = st.failed ? "239,95,107" : "76,141,255";
    const len = (mainX - x0) * grow;
    // activity dashes flow while working
    const flow = ((frame - L) * 3) % 40;
    return (
      <g key={i} opacity={frame < L ? 0 : 1}>
        <line x1={x0} y1={y0} x2={x0 + len} y2={y0} stroke={`rgba(${col},0.55)`} strokeWidth={3} />
        {!st.done ? (
          <line
            x1={x0}
            y1={y0}
            x2={x0 + len}
            y2={y0}
            stroke={`rgba(${col},0.9)`}
            strokeWidth={4}
            strokeDasharray="10 30"
            strokeDashoffset={-flow}
            opacity={st.failed ? 0.4 + 0.4 * Math.sin(frame / 3) : 0.7}
          />
        ) : null}
        {/* the fail stops the packet mid-lane */}
        {st.failed ? (
          <circle
            cx={x0 + (mainX - x0) * 0.45}
            cy={y0}
            r={9}
            fill="rgb(239,95,107)"
            opacity={0.6 + 0.4 * Math.sin(frame / 3)}
          />
        ) : null}
        {pk > 0 && pk < 1 ? (
          <>
            <circle cx={lerp(x0, mainX, pk)} cy={y0} r={10} fill="#a9c8ff" />
            <circle cx={lerp(x0, mainX, pk)} cy={y0} r={26} fill="rgba(76,141,255,0.25)" />
          </>
        ) : null}
        {frame >= pass ? (
          <>
            <circle
              cx={mainX}
              cy={y0}
              r={11 + 8 * Math.exp(-(frame - pass) / 8)}
              fill="#e6edf8"
              stroke="#4c8dff"
              strokeWidth={3}
            />
            <text
              x={mainX - 24}
              y={y0 - 20}
              textAnchor="end"
              fill="#a8b4c9"
              fontFamily={FONT.mono}
              fontSize={17}
              opacity={prog(frame, pass, 12)}
            >
              {l.commit}
            </text>
          </>
        ) : null}
      </g>
    );
  });
  const top = toStage(0, CARD.y0 - 30).y;
  const bot = toStage(0, CARD.y0 + 3 * CARD.pitch + CARD.h + 30).y;

  return (
    <div style={{ position: "absolute", inset: 0, opacity: prog(frame, start - 6, 8) * (1 - exit) }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: lerp(1, 0.28, parT),
          filter: parT > 0.01 ? `blur(${parT * 5}px)` : undefined,
        }}
      >
        <Camera cam={cam}>
          <Cockpit
            active="Dashboard"
            status={
              <span>
                {agents} agents · {working} working
              </span>
            }
          >
            <SurfaceTitle
              title="Dashboard"
              sub="Every agent KalCode runs, live: what it is doing, and what needs you."
            />
            <div style={{ position: "absolute", left: 28, top: 104, display: "flex", gap: 10, alignItems: "center" }}>
              {["All", "Waiting for you", "Working", "Done", "Idle"].map((c) => (
                <span
                  key={c}
                  style={{
                    fontSize: 15.5,
                    padding: "6px 14px",
                    borderRadius: 99,
                    border: `1px solid ${c === "All" ? C.borderLitSoft : C.border}`,
                    background: c === "All" ? C.accentSoft : undefined,
                    color: c === "All" ? C.text : C.text2,
                  }}
                >
                  {c}
                </span>
              ))}
              <span style={{ fontSize: 15.5, color: C.muted, marginLeft: 16 }}>
                {agents} agents · {working} working · 0 waiting for you · {done} done · 0 idle
              </span>
            </div>
            {LANES.map((_, i) => (
              <AgentCard key={i} i={i} frame={frame} />
            ))}
            {/* the right side of the surface falls away so the lanes read as film light, not UI */}
            <div
              style={{
                position: "absolute",
                left: CARD.x - 300 + CARD.w + 20,
                top: 0,
                right: 0,
                bottom: 0,
                background: "linear-gradient(90deg, rgba(5,8,15,0.0), rgba(5,8,15,0.9) 20%)",
              }}
            />
          </Cockpit>
        </Camera>
        <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
          <defs>
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="5" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <g filter="url(#glow)">
            <line
              x1={mainX}
              y1={top}
              x2={mainX}
              y2={lerp(top, bot, prog(frame, cf("swarm.launch.0"), 60, ease.inOut))}
              stroke="rgba(141,182,255,0.9)"
              strokeWidth={3}
            />
            {lanes}
          </g>
          <text
            x={mainX}
            y={top - 18}
            textAnchor="middle"
            fill="#8db6ff"
            fontFamily={FONT.mono}
            fontSize={20}
            opacity={prog(frame, cf("swarm.launch.0") + 20, 20)}
          >
            main
          </text>
        </svg>
      </div>
      {/* PARALLEL */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
          transform: `scale(${lerp(1, 1.05, prog(frame, par, end - par, ease.linear))})`,
        }}
      >
        <Headline
          text={copy.parallel}
          frame={frame}
          start={par}
          size={portrait ? 190 : 240}
          weight={600}
          gap={0}
          tracking="-0.045em"
          exit={end - 10}
          style={{ textShadow: "0 0 60px rgba(76,141,255,0.45)" }}
        />
      </div>
      <LowerThird
        frame={frame}
        lines={[
          { at: cf("copy.different_tasks"), text: copy.differentTasks },
          { at: cf("copy.same_project"), text: copy.sameProject, until: par - 8 },
        ]}
      />
    </div>
  );
};
