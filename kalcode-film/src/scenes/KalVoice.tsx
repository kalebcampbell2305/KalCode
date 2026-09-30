// 0:30–0:36 — KalVoice. Hold F8 (the real push-to-talk key), speak, release. The widget goes
// Ready → Listening (28-bar waveform, halo breathing with the voice) → Processing → Done; the
// words are dictated into the focused thread's composer; a second hold, "send that", sends it.
// No synthesized voice: speech is shown as waveform → text.
import type React from "react";
import { Img, staticFile } from "remotion";
import { C, FONT } from "../brand/tokens";
import { Camera, camAt } from "../components/camera";
import { Bloom, cf, scene, useStage } from "../components/core";
import { BeatLines } from "../components/fx";
import { copy } from "../data/copy";
import { clamp01, drift, ease, lerp, prog, rng, springIn } from "../motion";
import { Cockpit } from "../ui/Cockpit";
import type { Thread, TLine } from "../ui/surfaces";
import { ThreadsView } from "../ui/ThreadsView";

const WORDS = ["Redesign", "the", "pricing", "page."];

/** Deterministic speech envelope: syllable bumps inside the key-down windows. */
const speechLevel = (frame: number, a: number, b: number, syll: number, seed: number) => {
  if (frame < a || frame > b) return 0;
  const r = rng(seed);
  let v = 0;
  const span = b - a;
  for (let k = 0; k < syll; k++) {
    const c = a + 8 + (k + 0.2 * r()) * ((span - 16) / syll);
    const w = 3 + r() * 3;
    v += (0.55 + 0.45 * r()) * Math.exp(-(((frame - c) / w) ** 2));
  }
  return Math.min(1, v) * clamp01((frame - a) / 4) * clamp01((b - frame) / 4);
};

const Waveform: React.FC<{ frame: number; level: number; w: number; h: number; on: number }> = ({
  frame,
  level,
  w,
  h,
  on,
}) => {
  const bars = 28;
  const gap = w / bars;
  return (
    <svg width={w} height={h} style={{ overflow: "visible" }}>
      {Array.from({ length: bars }, (_, i) => {
        const center = 1 - Math.abs(i - (bars - 1) / 2) / (bars / 2);
        const jitter = 0.45 + 0.55 * Math.abs(Math.sin(i * 1.71 + frame * 0.37) * Math.cos(i * 0.53 - frame * 0.21));
        const amp = (0.08 + 0.92 * level * jitter * (0.35 + 0.65 * center)) * on;
        const bh = Math.max(4, amp * h);
        return (
          <rect
            key={i}
            x={i * gap + gap * 0.22}
            y={(h - bh) / 2}
            width={gap * 0.56}
            height={bh}
            rx={gap * 0.28}
            fill={`rgba(141,182,255,${0.45 + 0.55 * amp})`}
          />
        );
      })}
    </svg>
  );
};

const Keycap: React.FC<{ down: number }> = ({ down }) => (
  <div style={{ width: 128, height: 128, position: "relative" }}>
    <div
      style={{
        position: "absolute",
        inset: 0,
        top: 10,
        borderRadius: 22,
        background: "#03050b",
        border: `1px solid ${C.borderStrong}`,
      }}
    />
    <div
      style={{
        position: "absolute",
        inset: 0,
        bottom: 10,
        borderRadius: 22,
        background: `linear-gradient(180deg, ${down > 0.5 ? "#16264a" : "#16213a"}, ${down > 0.5 ? "#0f1c38" : "#0e1628"})`,
        border: `1px solid ${down > 0.5 ? C.borderLit : C.borderStrong}`,
        transform: `translateY(${down * 9}px)`,
        display: "grid",
        placeItems: "center",
        boxShadow: down > 0.5 ? "0 0 40px -6px rgba(76,141,255,0.8)" : "inset 0 1px 0 rgba(200,220,255,0.08)",
        fontFamily: FONT.ui,
        fontSize: 44,
        color: down > 0.5 ? C.accentIcy : C.text,
      }}
    >
      F8
    </div>
  </div>
);

