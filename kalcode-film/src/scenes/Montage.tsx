// 0:50–0:54 — the beat-cut montage. Eight shots, one per beat, each a real KalCode surface
// moving through 3D space with its word landing on the beat; the eighth ("One cockpit.")
// is the whole window, which then collapses into the mark for the end card.
import type React from "react";
import { C } from "../brand/tokens";
import { cf, cues, scene, useStage } from "../components/core";
import { KineticText, LightSweep } from "../components/fx";
import { clamp01, drift, ease, lerp, prog } from "../motion";
import { AtlasPage } from "../ui/atlas";
import { Cockpit, VoiceWidget } from "../ui/Cockpit";
import { Panel, StatusChip } from "../ui/kit";
import { ApprovalCard, BrowserBody, TerminalBody, ThreadRow } from "../ui/surfaces";
import { THREADS_ATLAS } from "./Assemble";

const Waveform28: React.FC<{ frame: number }> = ({ frame }) => (
  <svg width={560} height={120}>
    {Array.from({ length: 28 }, (_, i) => {
      const a =
        0.25 +
        0.75 *
          Math.abs(Math.sin(i * 1.7 + frame * 0.45) * Math.cos(i * 0.5 - frame * 0.23)) *
          (1 - Math.abs(i - 13.5) / 16);
      const h = 10 + a * 110;
      return (
        <rect
          key={i}
          x={i * 20 + 4}
          y={(120 - h) / 2}
          width={12}
          height={h}
          rx={6}
          fill={`rgba(141,182,255,${0.5 + 0.5 * a})`}
        />
      );
    })}
  </svg>
);

const shotContent = (i: number, frame: number): React.ReactNode => {
  switch (i) {
    case 0:
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, width: 720 }}>
          {THREADS_ATLAS.map((t) => (
            <ThreadRow key={t.title} t={{ ...t, status: "Working", tone: "working" }} w={720} />
          ))}
        </div>
      );
    case 1:
      return (
        <div style={{ display: "flex", gap: 18 }}>
          {["Claude Code", "Codex"].map((p) => (
            <Panel key={p} lit={1} style={{ width: 380, padding: 24, gap: 12 }}>
              <div style={{ fontSize: 28, color: C.text }}>{p}</div>
              {["Personal", "Work"].map((a) => (
                <div
                  key={a}
                  style={{
                    padding: "12px 16px",
                    borderRadius: 12,
                    background: C.surface2,
                    border: `1px solid ${C.border}`,
                    fontSize: 20,
                    color: C.text,
                  }}
                >
                  {a} <span style={{ fontSize: 15, color: C.workingText, marginLeft: 8 }}>Signed in</span>
                </div>
              ))}
            </Panel>
          ))}
        </div>
      );
    case 2:
      return (
        <Panel lit={1} style={{ width: 820, padding: 26, gap: 16 }}>
          <div style={{ fontSize: 30, color: C.text }}>Dashboard</div>
          <div style={{ display: "flex", gap: 10 }}>
            <StatusChip tone="working" label="Working" pulse={0.5 + 0.5 * Math.sin(frame / 6)} />
            <StatusChip tone="waiting" label="Waiting for you" />
            <StatusChip tone="done" label="Done" />
            <StatusChip tone="idle" label="Idle" />
          </div>
          <div style={{ fontSize: 19, color: C.muted }}>4 agents · 4 working · 0 waiting for you · 0 done · 0 idle</div>
        </Panel>
      );
    case 3:
      return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24 }}>
          <div style={{ transform: "scale(1.6)" }}>
            <VoiceWidget state="Listening" live={1} />
          </div>
          <Waveform28 frame={frame} />
        </div>
      );
    case 4:
      return (
        <Panel lit={1} style={{ width: 860, height: 380 }}>
          <TerminalBody
            size={22}
            lines={[
              { text: "PS ~\\Projects\\atlas> pnpm test", color: C.text },
              { text: " ✓ checkout.test.ts (12)", color: C.workingText },
              { text: " ✓ webhooks.test.ts (9)", color: C.workingText },
              { text: " ✓ pricing.test.tsx (7)", color: C.workingText },
              { text: " Tests  28 passed", color: C.text },
            ]}
          />
        </Panel>
      );
    case 5:
      return (
        <Panel lit={1} style={{ width: 900, height: 520 }}>
          <BrowserBody url="https://atlas.app/pricing">
            <AtlasPage variant="new" t={1} />
          </BrowserBody>
        </Panel>
      );
    case 6:
      return <ApprovalCard press={0} />;
    default:
      return null;
  }
};

