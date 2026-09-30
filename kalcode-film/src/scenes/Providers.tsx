// 0:16–0:22 — Claude Code + Codex, several accounts each (Providers › Accounts). Threads keep
// their account; one Claude thread hits its usage limit and is switched to another account
// by hand ("Switch account" → "Rebind thread?" → "Switch to Work"). No automatic failover.
import { CheckCircle2, Plus } from "lucide-react";
import type React from "react";
import { C, FONT, R } from "../brand/tokens";
import { Camera, camAt } from "../components/camera";
import { cf, scene, useStage } from "../components/core";
import { BeatLines } from "../components/fx";
import { copy } from "../data/copy";
import { clamp01, drift, ease, prog, springIn } from "../motion";
import { Cockpit, SURF, SurfaceTitle } from "../ui/Cockpit";
import { Icon, Panel, type Tone } from "../ui/kit";
import { Dialog, Menu, type Thread, type TLine, Toast } from "../ui/surfaces";
import { ThreadsView } from "../ui/ThreadsView";

const Account: React.FC<{ name: string; def?: boolean; s: number }> = ({ name, def, s }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 14,
      padding: "16px 18px",
      borderRadius: R.lg * 1.5,
      background: C.surface2,
      border: `1px solid ${C.border}`,
      opacity: s,
      transform: `translateY(${(1 - s) * 24}px)`,
    }}
  >
    <div
      style={{
        width: 40,
        height: 40,
        borderRadius: 99,
        background: C.surface3,
        border: `1px solid ${C.borderStrong}`,
        display: "grid",
        placeItems: "center",
        color: C.text2,
        fontSize: 17,
      }}
    >
      {name[0]}
    </div>
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 21, color: C.text }}>{name}</span>
      <span style={{ fontSize: 15, color: C.workingText, display: "flex", alignItems: "center", gap: 6 }}>
        <Icon icon={CheckCircle2} size={15} /> Signed in
      </span>
    </div>
    <div style={{ flex: 1 }} />
    {def ? (
      <span
        style={{
          fontSize: 14,
          color: C.accentText,
          border: `1px solid ${C.borderLitSoft}`,
          borderRadius: 99,
          padding: "3px 10px",
        }}
      >
        Default
      </span>
    ) : null}
  </div>
);

const ProviderCard: React.FC<{ name: string; s: number; rows: number[] }> = ({ name, s, rows }) => (
  <div
    style={{
      flex: 1,
      opacity: clamp01(s * 1.5),
      transform: `perspective(1600px) translateY(${(1 - s) * 90}px) rotateX(${(1 - s) * 50}deg) translateZ(${-(1 - s) * 300}px)`,
    }}
  >
    <Panel style={{ padding: 26, gap: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <span style={{ fontSize: 30, color: C.text, fontWeight: 500 }}>{name}</span>
        <span style={{ fontSize: 16, color: C.muted }}>2 accounts</span>
      </div>
      <Account name="Personal" def s={rows[0]} />
      <Account name="Work" s={rows[1]} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          color: C.muted,
          fontSize: 16,
          padding: "6px 4px",
          fontFamily: FONT.ui,
        }}
      >
        <Icon icon={Plus} size={16} /> Connect another {name} account
      </div>
    </Panel>
  </div>
);

