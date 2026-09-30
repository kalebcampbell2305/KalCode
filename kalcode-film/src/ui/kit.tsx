// A motion-ready abstraction of the real KalCode desktop UI (apps/desktop + packages/ui).
// Structure, labels, icons (lucide-react, same set as the app) and tokens follow the product;
// sizes are scaled up for film legibility.
import {
  AudioLines,
  Bell,
  ChevronDown,
  Code2,
  FolderOpen,
  Globe,
  LayoutDashboard,
  type LucideIcon,
  MessagesSquare,
  PlugZap,
  RotateCw,
  Search,
  Settings,
  ShieldCheck,
  SquareTerminal,
  ArrowLeft,
  ArrowRight,
  Plus,
  X,
  MoreHorizontal,
} from "lucide-react";
import type React from "react";
import { Img, staticFile } from "remotion";
import { C, FONT, R, panelSheen, shadowLit, shadowPanel } from "../brand/tokens";

export const S = 1.5; // film scale over the product's 14px body size

export const Icon: React.FC<{
  icon: LucideIcon;
  size?: number;
  color?: string;
  stroke?: number;
  style?: React.CSSProperties;
}> = ({ icon: I, size = 16 * S, color = "currentColor", stroke = 1.75, style }) => (
  <I size={size} color={color} strokeWidth={stroke} style={{ flexShrink: 0, ...style }} />
);

// ---------------------------------------------------------------- brand marks

export const Symbol: React.FC<{ size: number; glowOnly?: boolean; style?: React.CSSProperties }> = ({
  size,
  glowOnly,
  style,
}) => (
  <Img
    src={staticFile(glowOnly ? "brand/kalcode-symbol-1024.png" : "brand/kalcode-icon-1024.png")}
    style={{ width: size, height: size, display: "block", ...style }}
  />
);

/** The board wordmark, used as a luminance mask so it can be tinted and lit. */
export const Wordmark: React.FC<{ width: number; color?: string; style?: React.CSSProperties }> = ({
  width,
  color = C.text,
  style,
}) => (
  <div
    style={{
      width,
      height: (width * 69) / 687,
      background: color,
      WebkitMaskImage: `url(${staticFile("brand/kalcode-wordmark.png")})`,
      WebkitMaskSize: "100% 100%",
      maskImage: `url(${staticFile("brand/kalcode-wordmark.png")})`,
      maskSize: "100% 100%",
      ...style,
    }}
  />
);

// --------------------------------------------------------------------- status

export type Tone = "working" | "waiting" | "idle" | "done" | "failed" | "paused" | "live";
const TONE: Record<Tone, { fg: string; bg: string; line: string }> = {
  working: { fg: C.workingText, bg: C.workingSoft, line: C.workingLine },
  waiting: { fg: C.text, bg: "rgba(199,209,224,0.1)", line: "rgba(199,209,224,0.36)" },
  idle: { fg: C.text2, bg: "rgba(133,147,171,0.12)", line: "rgba(133,147,171,0.28)" },
  done: { fg: "#f3f6fb", bg: "rgba(238,243,251,0.08)", line: "rgba(238,243,251,0.3)" },
  failed: { fg: C.failedText, bg: C.failedSoft, line: "rgba(239,95,107,0.42)" },
  paused: { fg: C.pausedText, bg: C.pausedSoft, line: C.pausedLine },
  live: { fg: C.accentText, bg: C.accentSoft, line: C.borderLitSoft },
};
export const toneColor = (t: Tone) => TONE[t].fg;

export const StatusChip: React.FC<{ tone: Tone; label: string; pulse?: number; scale?: number }> = ({
  tone,
  label,
  pulse = 0,
  scale = 1,
}) => {
  const t = TONE[tone];
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7 * scale,
        height: 26 * scale,
        padding: `0 ${11 * scale}px`,
        borderRadius: 999,
        background: t.bg,
        border: `1px solid ${t.line}`,
        color: t.fg,
        fontFamily: FONT.ui,
        fontWeight: 600,
        fontSize: 12.5 * scale,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 7 * scale,
          height: 7 * scale,
          borderRadius: 99,
          background: t.fg,
          boxShadow: pulse ? `0 0 ${10 * pulse * scale}px ${t.fg}` : undefined,
          opacity: 0.75 + 0.25 * pulse,
        }}
      />
      {label}
    </div>
  );
};

// ---------------------------------------------------------------------- panes

export const Panel: React.FC<{ lit?: number; style?: React.CSSProperties; children?: React.ReactNode }> = ({
  lit = 0,
  style,
  children,
}) => (
  <div
    style={{
      position: "relative",
      background: C.surface1,
      backgroundImage: panelSheen,
      borderRadius: R.lg * S,
      border: `1px solid ${lit > 0.5 ? C.borderLit : C.border}`,
      boxShadow: lit > 0 ? `${shadowPanel}, ${shadowLit}` : shadowPanel,
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      ...style,
    }}
  >
    {children}
  </div>
);

