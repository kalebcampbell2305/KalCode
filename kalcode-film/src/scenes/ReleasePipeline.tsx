// 0:42–0:50 — Build. Test. Ship. The four lanes converge into `main`; `main` becomes one
// rail through the repo's real release commands. Each gate lights only after it passes; the
// push waits on a KalCode approval ("Approve once"). SHIP at 48.000: the release lands on
// kalcoded.com/updates and a macOS KalCode window offers "Restart to update".
import type React from "react";
import { C, FONT } from "../brand/tokens";
import { Bloom, cf, cues, scene, useStage } from "../components/core";
import { KineticText, LightSweep } from "../components/fx";
import { copy } from "../data/copy";
import { drift, ease, lerp, prog, shipHit, springIn } from "../motion";
import { AtlasPage } from "../ui/atlas";
import { Panel } from "../ui/kit";
import { ApprovalCard, BrowserBody, TerminalBody } from "../ui/surfaces";

// sample project (atlas) release: the repo's own commands, run by the agents; the push waits on a KalCode approval
const GATES: { stage: string; cmd: string; sub?: string; approval?: boolean }[] = [
  { stage: "review", cmd: "Codex review" },
  { stage: "test", cmd: "pnpm test" },
  { stage: "merge", cmd: "git merge" },
  { stage: "build", cmd: "pnpm build" },
  { stage: "approve", cmd: "git push origin main", approval: true },
  { stage: "deploy", cmd: "wrangler deploy" },
  { stage: "smoke", cmd: "pnpm test:e2e" },
  { stage: "live", cmd: "atlas.app" },
];