export const Providers: React.FC<{ frame: number }> = ({ frame }) => {
  const { portrait } = useStage();
  const { start, end } = scene("providers");
  if (frame < start - 20 || frame >= end + 24) return null;
  const toThreads = prog(frame, cf("prov.threads"), 22, ease.emphasized);
  const limit = cf("prov.limit");
  const menu = cf("prov.menu");
  const dialog = cf("prov.dialog");
  const sw = cf("prov.switch");
  const working = cf("prov.working");

  const acct = frame >= sw ? "Work" : "Personal";
  let status = "Editing";
  let tone: Tone = "working";
  if (frame >= limit && frame < working) {
    status = "Last turn failed";
    tone = "failed";
  }
  const threads: Thread[] = [
    {
      title: "Pricing page copy",
      provider: "Claude Code",
      account: acct,
      status,
      tone,
      lit: frame >= cf("prov.route.0") && frame < limit ? 1 : 0,
    },
    {
      title: "Checkout flow",
      provider: "Claude Code",
      account: "Personal",
      status: "Editing",
      tone: "working",
      lit: frame >= cf("prov.route.1") && frame < limit ? 1 : 0,
    },
    {
      title: "Webhook retries",
      provider: "Codex",
      account: "Personal",
      status: "Running a command",
      tone: "working",
      lit: frame >= cf("prov.route.2") && frame < limit ? 1 : 0,
    },
  ];
  const transcript: TLine[] = [
    { text: "> Tighten the pricing page copy.", color: C.text },
    { text: "● Reading apps/web/src/routes/pricing.tsx" },
    { text: "● Editing apps/web/src/routes/pricing.tsx" },
  ];
  if (frame >= limit)
    transcript.push({ text: "Claude's usage limit was reached. Try again later.", color: C.failedText });
  if (frame >= sw) transcript.push({ text: "Switched to Work. Past history is unchanged.", color: C.muted });
  if (frame >= working) transcript.push({ text: "● Editing apps/web/src/routes/pricing.tsx" });

  const menuS = springIn(frame, menu, { damping: 18, stiffness: 300 }) * (1 - prog(frame, dialog, 8));
  const dlgS = springIn(frame, dialog, { damping: 16, stiffness: 260 }) * (1 - prog(frame, sw + 4, 10, ease.in));
  const press = prog(frame, sw - 6, 6) * (1 - prog(frame, sw, 8));
  const toastS = springIn(frame, sw + 6, { damping: 16, stiffness: 220 }) * (1 - prog(frame, end - 10, 16, ease.in));

  const keys = portrait
    ? [
        { f: start - 6, s: 0.95, fx: 600, fy: 420, ry: -18, rx: 4 },
        { f: cf("prov.card.1") + 30, s: 0.95, fx: 1300, fy: 420, ry: 6 },
        { f: cf("prov.threads"), s: 0.95, fx: 1100, fy: 420, ry: -4 },
        { f: limit - 10, s: 1.05, fx: 1340, fy: 420, ry: 5 },
        { f: dialog + 10, s: 1.08, fx: 1250, fy: 520, rx: 3 },
        { f: end, s: 1.0, fx: 1300, fy: 480, ry: -6 },
      ]
    : [
        { f: start - 6, s: 1.0, fx: 700, fy: 480, ry: -16, rx: 4 },
        { f: cf("prov.card.1") + 30, s: 0.95, fx: 1150, fy: 500, ry: 6, rx: 2 },
        { f: cf("prov.threads"), s: 0.95, fx: 1110, fy: 500, ry: -4 },
        { f: limit - 10, s: 1.08, fx: 1300, fy: 440, ry: 5 },
        { f: dialog + 10, s: 1.12, fx: 1150, fy: 520, rx: 3 },
        { f: end, s: 1.02, fx: 1150, fy: 500, ry: -6 },
      ];
  const cam = camAt(keys, frame, ease.emphasized);
  cam.fx += drift(frame, 31, 0.5) * 6;

  const cardS = (i: number) => springIn(frame, cf(`prov.card.${i}`), { damping: 15, stiffness: 170 });
  const rowS = (i: number, j: number) =>
    springIn(frame, cf(`prov.card.${i}`) + 10 + j * 6, { damping: 18, stiffness: 220 });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: prog(frame, start - 6, 8) * (1 - prog(frame, end - 2, 8, ease.in)),
      }}
    >
      <Camera cam={cam}>
        <Cockpit
          active={toThreads > 0.5 ? "Threads" : "Providers"}
          status={<span>{toThreads > 0.5 ? "3 threads · 3 working" : "Claude Code · Codex"}</span>}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              opacity: 1 - toThreads,
              transformOrigin: "0% 50%",
              transform: `perspective(2200px) rotateY(${-toThreads * 70}deg) translateZ(${-toThreads * 260}px)`,
            }}
          >
            <SurfaceTitle title="Providers" sub="Accounts stay isolated." />
            <div style={{ display: "flex", gap: 24, padding: "10px 28px" }}>
              <ProviderCard name="Claude Code" s={cardS(0)} rows={[rowS(0, 0), rowS(0, 1)]} />
              <ProviderCard name="Codex" s={cardS(1)} rows={[rowS(1, 0), rowS(1, 1)]} />
            </div>
          </div>
          <div
            style={{
              position: "absolute",
              inset: 0,
              opacity: toThreads,
              transformOrigin: "100% 50%",
              transform: `perspective(2200px) rotateY(${(1 - toThreads) * 70}deg) translateZ(${-(1 - toThreads) * 260}px)`,
            }}
          >
            <ThreadsView
              frame={frame}
              threads={threads}
              selected={0}
              enterAt={cf("prov.threads")}
              transcript={transcript}
              menuHot={frame >= menu && frame < sw ? 1 : 0}
              detailLit={frame >= limit ? 1 : 0}
              trace={
                frame >= limit ? { start: limit, color: frame < working ? "239,95,107" : "141,182,255" } : undefined
              }
              overlay={
                menuS > 0.01 ? (
                  <div
                    style={{
                      position: "absolute",
                      right: 170,
                      top: 74,
                      opacity: menuS,
                      transform: `translateY(${(1 - menuS) * -12}px)`,
                    }}
                  >
                    <Menu
                      title="Switch account"
                      items={[
                        { label: "Personal", checked: true },
                        { label: "Work", hot: frame >= menu + 12 },
                      ]}
                    />
                  </div>
                ) : null
              }
            />
          </div>
          {dlgS > 0.01 ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: `rgba(2,4,9,${0.55 * dlgS})`,
                display: "grid",
                placeItems: "center",
              }}
            >
              <div
                style={{
                  opacity: dlgS,
                  transform: `perspective(1400px) rotateX(${(1 - dlgS) * 28}deg) scale(${0.86 + 0.14 * dlgS})`,
                }}
              >
                <Dialog
                  title="Rebind thread?"
                  body="Switch future messages to Work?"
                  note="Past conversation history remains unchanged. Only future provider requests use Work."
                  confirm="Switch to Work"
                  press={press}
                />
              </div>
            </div>
          ) : null}
          {toastS > 0.01 ? (
            <div
              style={{
                position: "absolute",
                right: 28,
                bottom: 24,
                opacity: toastS,
                transform: `translateY(${(1 - toastS) * 30}px)`,
              }}
            >
              <Toast title="Switched to Work" body="Future messages use Work. Past history is unchanged." />
            </div>
          ) : null}
        </Cockpit>
      </Camera>
      <BeatLines
        frame={frame}
        portrait={portrait}
        lines={[
          { at: cf("copy.accounts"), text: copy.accounts, end: limit - 16 },
          { at: cf("copy.keep_going"), text: copy.keepGoing },
        ]}
        until={end - 10}
      />
    </div>
  );
};

export const PROV_SURF = SURF;