export const ProviderDot: React.FC<{ provider: Provider; size?: number }> = ({ provider, size = 10 * S }) => (
  // Provider names only; no third-party logos. Each provider gets a neutral monogram tile.
  <div
    style={{
      width: size * 1.9,
      height: size * 1.9,
      borderRadius: 6,
      background: C.surface3,
      border: `1px solid ${C.borderStrong}`,
      display: "grid",
      placeItems: "center",
      fontFamily: FONT.mono,
      fontSize: size * 0.95,
      fontWeight: 700,
      color: C.text2,
      flexShrink: 0,
    }}
  >
    {provider === "Claude Code" ? "CC" : "CX"}
  </div>
);

export type Provider = "Claude Code" | "Codex";

export const PaneHeader: React.FC<{
  provider: Provider;
  title?: string;
  account?: string;
  tone: Tone;
  status: string;
  pulse?: number;
}> = ({ provider, title, account, tone, status, pulse }) => (
  <div
    style={{
      height: 50,
      flexShrink: 0,
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "0 16px",
      borderBottom: `1px solid ${C.borderSubtle}`,
      background: C.surface2,
      fontFamily: FONT.ui,
    }}
  >
    <ProviderDot provider={provider} size={12} />
    <div style={{ color: C.text, fontSize: 19, fontWeight: 500, whiteSpace: "nowrap" }}>{provider}</div>
    {title ? (
      <div style={{ color: C.muted, fontSize: 17, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {title}
      </div>
    ) : null}
    <div style={{ flex: 1 }} />
    {account ? (
      <div
        style={{
          fontSize: 14.5,
          color: C.text2,
          border: `1px solid ${C.border}`,
          borderRadius: R.sm * S,
          padding: "3px 9px",
          whiteSpace: "nowrap",
        }}
      >
        {account}
      </div>
    ) : null}
    <StatusChip tone={tone} label={status} pulse={pulse} scale={0.95} />
  </div>
);

export const TermLine: React.FC<{ children: React.ReactNode; color?: string; indent?: number; size?: number }> = ({
  children,
  color = C.text,
  indent = 0,
  size = 19,
}) => (
  <div
    style={{
      fontFamily: FONT.mono,
      fontSize: size,
      lineHeight: 1.62,
      color,
      paddingLeft: indent,
      whiteSpace: "pre",
      overflow: "hidden",
      textOverflow: "clip",
    }}
  >
    {children}
  </div>
);

export const Caret: React.FC<{ frame: number; color?: string; h?: number }> = ({
  frame,
  color = C.accentText,
  h = 22,
}) => (
  <span
    style={{
      display: "inline-block",
      width: 2,
      height: h,
      marginLeft: 2,
      verticalAlign: "middle",
      background: color,
      opacity: Math.floor(frame / 30) % 2 === 0 ? 1 : 0.15,
    }}
  />
);

// ----------------------------------------------------------------- app shell

export const NAV: { label: string; icon: LucideIcon }[] = [
  { label: "Dashboard", icon: LayoutDashboard },
  { label: "KalVoice", icon: AudioLines },
  { label: "Code", icon: Code2 },
  { label: "Threads", icon: MessagesSquare },
  { label: "Providers", icon: PlugZap },
];

export const Sidebar: React.FC<{ active?: string; width?: number; version?: string; workspace?: string }> = ({
  active = "Code",
  width = 300,
  version = "0.1.6",
  workspace = "kalcode",
}) => (
  <div
    style={{
      width,
      flexShrink: 0,
      height: "100%",
      background: C.bgSunken,
      borderRight: `1px solid ${C.borderSubtle}`,
      display: "flex",
      flexDirection: "column",
      padding: "22px 16px",
      gap: 6,
      fontFamily: FONT.ui,
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 6px 20px" }}>
      <Symbol size={38} />
      <Wordmark width={128} />
    </div>
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 12px",
        borderRadius: R.md * S,
        border: `1px solid ${C.border}`,
        background: C.surface1,
        marginBottom: 10,
      }}
    >
      <Icon icon={FolderOpen} size={20} color={C.muted} />
      <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
        <span style={{ fontSize: 11.5, letterSpacing: "0.12em", color: C.muted, textTransform: "uppercase" }}>
          Workspace
        </span>
        <span style={{ fontSize: 18, color: C.text }}>{workspace}</span>
      </div>
      <div style={{ flex: 1 }} />
      <Icon icon={ChevronDown} size={18} color={C.muted} />
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 12px", color: C.muted, fontSize: 17 }}>
      <Icon icon={Search} size={19} />
      Search
      <div style={{ flex: 1 }} />
      <span
        style={{
          fontFamily: FONT.mono,
          fontSize: 13,
          border: `1px solid ${C.border}`,
          borderRadius: 4,
          padding: "1px 6px",
        }}
      >
        Ctrl K
      </span>
    </div>
    <div style={{ height: 8 }} />
    {NAV.map((n) => {
      const on = n.label === active;
      return (
        <div
          key={n.label}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "11px 14px",
            borderRadius: R.md * S,
            color: on ? C.text : C.text2,
            background: on ? C.accentSoft : "transparent",
            border: `1px solid ${on ? C.borderLitSoft : "transparent"}`,
            fontSize: 18.5,
            position: "relative",
          }}
        >
          {on ? (
            <div
              style={{
                position: "absolute",
                left: -16,
                top: 8,
                bottom: 8,
                width: 3,
                borderRadius: 3,
                background: C.accent,
              }}
            />
          ) : null}
          <Icon icon={n.icon} size={21} color={on ? C.accentText : C.muted} />
          {n.label}
        </div>
      );
    })}
    <div style={{ flex: 1 }} />
    {[
      { l: "Approvals", i: ShieldCheck },
      { l: "Notifications", i: Bell },
      { l: "Settings", i: Settings },
    ].map((n) => (
      <div
        key={n.l}
        style={{ display: "flex", alignItems: "center", gap: 14, padding: "8px 14px", color: C.text2, fontSize: 17 }}
      >
        <Icon icon={n.i} size={19} color={C.muted} />
        {n.l}
      </div>
    ))}
    <div style={{ padding: "10px 14px 0", color: C.faint, fontSize: 14 }}>Version {version}</div>
  </div>
);

