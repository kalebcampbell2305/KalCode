// The KalCode window on Stable 0.1.6: sidebar + the KalVoice widget docked at the top +
// one surface (Code, Threads, Providers, Dashboard). No workspace rail (gated on Stable).
import { LayoutGrid, SquareTerminal } from "lucide-react";
import type React from "react";
import { Img, staticFile } from "remotion";
import { C, FONT, R, shadowXl } from "../brand/tokens";
import { copy } from "../data/copy";
import { Icon, Panel, Sidebar } from "./kit";

export type Rect = { x: number; y: number; w: number; h: number };
export const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t,
  h: a.h + (b.h - a.h) * t,
});

export const WIN_W = 1920;
export const WIN_H = 1080;
export const SIDE_W = 300;
export const TOP_H = 70; // KalVoice widget band
export const SURF = { x: SIDE_W, y: TOP_H, w: WIN_W - SIDE_W, h: WIN_H - TOP_H - 36 };

export const Button: React.FC<{
  label: string;
  icon?: React.ReactNode;
  hot?: number;
  primary?: boolean;
  style?: React.CSSProperties;
}> = ({ label, icon, hot = 0, primary, style }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      height: 40,
      padding: "0 16px",
      borderRadius: R.md * 1.5,
      border: `1px solid ${primary ? "rgba(170,205,255,0.5)" : hot > 0.5 ? C.borderLit : C.border}`,
      background: primary
        ? `linear-gradient(180deg, ${C.btnTop}, ${C.btnBottom})`
        : hot > 0.5
          ? C.accentSoft
          : C.surface1,
      color: primary ? "#fff" : hot > 0.5 ? C.text : C.text2,
      fontFamily: FONT.ui,
      fontSize: 16.5,
      fontWeight: primary ? 500 : 400,
      whiteSpace: "nowrap",
      boxShadow:
        hot > 0 || primary ? `0 0 ${24 * Math.max(hot, primary ? 0.6 : 0)}px -6px rgba(76,141,255,0.6)` : undefined,
      ...style,
    }}
  >
    {icon}
    {label}
  </div>
);

/** The KalVoice widget, docked at the top: orb, wordmark, status dot, state label. */
export const VoiceWidget: React.FC<{ state?: string; live?: number; scale?: number }> = ({
  state = "Ready",
  live = 0,
  scale = 1,
}) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 12 * scale,
      height: 44 * scale,
      padding: `0 ${18 * scale}px 0 ${8 * scale}px`,
      borderRadius: 999,
      border: `1px solid ${live > 0.3 ? C.borderLit : C.border}`,
      background: C.surface1,
      fontFamily: FONT.ui,
      boxShadow: live > 0 ? `0 0 ${34 * live * scale}px -4px rgba(76,141,255,${0.7 * live})` : undefined,
    }}
  >
    <Img
      src={staticFile("brand/kalvoice-icon-512.png")}
      style={{
        width: 32 * scale,
        height: 32 * scale,
        filter: `drop-shadow(0 0 ${6 + 14 * live}px rgba(76,141,255,${0.5 + 0.5 * live}))`,
      }}
    />
    <span style={{ fontFamily: FONT.wide, fontSize: 13 * scale, letterSpacing: "0.3em", color: C.text2 }}>
      KALVOICE
    </span>
    <span
      style={{ width: 7 * scale, height: 7 * scale, borderRadius: 9, background: live > 0.3 ? C.accent : C.working }}
    />
    <span style={{ fontSize: 16 * scale, color: C.text }}>{state}</span>
  </div>
);

export type CockpitProps = {
  active: string; // sidebar destination
  workspace?: string;
  version?: string;
  voice?: { state: string; live: number };
  status?: React.ReactNode;
  children: React.ReactNode; // the surface, laid out in SURF coordinates
  chrome?: number;
  hideVoice?: boolean;
};

