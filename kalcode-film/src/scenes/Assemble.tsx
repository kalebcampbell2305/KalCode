// 0:06–0:16 — one continuous 3D shot.
// HIT: the mark blooms inside 3D orbit rings; "Introducing KalCode." lands word-per-beat.
// The camera dollies INTO the mark and through it; the KalCode window assembles in space:
// every part flies from depth on its own spring and docks on a beat. Then the camera pushes
// into the terminal, whips to the Browser pane, and pulls back while the Code panes flip
// away and the Threads surface unfolds.
import { Plus } from "lucide-react";
import type React from "react";
import { C, FONT, shadowXl } from "../brand/tokens";
import { cf, scene, useStage } from "../components/core";
import { EnergyTrace, KineticText, LightSweep } from "../components/fx";
import { type Cam, lerpPose, Plane, type Pose, Space } from "../components/space";
import { copy } from "../data/copy";
import { clamp01, drift, ease, flight, lerp, prog, shipHit, springIn, terminalType } from "../motion";
import { AtlasPage } from "../ui/atlas";
import { Button, CodeHeader, SurfaceTitle, VoiceWidget } from "../ui/Cockpit";
import { Icon, Panel, Sidebar, Symbol } from "../ui/kit";
import { BrowserBody, Composer, TerminalBody, type Thread, ThreadHeader, ThreadRow, Transcript } from "../ui/surfaces";
import { DashMini } from "./Workspace";

type Rect = { x: number; y: number; w: number; h: number };
const CANVAS = { x0: -640, y0: -406, W: 1580, H: 894 };
const toWorld = (r: Rect) => ({
  x: CANVAS.x0 + (r.x + r.w / 2) * CANVAS.W - 6,
  y: CANVAS.y0 + (r.y + r.h / 2) * CANVAS.H - 6,
  w: r.w * CANVAS.W - 12,
  h: r.h * CANVAS.H - 12,
});
const LR = (a: Rect, b: Rect, t: number): Rect => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
});

export const THREADS_ATLAS: Thread[] = [
  { title: "Checkout flow", provider: "Claude Code", account: "Personal", status: "Editing", tone: "working" },
  { title: "Webhook retries", provider: "Codex", account: "Personal", status: "Thinking", tone: "working" },
  { title: "Pricing page copy", provider: "Claude Code", account: "Personal", status: "Ready", tone: "idle" },
];

const devLines = (frame: number, start: number) => {
  const out: { text: string; color?: string }[] = [
    { text: `PS ~\\Projects\\atlas> ${terminalType("pnpm dev", frame, start, 16, 3)}`, color: C.text },
  ];
  const a = start + 40;
  if (frame > a) out.push({ text: "> vite", color: C.muted });
  if (frame > a + 10) out.push({ text: "  VITE v8.3  ready", color: C.workingText });
  if (frame > a + 18) out.push({ text: "  ➜  Local:   http://localhost:5173/", color: C.text2 });
  if (frame > a + 26) out.push({ text: "  ➜  press h + enter to show help", color: C.muted });
  if (frame > a + 60) out.push({ text: "  hmr update /src/routes/checkout.tsx", color: C.muted });
  if (frame > a + 84) out.push({ text: "  hmr update /src/components/PlanCard.tsx", color: C.muted });
  return out;
};