export const TabBar: React.FC<{ tabs: { label: string; icon?: LucideIcon; active?: boolean }[] }> = ({ tabs }) => (
  <div
    style={{
      height: 46,
      flexShrink: 0,
      display: "flex",
      alignItems: "flex-end",
      gap: 4,
      padding: "0 10px",
      background: C.surface2,
      borderBottom: `1px solid ${C.borderSubtle}`,
      fontFamily: FONT.ui,
    }}
  >
    {tabs.map((t) => (
      <div
        key={t.label}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          height: 38,
          padding: "0 14px",
          borderRadius: `${R.md * S}px ${R.md * S}px 0 0`,
          background: t.active ? C.surface1 : "transparent",
          border: t.active ? `1px solid ${C.border}` : "1px solid transparent",
          borderBottom: "none",
          color: t.active ? C.text : C.muted,
          fontSize: 16.5,
          whiteSpace: "nowrap",
        }}
      >
        {t.icon ? <Icon icon={t.icon} size={17} color={t.active ? C.accentText : C.muted} /> : null}
        {t.label}
        {t.active ? <Icon icon={X} size={14} color={C.muted} /> : null}
      </div>
    ))}
    <div style={{ height: 38, display: "flex", alignItems: "center", padding: "0 10px", color: C.muted }}>
      <Icon icon={Plus} size={17} />
    </div>
    <div style={{ flex: 1 }} />
    <div style={{ height: 38, display: "flex", alignItems: "center", padding: "0 8px", color: C.muted }}>
      <Icon icon={MoreHorizontal} size={18} />
    </div>
  </div>
);

export const BrowserChrome: React.FC<{ url: string; spin?: number; children?: React.ReactNode }> = ({
  url,
  spin = 0,
  children,
}) => (
  <>
    <TabBar tabs={[{ label: "Browser", icon: Globe, active: true }]} />
    <div
      style={{
        height: 54,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 16px",
        borderBottom: `1px solid ${C.borderSubtle}`,
        color: C.muted,
      }}
    >
      <Icon icon={ArrowLeft} size={19} />
      <Icon icon={ArrowRight} size={19} />
      <Icon
        icon={RotateCw}
        size={18}
        style={{ transform: `rotate(${spin * 360}deg)`, color: spin > 0 && spin < 1 ? C.accentText : undefined }}
      />
      <div
        style={{
          flex: 1,
          height: 34,
          borderRadius: R.md * S,
          background: C.bgSunken,
          border: `1px solid ${C.border}`,
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          fontFamily: FONT.mono,
          fontSize: 15.5,
          color: C.text2,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        {url}
      </div>
    </div>
    <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>{children}</div>
  </>
);

export const TerminalTab: React.FC<{ label: string }> = ({ label }) => (
  <TabBar tabs={[{ label, icon: SquareTerminal, active: true }]} />
);

export { Globe, SquareTerminal };