export const Cockpit: React.FC<CockpitProps> = ({
  active,
  workspace = "kalcode",
  version = "0.1.6",
  voice = { state: "Ready", live: 0 },
  status,
  children,
  chrome = 1,
  hideVoice,
}) => (
  <div
    style={{
      position: "relative",
      width: WIN_W,
      height: WIN_H,
      background: C.bg,
      backgroundImage:
        "radial-gradient(90rem 40rem at 78% -18%, rgba(76,141,255,0.075), transparent 62%), radial-gradient(60rem 30rem at -10% 110%, rgba(76,141,255,0.035), transparent 60%)",
      borderRadius: 20,
      border: `1px solid ${C.borderStrong}`,
      boxShadow: shadowXl,
      overflow: "hidden",
      fontFamily: FONT.ui,
    }}
  >
    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, opacity: chrome }}>
      <Sidebar active={active} workspace={workspace} version={version} />
    </div>
    <div
      style={{
        position: "absolute",
        left: SIDE_W,
        right: 0,
        top: 0,
        height: TOP_H,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: hideVoice ? 0 : chrome,
      }}
    >
      <VoiceWidget state={voice.state} live={voice.live} />
    </div>
    <div style={{ position: "absolute", left: SURF.x, top: SURF.y, width: SURF.w, height: SURF.h }}>{children}</div>
    <div
      style={{
        position: "absolute",
        left: SIDE_W,
        right: 0,
        bottom: 0,
        height: 36,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "0 20px",
        borderTop: `1px solid ${C.borderSubtle}`,
        color: C.muted,
        fontSize: 14,
        opacity: chrome,
      }}
    >
      {status}
      <div style={{ flex: 1 }} />
      <span style={{ fontFamily: FONT.mono, fontSize: 12.5, color: C.faint }}>{copy.sample}</span>
    </div>
  </div>
);

/** Code-surface header: workspace name, path, toolbar. */
export const CodeHeader: React.FC<{ workspace?: string; path?: string; hot?: string }> = ({
  workspace = "kalcode",
  path = "~\\Projects\\kalcode",
  hot,
}) => (
  <div style={{ height: 64, display: "flex", alignItems: "center", gap: 12, padding: "0 20px" }}>
    <span style={{ fontSize: 28, fontWeight: 500, color: C.text }}>{workspace}</span>
    <span
      style={{
        fontFamily: FONT.mono,
        fontSize: 15,
        color: C.muted,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "4px 9px",
      }}
    >
      {path}
    </span>
    <div style={{ flex: 1 }} />
    <Button label="New terminal" icon={<Icon icon={SquareTerminal} size={17} />} hot={hot === "New terminal" ? 1 : 0} />
    <Button label="Layout" icon={<Icon icon={LayoutGrid} size={17} />} hot={hot === "Layout" ? 1 : 0} />
  </div>
);

/** Pane canvas below the Code header. Rects are fractions of the canvas. */
export const PaneCanvas: React.FC<{
  panes: { id: string; rect: Rect; lit?: number; opacity?: number; content: React.ReactNode }[];
}> = ({ panes }) => {
  const W = SURF.w - 40;
  const H = SURF.h - 64 - 16;
  return (
    <div style={{ position: "absolute", left: 20, top: 64, width: W, height: H }}>
      {panes.map((p) => (
        <div
          key={p.id}
          style={{
            position: "absolute",
            left: p.rect.x * W,
            top: p.rect.y * H,
            width: p.rect.w * W - 12,
            height: p.rect.h * H - 12,
            opacity: p.opacity ?? 1,
          }}
        >
          <Panel lit={p.lit ?? 0} style={{ width: "100%", height: "100%" }}>
            {p.content}
          </Panel>
        </div>
      ))}
    </div>
  );
};

/** Surface title block used by Threads / Providers / Dashboard. */
export const SurfaceTitle: React.FC<{ title: string; sub: string; action?: React.ReactNode }> = ({
  title,
  sub,
  action,
}) => (
  <div style={{ display: "flex", alignItems: "flex-end", gap: 16, padding: "18px 28px 18px" }}>
    <div>
      <div style={{ fontSize: 32, fontWeight: 500, color: C.text, letterSpacing: "-0.01em" }}>{title}</div>
      <div style={{ fontSize: 17, color: C.muted, marginTop: 6 }}>{sub}</div>
    </div>
    <div style={{ flex: 1 }} />
    {action}
  </div>
);