export const Assemble: React.FC<{ frame: number }> = ({ frame }) => {
  const { W, H, portrait } = useStage();
  const intro = scene("introduce");
  const ws = scene("workspace");
  if (frame < intro.start - 2 || frame >= ws.end + 2) return null;

  // ---------------------------------------------------------------- beats (frames)
  const hit = cf("hit.product");
  const push = cf("intro.push"); // 9.0: dolly into the mark
  const through = push + 30; // 9.5: through the mark
  const dock = { plate: 585, side: 600, head: 615, voice: 630, term: 645, status: 660 };
  const split = cf("ws.split.browser"); // 11.5
  const inTerm = cf("copy.your_terminals"); // 12.0
  const whip = cf("copy.your_browser") - 6; // 12.9
  const load = cf("copy.your_browser"); // 13.0
  const dashAt = cf("ws.split.dash"); // 13.5
  const toThreads = cf("ws.threads"); // 14.0

  // ---------------------------------------------------------------- the mark + orbits (screen space)
  const h = shipHit(frame, hit);
  const bloom = springIn(frame, hit, { damping: 12, stiffness: 110, mass: 1 });
  const dolly = prog(frame, push, through - push + 10, ease.in); // accelerate into the mark
  const hold = prog(frame, hit, push - hit, ease.inOut); // slow dolly across the whole hold
  const markS = lerp(0.55, 1, bloom) * (1 + 0.12 * hold) * (1 + dolly * dolly * 9);
  const markO = clamp01(bloom * 1.6) * (1 - prog(frame, through - 8, 10));
  const cy = portrait ? H * 0.36 : H * 0.4;
  const orbitSpin = (frame - hit) * 0.5;

  // ---------------------------------------------------------------- 3D camera path
  const camKeys: { f: number; c: Cam }[] = [
    { f: through - 26, c: { x: 0, y: 0, z: 2400, rx: -14, ry: 26 } },
    { f: dock.status + 10, c: { x: 40, y: 10, z: portrait ? 350 : 420, rx: -4, ry: 9 } },
    { f: split, c: { x: 0, y: 0, z: portrait ? 320 : 380, rx: -2, ry: 4 } },
    { f: inTerm + 20, c: { x: -380, y: -80, z: portrait ? -100 : -520, rx: 0, ry: -6 } },
    { f: whip, c: { x: -330, y: -80, z: portrait ? -100 : -560, rx: 0, ry: -7 } },
    { f: whip + 14, c: { x: 520, y: -150, z: portrait ? -100 : -480, rx: 1, ry: 8 } },
    { f: toThreads - 4, c: { x: 470, y: -80, z: portrait ? -150 : -300, rx: 1, ry: 6 } },
    { f: toThreads + 34, c: { x: 60, y: -20, z: portrait ? 250 : 300, rx: -3, ry: -10 } },
    { f: ws.end, c: { x: 90, y: -30, z: portrait ? 200 : 180, rx: -2, ry: -6 } },
  ];
  let cam = camKeys[0].c;
  for (let i = 1; i < camKeys.length; i++) {
    const a = camKeys[i - 1];
    const b = camKeys[i];
    if (frame >= a.f) {
      const isWhip = a.f === whip;
      const t = prog(frame, a.f, b.f - a.f, isWhip ? ease.inOut : ease.emphasized);
      cam = {
        x: lerp(a.c.x, b.c.x, t),
        y: lerp(a.c.y, b.c.y, t),
        z: lerp(a.c.z, b.c.z, t),
        rx: lerp(a.c.rx ?? 0, b.c.rx ?? 0, t),
        ry: lerp(a.c.ry ?? 0, b.c.ry ?? 0, t),
      };
    }
  }
  cam = {
    ...cam,
    x: cam.x + drift(frame, 131, 0.5) * 10,
    y: cam.y + drift(frame, 132, 0.5) * 6,
    ry: (cam.ry ?? 0) + drift(frame, 133, 0.4) * 0.6,
  };
  const worldOn = frame >= through - 24;

  // ---------------------------------------------------------------- flights
  const fly = (at: number, from: Pose, to: Pose, cfg = {}) =>
    lerpPose(from, to, flight(frame, at - 18, { damping: 15, stiffness: 150, ...cfg }));
  const plate = lerpPose(
    { z: -1800, ry: 30, rx: 16, o: 0 },
    { o: 1 },
    flight(frame, through - 22, { damping: 20, stiffness: 70 }),
  );
  const side = fly(dock.side - 8, { x: -1900, z: -500, ry: 70, o: 0 }, { x: -810, o: 1 });
  const head = fly(dock.head, { x: 150, y: -1100, z: -300, rx: -70, o: 0 }, { x: 150, y: -438, o: 1 });
  const voice = fly(dock.voice, { x: 150, y: -505, z: 900, s: 2.5, o: 0 }, { x: 150, y: -505, o: 1 });
  const status = fly(dock.status, { x: 150, y: 900, z: -200, rx: 80, o: 0 }, { x: 150, y: 522, o: 1 });

  // panes
  const sSplit = springIn(frame, split, { damping: 17, stiffness: 300, mass: 0.7 });
  const sDash = springIn(frame, dashAt, { damping: 17, stiffness: 300, mass: 0.7 });
  const termR = LR({ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 0.5, h: 1 }, sSplit);
  const brR = LR(
    LR({ x: 0.5, y: 0, w: 0, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }, sSplit),
    { x: 0.5, y: 0, w: 0.5, h: 0.6 },
    sDash,
  );
  const dR: Rect = { x: 0.5, y: 0.6, w: 0.5, h: 0.4 };
  const termFly = fly(dock.term, { z: -2000, rz: -10, ry: 25, o: 0 }, { o: 1 }, { damping: 22, stiffness: 160 });
  // Code panes flip away when the surface changes to Threads
  const flipOut = (i: number) => prog(frame, toThreads + i * 4, 18, ease.in);
  const tw = toWorld(termR);
  const bw = toWorld(brR);
  const dw = toWorld(dR);
  const dashFly = fly(dashAt, { x: dw.x, y: dw.y + 900, rx: 60, o: 0 }, { x: dw.x, y: dw.y, o: 1 });

  const threadsOn = frame >= toThreads;
  const rowFly = (i: number) =>
    fly(
      toThreads + 14 + i * 5,
      { x: -312, y: -324 + 88 * i, z: -900, ry: 30, o: 0 },
      { x: -312, y: -324 + 88 * i, o: 1 },
    );
  const detailFly = fly(
    toThreads + 22,
    { x: 480, y: 61, z: -300, ry: -75, o: 0 },
    { x: 480, y: 61, o: 1 },
    { damping: 18, stiffness: 120 },
  );
  const titleFly = fly(toThreads + 8, { x: -160, y: -420, z: -400, o: 0 }, { x: -160, y: -420, o: 1 });

  const transcript = [
    { text: "> Make checkout remember the last plan.", color: C.text },
    { text: "● Reading apps/web/src/routes/checkout.tsx" },
    { text: "● Editing apps/web/src/routes/checkout.tsx" },
    { text: "  + 24 lines  − 11 lines", color: C.workingText },
    { text: "● Running pnpm --filter web test" },
  ].filter((_, i) => frame >= toThreads + 30 + i * 8);

  const activePane = frame < split ? "t" : frame < dashAt ? (frame < whip ? "t" : "b") : frame < toThreads ? "d" : "x";

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {/* the mark, its orbits, the headline */}
      {frame < through + 12 ? (
        <div style={{ position: "absolute", inset: 0, perspective: 1200 }}>
          <div
            style={{
              position: "absolute",
              left: W / 2,
              top: cy,
              width: 0,
              height: 0,
              transformStyle: "preserve-3d",
              transform: `scale(${markS})`,
              opacity: markO,
            }}
          >
            {[0, 1, 2].map((k) => {
              const R = 230 + k * 60;
              const tilt = [72, 64, 78][k] - 10 * hold + 4 * Math.sin((frame - hit) / 40 + k);
              const rz = [0, 60, 120][k] + orbitSpin * [1, -0.7, 0.5][k];
              const draw = prog(frame, hit + k * 4, 40, ease.expo);
              return (
                <svg
                  key={k}
                  width={R * 2 + 40}
                  height={R * 2 + 40}
                  style={{
                    position: "absolute",
                    left: -R - 20,
                    top: -R - 20,
                    transform: `rotateX(${tilt}deg) rotateZ(${rz}deg)`,
                    overflow: "visible",
                  }}
                >
                  <circle
                    cx={R + 20}
                    cy={R + 20}
                    r={R}
                    fill="none"
                    stroke="rgba(141,182,255,0.55)"
                    strokeWidth={2}
                    pathLength={1}
                    strokeDasharray={`${draw} 1`}
                  />
                  <circle
                    cx={R + 20 + R * Math.cos(orbitSpin * 0.05 + k)}
                    cy={R + 20 + R * Math.sin(orbitSpin * 0.05 + k)}
                    r={7}
                    fill="#a9c8ff"
                    opacity={draw}
                  />
                </svg>
              );
            })}
            <div style={{ position: "absolute", left: -130, top: -130, filter: `brightness(${1 + 0.9 * h.flash})` }}>
              <Symbol size={260} />
            </div>
          </div>
          {/* shock ring on the hit */}
          <div
            style={{
              position: "absolute",
              left: W / 2 - h.ring * W * 0.5,
              top: cy - h.ring * W * 0.5,
              width: h.ring * W,
              height: h.ring * W,
              borderRadius: "50%",
              border: `2px solid rgba(141,182,255,${0.7 * h.ringOpacity})`,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: cy + (portrait ? 220 : 190),
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 26,
              opacity: 1 - prog(frame, push, 14, ease.in),
              padding: portrait ? "0 60px" : 0,
              transform: `translateY(${-30 * hold}px) scale(${1 + 0.05 * hold})`,
              filter: dolly > 0.01 ? `blur(${dolly * 14}px)` : undefined,
            }}
          >
            <KineticText
              text={copy.introducing}
              frame={frame}
              land={cf("copy.introducing")}
              per={30}
              size={portrait ? 110 : 128}
              dim={["Introducing"]}
            />
            <KineticText
              text={copy.positioning}
              frame={frame}
              land={cf("copy.positioning")}
              per={3}
              size={portrait ? 50 : 48}
              weight={400}
              color={C.text2}
              tracking="-0.005em"
            />
          </div>
        </div>
      ) : null}

      {/* the KalCode window, assembling in space */}
      {worldOn ? (
        <Space cam={cam} style={{ opacity: prog(frame, through - 24, 16) * (1 - prog(frame, ws.end - 2, 4)) }}>
          <Plane pose={{ ...plate, z: (plate.z ?? 0) - 4 }} w={1920} h={1080}>
            <div
              style={{
                width: "100%",
                height: "100%",
                borderRadius: 20,
                background: C.bg,
                border: `1px solid ${C.borderStrong}`,
                boxShadow: shadowXl,
                backgroundImage: "radial-gradient(90rem 40rem at 78% -18%, rgba(76,141,255,0.09), transparent 62%)",
              }}
            />
            <EnergyTrace
              w={1920}
              h={1080}
              r={20}
              frame={frame}
              start={through - 22}
              on={1 - prog(frame, dock.status, 30)}
              speed={3}
            />
          </Plane>
          <Plane pose={{ ...side, z: (side.z ?? 0) + 2 }} w={300} h={1080}>
            <div
              style={{
                width: 300,
                height: 1080,
                borderRadius: "20px 0 0 20px",
                overflow: "hidden",
                position: "relative",
              }}
            >
              <Sidebar active={frame >= toThreads + 6 ? "Threads" : "Code"} workspace="atlas" />
              <LightSweep frame={frame} at={dock.side} strength={0.14} />
              <LightSweep frame={frame} at={toThreads} strength={0.12} />
            </div>
          </Plane>
          <Plane pose={{ ...voice, z: (voice.z ?? 0) + 2 }} w={380} h={48}>
            <VoiceWidget />
          </Plane>
          {!threadsOn || flipOut(0) < 1 ? (
            <Plane pose={{ ...head, z: (head.z ?? 0) + 2, o: (head.o ?? 1) * (1 - flipOut(0)) }} w={1620} h={64}>
              <CodeHeader
                workspace="atlas"
                path="~\Projects\atlas"
                hot={frame > split - 10 && frame < split + 14 ? "Layout" : undefined}
              />
            </Plane>
          ) : null}
          <Plane pose={{ ...status, z: (status.z ?? 0) + 2 }} w={1620} h={36}>
            <div
              style={{
                height: 36,
                display: "flex",
                alignItems: "center",
                padding: "0 20px",
                color: C.muted,
                fontSize: 14,
                fontFamily: FONT.ui,
                borderTop: `1px solid ${C.borderSubtle}`,
              }}
            >
              {threadsOn ? "3 threads · 2 working" : `${sDash > 0.5 ? 3 : sSplit > 0.5 ? 2 : 1} panes · 1 running`}
              <div style={{ flex: 1 }} />
              <span style={{ fontFamily: FONT.mono, fontSize: 12.5, color: C.faint }}>{copy.sample}</span>
            </div>
          </Plane>
          {/* terminal */}
          <Plane
            pose={{
              ...termFly,
              x: tw.x + (termFly.x ?? 0),
              y: tw.y + (termFly.y ?? 0),
              ry: (termFly.ry ?? 0) - 90 * flipOut(0),
              z: (termFly.z ?? 0) + 24 - 300 * flipOut(0),
              o: (termFly.o ?? 1) * clamp01(1 - flipOut(0) * 1.6),
            }}
            w={tw.w}
            h={tw.h}
          >
            <Panel lit={activePane === "t" ? 1 : 0} style={{ width: tw.w, height: tw.h }}>
              <TerminalBody lines={devLines(frame, dock.term + 6)} caret frame={frame} size={18} />
            </Panel>
            <EnergyTrace w={tw.w} h={tw.h} frame={frame} start={dock.term} on={activePane === "t" ? 1 : 0} />
          </Plane>
          {/* browser: grows out of the split seam */}
          {sSplit > 0.001 ? (
            <Plane
              pose={{
                x: bw.x,
                y: bw.y,
                ry: -90 * flipOut(1),
                z: 24 - 300 * flipOut(1),
                o: clamp01(sSplit * 4) * clamp01(1 - flipOut(1) * 1.6),
              }}
              w={Math.max(2, bw.w)}
              h={bw.h}
            >
              <Panel lit={activePane === "b" ? 1 : 0} style={{ width: Math.max(2, bw.w), height: bw.h }}>
                <BrowserBody url="http://localhost:5173/pricing" spin={prog(frame, load - 16, 20, ease.inOut)}>
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      opacity: prog(frame, load, 10) * clamp01(1 - flipOut(1) * 3),
                      transform: `translateY(${(1 - prog(frame, load, 24, ease.expo)) * 40}px)`,
                    }}
                  >
                    <AtlasPage variant="old" />
                  </div>
                  <LightSweep frame={frame} at={load + 4} strength={0.3} />
                </BrowserBody>
              </Panel>
              <EnergyTrace w={Math.max(2, bw.w)} h={bw.h} frame={frame} start={split} on={activePane === "b" ? 1 : 0} />
              {/* the seam light as it opens */}
              <div
                style={{
                  position: "absolute",
                  left: -8,
                  top: 0,
                  bottom: 0,
                  width: 4,
                  background: "#a9c8ff",
                  boxShadow: "0 0 30px 8px rgba(76,141,255,0.8)",
                  opacity: (1 - sSplit) * 1.5,
                }}
              />
            </Plane>
          ) : null}
          {/* dashboard pane */}
          {frame >= dashAt - 18 ? (
            <Plane
              pose={{
                ...dashFly,
                ry: -90 * flipOut(2),
                z: (dashFly.z ?? 0) + 24 - 300 * flipOut(2),
                o: (dashFly.o ?? 1) * clamp01(1 - flipOut(2) * 1.6),
              }}
              w={dw.w}
              h={dw.h}
            >
              <Panel lit={activePane === "d" ? 1 : 0} style={{ width: dw.w, height: dw.h }}>
                <DashMini
                  summary="2 agents · 2 working · 0 waiting for you · 0 done · 0 idle"
                  rows={[
                    { t: "Checkout flow", p: "Claude Code", s: "Working", tone: "working" },
                    { t: "Webhook retries", p: "Codex", s: "Working", tone: "working" },
                  ]}
                />
              </Panel>
              <EnergyTrace w={dw.w} h={dw.h} frame={frame} start={dashAt} on={activePane === "d" ? 1 : 0} />
            </Plane>
          ) : null}
          {/* Threads surface unfolds */}
          {threadsOn ? (
            <>
              <Plane pose={{ ...titleFly, z: (titleFly.z ?? 0) + 40 }} w={1000} h={110}>
                <SurfaceTitle
                  title="Threads"
                  sub="One provider, one workspace, the permissions you choose."
                  action={<Button label="New thread" primary icon={<Icon icon={Plus} size={17} />} />}
                />
              </Plane>
              {THREADS_ATLAS.map((t, i) => (
                <Plane key={t.title} pose={{ ...rowFly(i), z: (rowFly(i).z ?? 0) + 40 }} w={640} h={78}>
                  <ThreadRow t={t} selected={i === 0} w={640} />
                </Plane>
              ))}
              <Plane pose={{ ...detailFly, z: (detailFly.z ?? 0) + 40 }} w={904} h={846}>
                <Panel lit={1} style={{ width: 904, height: 846 }}>
                  <ThreadHeader t={THREADS_ATLAS[0]} />
                  <Transcript lines={transcript} />
                  <Composer provider="Claude Code" frame={frame} />
                </Panel>
                <EnergyTrace w={904} h={846} frame={frame} start={toThreads + 30} />
              </Plane>
            </>
          ) : null}
        </Space>
      ) : null}

      {/* copy: lands on the beats */}
      {[
        { at: cf("copy.your_project"), t: copy.yourProject, end: inTerm - 28 },
        { at: inTerm, t: copy.yourTerminals, end: load - 28 },
        { at: load, t: copy.yourBrowser, end: toThreads - 28 },
        { at: toThreads, t: copy.yourAgents, end: ws.end - 8 },
      ].map((c) =>
        frame >= c.at - 16 && frame < c.end + 14 ? (
          <div
            key={c.t}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: portrait ? H * 0.1 : 80,
              display: "flex",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: "-60px -2000px -80px",
                background: "linear-gradient(180deg, rgba(5,8,15,0), rgba(5,8,15,0.8))",
              }}
            />
            <KineticText text={c.t} frame={frame} land={c.at} per={4} size={portrait ? 96 : 88} exit={c.end} />
          </div>
        ) : null,
      )}
    </div>
  );
};