export const KalVoice: React.FC<{ frame: number }> = ({ frame }) => {
  const { W, H, portrait } = useStage();
  const { start, end } = scene("kalvoice");
  if (frame < start - 2 || frame >= end + 24) return null;
  const p1 = cf("voice.press");
  const r1 = cf("voice.release");
  const typed = cf("voice.type");
  const p2 = cf("voice.send.press");
  const r2 = cf("voice.send.release");
  const working = cf("voice.working");

  const down = (frame >= p1 && frame < r1) || (frame >= p2 && frame < r2) ? 1 : 0;
  const level = speechLevel(frame, p1 + 6, r1 - 4, 7, 5) + speechLevel(frame, p2 + 4, r2 - 4, 2, 6);
  const listening = down;
  let state = "Ready";
  if (listening) state = "Listening";
  else if (frame >= r1 && frame < typed) state = "Processing";
  else if (frame >= typed && frame < p2) state = "Done";
  else if (frame >= r2 && frame < working) state = "Executing";
  else if (frame >= working) state = "Done";

  // words appear as they are spoken
  const shown = WORDS.filter((_, k) => frame >= p1 + 16 + k * 14).join(" ");
  const cmd = frame >= p2 + 10 ? "send that" : "";
  const flyT = prog(frame, r1 + 4, typed - r1 + 6, ease.inOut); // transcript → composer
  const sent = frame >= working;
  const composerText = frame >= typed && !sent ? WORDS.join(" ") : undefined;

  const intro = springIn(frame, start, { damping: 18, stiffness: 120 });
  const settle = prog(frame, r1, 40, ease.inOut); // widget rises; the thread comes forward
  const widgetScale = portrait ? 1.3 : 1.45;
  const wx = portrait ? W / 2 : W / 2 + 110;
  const wy = lerp(portrait ? H * 0.3 : H * 0.36, portrait ? H * 0.14 : H * 0.14, settle);

  const thread: Thread = {
    title: "Pricing page",
    provider: "Claude Code",
    account: "Work",
    status: sent ? "Thinking" : "Ready",
    tone: sent ? "working" : "idle",
    lit: sent ? 1 : 0,
  };
  const transcript: TLine[] = [
    ...(sent ? [{ text: "> Redesign the pricing page.", color: C.text }] : []),
    ...(frame >= working + 24 ? [{ text: "● Reading apps/web/src/routes/pricing.tsx" }] : []),
    ...(frame >= working + 60 ? [{ text: "● Editing apps/web/src/components/PlanCard.tsx" }] : []),
  ];
  const cam = camAt(
    [
      { f: start, s: portrait ? 0.62 : 0.86, fx: 1300, fy: 700, ry: 10, rx: 6 },
      { f: r1, s: portrait ? 0.64 : 0.94, fx: 1320, fy: 720, ry: 4, rx: 3 },
      { f: typed + 10, s: portrait ? 0.8 : 1.12, fx: 1400, fy: 820, ry: -3 },
      { f: working - 4, s: portrait ? 0.82 : 1.14, fx: 1420, fy: 820, ry: -5 },
      { f: working + 30, s: portrait ? 0.9 : 1.18, fx: 1400, fy: 400, ry: 3, rx: -2 },
      { f: end + 24, s: portrait ? 0.92 : 1.22, fx: 1400, fy: 390, ry: 6 },
    ],
    frame,
    ease.emphasized,
  );
  cam.sy = portrait ? H * 0.6 : H * 0.62;
  cam.fx += drift(frame, 51, 0.4) * 5;

  const halo = 0.35 + 0.65 * level * listening;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: prog(frame, start - 2, 10) * (1 - prog(frame, end - 2, 8, ease.in)),
      }}
    >
      {/* the thread the words land in, receding in depth */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.35 + 0.65 * prog(frame, r1, 20),
          filter: `blur(${lerp(6, 0, prog(frame, r1, 24))}px)`,
        }}
      >
        <Camera cam={cam}>
          <Cockpit
            active="Threads"
            hideVoice
            voice={{ state, live: listening ? 0.6 + 0.4 * level : 0 }}
            status={<span>Pricing page · Claude Code · Work</span>}
          >
            <ThreadsView
              frame={frame}
              threads={[
                thread,
                { title: "Checkout flow", provider: "Claude Code", account: "Personal", status: "Ready", tone: "idle" },
                { title: "Webhook retries", provider: "Codex", account: "Personal", status: "Ready", tone: "idle" },
              ]}
              selected={0}
              transcript={transcript}
              composer={{ text: composerText, live: frame >= typed && !sent ? 1 : 0, caret: frame >= typed && !sent }}
              detailLit={frame >= typed ? 1 : 0}
            />
          </Cockpit>
        </Camera>
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(180deg, rgba(5,8,15,0.96) 0%, rgba(5,8,15,${lerp(0.9, 0.55, prog(frame, r1, 30))}) 30%, rgba(5,8,15,${lerp(0.8, 0.0, prog(frame, r1, 30))}) 55%, rgba(5,8,15,0) 100%)`,
        }}
      />
      <Bloom x={wx} y={wy} r={520} o={0.25 + 0.55 * halo * intro} />
      {/* the widget, close up */}
      <div
        style={{
          position: "absolute",
          left: wx,
          top: wy,
          transform: `translate(-50%, -50%) scale(${widgetScale * lerp(0.9, 1, intro)})`,
          opacity: intro,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            height: 84,
            padding: "0 30px 0 14px",
            borderRadius: 999,
            background: C.surface1,
            border: `1px solid ${listening ? C.borderLit : C.borderStrong}`,
            boxShadow: `0 0 ${20 + 50 * halo}px -8px rgba(76,141,255,${0.35 + 0.5 * halo})`,
            fontFamily: FONT.ui,
          }}
        >
          <div style={{ position: "relative", width: 64, height: 64 }}>
            <div
              style={{
                position: "absolute",
                inset: -14 - 18 * level * listening,
                borderRadius: 999,
                background: `radial-gradient(circle, rgba(76,141,255,${0.45 * halo}) 0%, rgba(76,141,255,0) 70%)`,
              }}
            />
            <Img
              src={staticFile("brand/kalvoice-icon-512.png")}
              style={{
                position: "absolute",
                inset: 0,
                width: 64,
                height: 64,
                transform: `rotate(${frame * 0.4}deg) scale(${1 + 0.08 * level})`,
              }}
            />
          </div>
          <div
            style={{
              width: 190,
              height: 19,
              background: C.text2,
              WebkitMaskImage: `url(${staticFile("brand/kalvoice-wordmark.png")})`,
              WebkitMaskSize: "100% 100%",
            }}
          />
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 9,
              background: listening ? C.accent : state === "Done" ? C.working : C.working,
              boxShadow: listening ? `0 0 12px ${C.accent}` : undefined,
            }}
          />
          <span style={{ fontSize: 24, color: C.text, width: 150 }}>{state}</span>
          <div style={{ width: listening || frame < p2 + 1 ? 230 : 230, opacity: listening ? 1 : 0.25 }}>
            <Waveform frame={frame} level={level} w={230} h={54} on={1} />
          </div>
        </div>
      </div>
      {/* the voice travels as light: widget → composer (dictation), then widget → Send ("send that") */}
      {(() => {
        const toS = (x: number, y: number) => ({
          x: W / 2 + (x - cam.fx) * cam.s,
          y: (cam.sy ?? H / 2) + (y - cam.fy) * cam.s,
        });
        const legs = [
          { a: r1 - 2, b: typed + 4, to: toS(1300, 985) },
          { a: r2 - 2, b: working + 2, to: toS(1830, 985) },
        ];
        return (
          <svg width={W} height={H} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            <defs>
              <filter id="vroute" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="7" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {legs.map((l, i) => {
              if (frame < l.a || frame > l.b + 24) return null;
              const x0 = wx;
              const y0 = wy + 60;
              const d = `M ${x0} ${y0} C ${x0} ${(y0 + l.to.y) / 2}, ${l.to.x} ${(y0 + l.to.y) / 2}, ${l.to.x} ${l.to.y}`;
              const t = prog(frame, l.a, l.b - l.a, ease.inOut);
              const fade = 1 - prog(frame, l.b, 24);
              return (
                <g key={i} filter="url(#vroute)" opacity={fade}>
                  <path
                    d={d}
                    fill="none"
                    stroke="rgba(141,182,255,0.35)"
                    strokeWidth={2}
                    pathLength={1}
                    strokeDasharray={`${t} 1`}
                  />
                  <path
                    d={d}
                    fill="none"
                    stroke="#a9c8ff"
                    strokeWidth={5}
                    strokeLinecap="round"
                    pathLength={1}
                    strokeDasharray="0.08 1"
                    strokeDashoffset={-(t - 0.08)}
                  />
                  {t >= 1 ? (
                    <circle
                      cx={l.to.x}
                      cy={l.to.y}
                      r={16 + 30 * prog(frame, l.b, 18)}
                      fill="none"
                      stroke={`rgba(141,182,255,${fade})`}
                      strokeWidth={2}
                    />
                  ) : null}
                </g>
              );
            })}
          </svg>
        );
      })()}
      {/* F8 */}
      <div
        style={{
          position: "absolute",
          left: portrait ? wx - 64 : 250,
          top: portrait ? wy - 300 : wy - 64,
          opacity: intro * (1 - settle),
        }}
      >
        <Keycap down={down} />
        <div style={{ textAlign: "center", marginTop: 14, fontSize: 20, color: C.muted, fontFamily: FONT.ui }}>
          Hold F8
        </div>
      </div>
      {/* transcript: the spoken words, then they fly into the composer */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: lerp(wy + (portrait ? 150 : 110), portrait ? H * 0.66 : H * 0.8, flyT),
          display: "flex",
          justifyContent: "center",
          fontFamily: FONT.ui,
          fontSize: lerp(portrait ? 58 : 56, 30, flyT),
          color: C.text,
          opacity: (frame >= p1 ? 1 : 0) * (1 - prog(frame, typed - 4, 8)),
          letterSpacing: "-0.01em",
          padding: "0 60px",
          textAlign: "center",
        }}
      >
        {frame < p1 + 16 && frame >= p1 ? <span style={{ color: C.muted }}>Listening…</span> : shown}
      </div>
      {/* the second, free command */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: wy + (portrait ? 150 : 100),
          display: "flex",
          justifyContent: "center",
          fontFamily: FONT.mono,
          fontSize: 44,
          color: C.accentText,
          opacity: cmd ? 1 - prog(frame, working, 12) : 0,
        }}
      >
        “{cmd}”
      </div>
      <BeatLines
        frame={frame}
        portrait={portrait}
        size={portrait ? 96 : 92}
        bottom={portrait ? 230 : 96}
        lines={[
          { at: cf("copy.say"), text: copy.say },
          { at: cf("copy.kalvoice"), text: copy.kalvoice },
        ]}
        until={end - 6}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: portrait ? H * 0.06 : 28,
          textAlign: "center",
          fontFamily: FONT.ui,
          fontSize: 34,
          color: C.text2,
          opacity: prog(frame, cf("copy.kalvoice") + 10, 20) * (1 - prog(frame, end - 4, 14)),
        }}
      >
        {copy.kalvoiceCaption}
      </div>
    </div>
  );
};