export const Montage: React.FC<{ frame: number }> = ({ frame }) => {
  const { W, H, portrait } = useStage();
  const { start, end } = scene("montage");
  if (frame < start - 2 || frame >= end + 40) return null;
  const shots = cues("montage.");
  let idx = shots.length - 1;
  for (let i = 0; i < shots.length; i++)
    if (frame < shots[i].frame) {
      idx = i - 1;
      break;
    }
  if (idx < 0) return null;
  const at = shots[idx].frame;
  const local = frame - at;
  const len = idx + 1 < shots.length ? shots[idx + 1].frame - at : end - at;
  const u = clamp01(local / len);
  const dir = idx % 2 === 0 ? 1 : -1;
  // each shot: a fast arrival (whip) that decelerates into a slow drift, alternating direction
  const arrive = ease.expo(clamp01(local / 10));
  const tx = lerp(dir * 900, 0, arrive) - dir * 60 * u;
  const ry = lerp(-dir * 40, dir * -10, arrive) + dir * 8 * u;
  const rx = lerp(12, 4, arrive) - 6 * u;
  const sc = lerp(0.8, 1, arrive) * (1 + 0.1 * u);
  const label = String(shots[idx].label);
  const last = idx === shots.length - 1;
  const collapse = prog(frame, cf("end.collapse"), 30, ease.in);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {!last ? (
        <div style={{ position: "absolute", inset: 0, perspective: 1600 }}>
          <div
            style={{
              position: "absolute",
              left: W / 2,
              top: portrait ? H * 0.42 : H * 0.44,
              transform: `translate(-50%, -50%) translate3d(${tx + drift(frame, 141, 1) * 8}px, 0, 0) rotateY(${ry}deg) rotateX(${rx}deg) scale(${sc * (portrait ? 1.05 : 1.25)})`,
              opacity: 0.8,
            }}
          >
            {shotContent(idx, frame)}
          </div>
        </div>
      ) : (
        // "One cockpit.": the whole window, then it collapses into the point where the mark will bloom
        <div style={{ position: "absolute", inset: 0, perspective: 1800 }}>
          <div
            style={{
              position: "absolute",
              left: W / 2,
              top: H / 2,
              width: 1920,
              height: 1080,
              transform: `translate(-50%, -50%) scale(${(portrait ? 0.5 : 0.62) * lerp(1, 0.02, collapse) * (1 + 0.05 * u)}) rotateY(${lerp(-14, 0, arrive) + 30 * collapse}deg) rotateX(${6 - 6 * u}deg)`,
              opacity: (1 - prog(frame, cf("end.collapse") + 22, 8)) * 0.7,
              filter: collapse > 0.02 ? `blur(${collapse * 12}px)` : undefined,
            }}
          >
            <Cockpit active="Code" workspace="atlas" status={<span>4 agents · 4 done</span>}>
              <div
                style={{ position: "absolute", inset: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}
              >
                <Panel lit={1}>
                  <TerminalBody
                    lines={[
                      { text: "PS ~\\Projects\\atlas> pnpm dev", color: C.text },
                      { text: "  VITE v8.3  ready", color: C.workingText },
                    ]}
                  />
                </Panel>
                <Panel>
                  <BrowserBody url="http://localhost:5173/pricing">
                    <AtlasPage variant="new" t={1} />
                  </BrowserBody>
                </Panel>
              </div>
              <LightSweep frame={frame} at={at + 2} dur={26} strength={0.25} />
            </Cockpit>
          </div>
        </div>
      )}
      {/* a soft dark bed so the word holds over light surfaces (the atlas page) */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 1 - collapse,
          background: `radial-gradient(${portrait ? "60% 16%" : "34% 20%"} at 50% 50%, rgba(3,5,11,0.72), rgba(3,5,11,0) 100%)`,
        }}
      />
      {/* the word, on the beat */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
          opacity: 1 - collapse,
        }}
      >
        <KineticText
          key={label}
          text={label}
          frame={frame}
          land={at + 4}
          per={3}
          size={portrait ? 150 : 190}
          weight={700}
          from={dir > 0 ? "right" : "left"}
          tracking="-0.05em"
          style={{
            textShadow: "0 2px 14px rgba(3,5,11,0.9), 0 8px 60px rgba(3,5,11,0.95), 0 0 70px rgba(76,141,255,0.35)",
          }}
        />
      </div>
    </div>
  );
};