export const ReleasePipeline: React.FC<{ frame: number }> = ({ frame }) => {
  const { W, H, portrait } = useStage();
  const { start, end } = scene("pipeline");
  if (frame < start - 12 || frame >= end + 24) return null;
  const stageCues = cues("pipe.stage.");
  const approveAt = cf("pipe.approve");
  const gateAt = (i: number) => (i < 4 ? stageCues[i].frame : i === 4 ? approveAt : stageCues[i - 1].frame);
  const ship = cf("hit.ship");
  const h = shipHit(frame, ship);
  const after = prog(frame, ship + 10, 40, ease.inOut); // pipeline recedes for the payoff cards
  const enter = prog(frame, start - 6, 10, ease.out);

  // rail geometry
  const n = GATES.length;
  const railA = portrait ? { x: W / 2, y: 520 } : { x: 330, y: H * 0.53 };
  const railB = portrait ? { x: W / 2, y: H - 230 } : { x: W - 130, y: H * 0.53 };
  const gp = (i: number) => {
    const u = (i + 0.5) / n;
    return { x: lerp(railA.x + (portrait ? 0 : 90), railB.x, u), y: lerp(railA.y + (portrait ? 90 : 0), railB.y, u) };
  };
  const mainNode = railA;
  // the packet: runs to each gate at its pass time
  const passed = GATES.map((_, i) => frame >= gateAt(i));
  const lastPassed = passed.lastIndexOf(true);
  const nextI = Math.min(n - 1, lastPassed + 1);
  const prevF = lastPassed >= 0 ? gateAt(lastPassed) : cf("pipe.converge");
  const nextF = gateAt(nextI);
  const u = lastPassed === n - 1 ? 1 : prog(frame, prevF, Math.max(1, nextF - prevF), ease.inOut);
  const pFrom = lastPassed >= 0 ? gp(lastPassed) : mainNode;
  const pTo = gp(nextI);
  const pkt = { x: lerp(pFrom.x, pTo.x, u), y: lerp(pFrom.y, pTo.y, u) };
  const railGrow = prog(frame, start, 40, ease.inOut);

  // four lanes converge into main from the left (continuity with the swarm)
  const converge = prog(frame, start - 12, 36, ease.inOut);
  const laneSrc = (k: number) =>
    portrait ? { x: lerp(140, W - 140, k / 3), y: 300 } : { x: 60, y: lerp(H * 0.3, H * 0.78, k / 3) };

  const kick = h.kick * 10;
  const approvalS =
    springIn(frame, cf("pipe.approval"), { damping: 16, stiffness: 230 }) *
    (1 - prog(frame, approveAt + 14, 12, ease.in));
  const press = prog(frame, approveAt - 6, 6) * (1 - prog(frame, approveAt, 8));
  const siteS = springIn(frame, cf("pipe.live"), { damping: 16, stiffness: 150 });
  const updS = springIn(frame, cf("pipe.dash"), { damping: 15, stiffness: 150 });

  const words = [
    { at: cf("copy.w_build"), t: copy.wBuild },
    { at: cf("copy.w_test"), t: copy.wTest },
    { at: cf("copy.w_ship"), t: copy.wShip },
  ];

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: enter * (1 - prog(frame, end - 2, 8, ease.in)),
        transform: `translate(${drift(frame, 71, 1) * kick}px, ${kick * 0.6}px)`,
      }}
    >
      <Bloom x={pkt.x} y={pkt.y} r={320} o={0.35 * (1 - after)} />
      <Bloom x={W / 2} y={H / 2} r={W * 0.7} o={0.9 * h.flash} />
      {/* the words, one at a time, on one line */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: portrait ? 170 : 110,
          display: "flex",
          justifyContent: "center",
          gap: portrait ? 26 : 40,
          opacity: 1 - prog(frame, end - 16, 14, ease.in),
        }}
      >
        {words.map((w) => (
          <KineticText
            key={w.t}
            text={w.t}
            frame={frame}
            land={w.at}
            per={0}
            size={portrait ? 108 : 128}
            weight={700}
            from={w.t === copy.wShip ? "depth" : "below"}
            tracking="-0.045em"
          />
        ))}
      </div>
      <svg
        width={W}
        height={H}
        style={{
          position: "absolute",
          inset: 0,
          opacity: 1 - after * 0.85,
          transform: `perspective(1700px) translateX(${portrait ? 0 : -(pkt.x - W / 2) * 0.3}px) rotateX(${portrait ? 0 : 30 - 22 * after}deg) rotateY(${portrait ? 0 : -6 + 12 * prog(frame, start, ship - start, ease.inOut)}deg) scale(${(portrait ? 1 : lerp(1.0, 1.1, prog(frame, start, ship - start, ease.inOut))) * (1 - 0.08 * after)})`,
          transformOrigin: portrait ? "50% 60%" : `${pkt.x}px ${railA.y}px`,
          filter: after > 0.01 ? `blur(${after * 4}px)` : undefined,
        }}
      >
        <defs>
          <filter id="pglow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g filter="url(#pglow)">
          {[0, 1, 2, 3].map((k) => {
            const s = laneSrc(k);
            const mx = portrait ? (s.x + mainNode.x) / 2 : (s.x + mainNode.x) / 2;
            const d = portrait
              ? `M ${s.x} ${s.y} C ${s.x} ${(s.y + mainNode.y) / 2}, ${mainNode.x} ${(s.y + mainNode.y) / 2}, ${mainNode.x} ${mainNode.y}`
              : `M ${s.x} ${s.y} C ${mx} ${s.y}, ${mx} ${mainNode.y}, ${mainNode.x} ${mainNode.y}`;
            return (
              <path
                key={k}
                d={d}
                fill="none"
                stroke="rgba(76,141,255,0.8)"
                strokeWidth={3}
                pathLength={1}
                strokeDasharray="1 1"
                strokeDashoffset={1 - converge}
              />
            );
          })}
          <line
            x1={mainNode.x}
            y1={mainNode.y}
            x2={lerp(mainNode.x, railB.x, railGrow)}
            y2={lerp(mainNode.y, railB.y, railGrow)}
            stroke="rgba(141,182,255,0.55)"
            strokeWidth={3}
          />
          <line x1={mainNode.x} y1={mainNode.y} x2={pkt.x} y2={pkt.y} stroke="#8db6ff" strokeWidth={4} />
          <circle
            cx={mainNode.x}
            cy={mainNode.y}
            r={14}
            fill="#e6edf8"
            stroke="#4c8dff"
            strokeWidth={4}
            opacity={converge}
          />
          {GATES.map((g, i) => {
            const p = gp(i);
            const on = passed[i];
            const hot = on ? Math.exp(-(frame - gateAt(i)) / 10) : 0;
            const appear = prog(frame, start + 6 + i * 3, 20);
            const r = g.approval ? 16 : 18;
            return (
              <g key={g.stage} opacity={appear}>
                <circle cx={p.x} cy={p.y} r={r + 22 * hot} fill={`rgba(76,141,255,${0.35 * hot})`} />
                {g.approval ? (
                  <rect
                    x={p.x - r}
                    y={p.y - r}
                    width={r * 2}
                    height={r * 2}
                    transform={`rotate(45 ${p.x} ${p.y})`}
                    fill={on ? "#e6edf8" : "#0b1322"}
                    stroke={on ? "#4c8dff" : "rgba(142,170,220,0.4)"}
                    strokeWidth={3}
                  />
                ) : (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={r}
                    fill={on ? "#e6edf8" : "#0b1322"}
                    stroke={on ? "#4c8dff" : "rgba(142,170,220,0.4)"}
                    strokeWidth={3}
                  />
                )}
              </g>
            );
          })}
          <circle cx={pkt.x} cy={pkt.y} r={11} fill="#a9c8ff" opacity={frame >= start ? 1 : 0} />
          {/* ship ring */}
          <circle
            cx={gp(n - 1).x}
            cy={gp(n - 1).y}
            r={20 + h.ring * 900}
            fill="none"
            stroke={`rgba(141,182,255,${0.8 * h.ringOpacity})`}
            strokeWidth={3}
          />
        </g>
        <text
          x={mainNode.x}
          y={portrait ? mainNode.y - 30 : mainNode.y - 34}
          textAnchor="middle"
          fill="#8db6ff"
          fontFamily={FONT.mono}
          fontSize={22}
          opacity={converge}
        >
          main
        </text>
        {GATES.map((g, i) => {
          const p = gp(i);
          const on = passed[i];
          const appear = prog(frame, start + 6 + i * 3, 20);
          const lx = portrait ? p.x + 44 : p.x;
          const ly = portrait ? p.y - 4 : p.y + (i % 2 === 0 ? 66 : -66);
          return (
            <g key={g.stage} opacity={appear}>
              <text
                x={lx}
                y={ly}
                textAnchor={portrait ? "start" : "middle"}
                fill={on ? "#e6edf8" : "#8593ab"}
                fontFamily={FONT.ui}
                fontSize={portrait ? 32 : 28}
              >
                {g.stage}
              </text>
              <text
                x={lx}
                y={ly + (portrait ? 30 : 28)}
                textAnchor={portrait ? "start" : "middle"}
                fill={on ? "#8db6ff" : "#7a879e"}
                fontFamily={FONT.mono}
                fontSize={portrait ? 21 : 19}
              >
                {g.cmd}
                {g.sub ? ` · ${g.sub}` : ""}
              </text>
            </g>
          );
        })}
      </svg>
      {/* the approval gate: a real KalCode approval card */}
      {approvalS > 0.01 ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: portrait ? H * 0.5 : H * 0.62,
            display: "flex",
            justifyContent: "center",
            opacity: approvalS,
            transform: `translateY(${(1 - approvalS) * 40}px) scale(${(portrait ? 0.9 : 0.95) * (0.94 + 0.06 * approvalS)})`,
          }}
        >
          <ApprovalCard press={press} resolved={frame >= approveAt ? 1 : 0} />
        </div>
      ) : null}
      {/* SHIP payoff: atlas is live — the new pricing page in production, the deploy, every agent done */}
      {siteS > 0.01 ? (
        <div
          style={{
            position: "absolute",
            left: portrait ? 60 : 110,
            top: portrait ? 430 : 300,
            width: portrait ? 960 : 1000,
            height: portrait ? 640 : 600,
            opacity: siteS,
            transform: `perspective(1800px) translate3d(${(1 - siteS) * -300}px, ${(1 - siteS) * 80}px, ${-(1 - siteS) * 600}px) rotateY(${(portrait ? 0 : 14) * (1 - siteS) + (portrait ? 0 : 6)}deg)`,
            borderRadius: 14,
            overflow: "hidden",
            border: `1px solid ${C.borderLit}`,
            boxShadow: "0 40px 90px -20px rgba(0,0,0,0.9), 0 0 60px -16px rgba(76,141,255,0.6)",
            background: C.surface1,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <BrowserBody url="https://atlas.app/pricing">
            <AtlasPage variant="new" t={1} />
            <LightSweep frame={frame} at={cf("pipe.live") + 4} dur={34} strength={0.4} />
          </BrowserBody>
        </div>
      ) : null}
      {updS > 0.01 ? (
        <div
          style={{
            position: "absolute",
            left: portrait ? 90 : 1160,
            top: portrait ? 1110 : 360,
            width: portrait ? 900 : 660,
            height: portrait ? 360 : 400,
            opacity: updS,
            transform: `perspective(1800px) translate3d(${(1 - updS) * 300}px, ${(1 - updS) * 80}px, ${-(1 - updS) * 600}px) rotateY(${(portrait ? 0 : -14) * (1 - updS) + (portrait ? 0 : -6)}deg)`,
          }}
        >
          <Panel lit={1} style={{ width: "100%", height: "100%" }}>
            <TerminalBody
              size={portrait ? 22 : 20}
              lines={[
                { text: "PS ~\\Projects\\atlas> wrangler deploy", color: C.text },
                { text: "  Uploaded atlas-web", color: C.muted },
                { text: "  Deployed atlas-web", color: C.workingText },
                { text: "  https://atlas.app", color: C.accentText },
                { text: "" },
                { text: "4 agents · 0 working · 0 waiting for you · 4 done", color: C.text2 },
              ]}
            />
          </Panel>
        </div>
      ) : null}
      <div style={{ position: "absolute", right: 24, bottom: 16, fontFamily: FONT.mono, fontSize: 13, color: C.faint }}>
        {copy.sample}
      </div>
    </div>
  );
};
