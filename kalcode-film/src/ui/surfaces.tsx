// Stable 0.1.6 surfaces and cards, abstracted for motion. All strings are verbatim app UI
// (see product_truth.md) except sample project data (thread titles, files, output).
import { ArrowLeftRight, ChevronDown, Plus, Send, ShieldAlert, SquareTerminal, UserRound } from "lucide-react";
import type React from "react";
import { C, FONT, R } from "../brand/tokens";
import { Button } from "./Cockpit";
import { BrowserChrome, Icon, StatusChip, Symbol, TabBar, type Tone, Wordmark } from "./kit";

// ------------------------------------------------------------------ terminal

export type TLine = { text: string; color?: string; bold?: boolean };
export const TerminalBody: React.FC<{
  lines: TLine[];
  size?: number;
  caret?: boolean;
  frame?: number;
  title?: string;
}> = ({ lines, size = 19, caret, frame = 0, title = "PowerShell 7" }) => (
  <>
    <TabBar tabs={[{ label: title, icon: SquareTerminal, active: true }]} />
    <div
      style={{
        flex: 1,
        padding: "14px 18px",
        background: C.codeBg,
        fontFamily: FONT.mono,
        fontSize: size,
        lineHeight: 1.6,
        overflow: "hidden",
      }}
    >
      {lines.map((l, i) => (
        <div key={i} style={{ whiteSpace: "pre", color: l.color ?? C.text2, fontWeight: l.bold ? 600 : 400 }}>
          {l.text}
          {caret && i === lines.length - 1 ? (
            <span
              style={{
                display: "inline-block",
                width: size * 0.55,
                height: size * 1.05,
                background: C.accentText,
                verticalAlign: "text-bottom",
                marginLeft: 2,
                opacity: Math.floor(frame / 30) % 2 ? 0.2 : 0.9,
              }}
            />
          ) : null}
        </div>
      ))}
    </div>
  </>
);

// --------------------------------------------------------------- website page

/** The kalcoded.com page as served by the dev server (sample, simplified). */
export const SitePage: React.FC<{ variant: "home" | "old" | "new"; t?: number; scale?: number }> = ({
  variant,
  t = 1,
  scale = 1,
}) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background: "radial-gradient(80% 70% at 70% 0%, rgba(76,141,255,0.16), transparent 60%), #05080f",
      fontFamily: FONT.ui,
      transform: `scale(${scale})`,
      transformOrigin: "0 0",
      width: `${100 / scale}%`,
      height: `${100 / scale}%`,
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 22, padding: "20px 34px", fontSize: 15, color: C.text2 }}>
      <Symbol size={30} />
      <Wordmark width={110} />
      <div style={{ flex: 1 }} />
      {["Product", "KalVoice", "Pricing", "Docs", "Updates"].map((n) => (
        <span key={n}>{n}</span>
      ))}
      <span style={{ background: "#fff", color: "#05080f", borderRadius: 999, padding: "7px 16px", fontWeight: 500 }}>
        Download
      </span>
    </div>
    {variant === "home" ? (
      <div style={{ padding: "60px 34px 0" }}>
        <div style={{ fontSize: 15, color: C.accentText, letterSpacing: "0.2em" }}>CODE THE FUTURE</div>
        <div
          style={{
            fontSize: 50,
            fontWeight: 600,
            color: C.text,
            lineHeight: 1.05,
            marginTop: 16,
            maxWidth: 640,
            letterSpacing: "-0.02em",
          }}
        >
          One intelligence that operates your entire AI workspace.
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 30 }}>
          <span
            style={{
              background: `linear-gradient(180deg, ${C.btnTop}, ${C.btnBottom})`,
              color: "#fff",
              borderRadius: 999,
              padding: "12px 22px",
              fontSize: 16,
            }}
          >
            Download KalCode
          </span>
          <span
            style={{
              border: `1px solid ${C.borderStrong}`,
              color: C.text,
              borderRadius: 999,
              padding: "12px 22px",
              fontSize: 16,
            }}
          >
            See it in action
          </span>
        </div>
      </div>
    ) : (
      <DownloadHero variant={variant} t={t} />
    )}
  </div>
);

/** The download page hero, before and after the redesign the thread performs (sample work). */
const DownloadHero: React.FC<{ variant: "old" | "new"; t: number }> = ({ variant, t }) =>
  variant === "old" ? (
    <div style={{ padding: "50px 34px 0" }}>
      <div style={{ fontSize: 36, fontWeight: 500, color: C.text }}>Download</div>
      <div style={{ fontSize: 16, color: C.muted, marginTop: 10 }}>Windows · Stable</div>
      <div
        style={{
          marginTop: 22,
          display: "inline-block",
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          padding: "10px 16px",
          color: C.text2,
          fontSize: 15,
        }}
      >
        Download for Windows
      </div>
    </div>
  ) : (
    <div style={{ padding: "34px 34px 0", display: "flex", alignItems: "center", gap: 36 }}>
      <div style={{ flex: 1, opacity: t, transform: `translateY(${(1 - t) * 26}px)` }}>
        <div style={{ fontSize: 15, color: C.accentText, letterSpacing: "0.2em" }}>DOWNLOAD</div>
        <div
          style={{
            fontSize: 50,
            fontWeight: 600,
            color: C.text,
            lineHeight: 1.04,
            marginTop: 12,
            letterSpacing: "-0.02em",
          }}
        >
          Get KalCode.
        </div>
        <div style={{ fontSize: 17, color: C.text2, marginTop: 12 }}>Start on Free. Upgrade any time.</div>
        <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
          <span
            style={{
              background: `linear-gradient(180deg, ${C.btnTop}, ${C.btnBottom})`,
              color: "#fff",
              borderRadius: 999,
              padding: "12px 20px",
              fontSize: 16,
              boxShadow: "0 0 30px -6px rgba(76,141,255,0.7)",
            }}
          >
            Download for Windows
          </span>
          <span
            style={{
              border: `1px solid ${C.borderStrong}`,
              color: C.text,
              borderRadius: 999,
              padding: "12px 20px",
              fontSize: 16,
            }}
          >
            Download for macOS
          </span>
        </div>
      </div>
      <div style={{ opacity: t, transform: `scale(${0.8 + 0.2 * t})` }}>
        <Symbol size={220} />
      </div>
    </div>
  );

export const BrowserBody: React.FC<{ url: string; spin?: number; children: React.ReactNode }> = ({
  url,
  spin,
  children,
}) => (
  <BrowserChrome url={url} spin={spin}>
    {children}
  </BrowserChrome>
);

// -------------------------------------------------------------------- threads

export type Thread = {
  title: string;
  provider: "Claude Code" | "Codex";
  account: string;
  status: string;
  tone: Tone;
  lit?: number;
};

export const ThreadRow: React.FC<{ t: Thread; selected?: boolean; w?: number }> = ({ t, selected, w }) => (
  <div
    style={{
      width: w,
      display: "flex",
      alignItems: "center",
      gap: 14,
      padding: "14px 16px",
      borderRadius: R.lg * 1.5,
      background: selected ? C.accentSoft : C.surface1,
      border: `1px solid ${selected ? C.borderLitSoft : C.border}`,
      boxShadow: t.lit ? `0 0 ${30 * t.lit}px -8px rgba(76,141,255,${0.6 * t.lit})` : undefined,
    }}
  >
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
      <span style={{ fontSize: 19, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {t.title}
      </span>
      <span style={{ fontSize: 15, color: C.muted, whiteSpace: "nowrap" }}>
        {t.provider} · {t.account}
      </span>
    </div>
    <StatusChip tone={t.tone} label={t.status} scale={0.92} />
  </div>
);

export const ThreadHeader: React.FC<{ t: Thread; menuHot?: number }> = ({ t, menuHot = 0 }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 14,
      padding: "16px 22px",
      borderBottom: `1px solid ${C.borderSubtle}`,
      background: C.surface2,
    }}
  >
    <Icon icon={SquareTerminal} size={22} color={C.accentText} />
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span style={{ fontSize: 21, color: C.text }}>{t.title}</span>
      <span style={{ fontSize: 15, color: C.muted }}>{t.provider} · Approve</span>
    </div>
    <div style={{ flex: 1 }} />
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: R.md * 1.5,
        border: `1px solid ${menuHot > 0.5 ? C.borderLit : C.border}`,
        background: menuHot > 0.5 ? C.accentSoft : "transparent",
        color: C.text2,
        fontSize: 15.5,
      }}
    >
      <Icon icon={UserRound} size={16} />
      {t.account}
      <Icon icon={ChevronDown} size={15} />
    </div>
    <StatusChip tone={t.tone} label={t.status} />
  </div>
);

export const Composer: React.FC<{
  provider: string;
  text?: string;
  live?: number;
  caret?: boolean;
  frame?: number;
}> = ({ provider, text, live = 0, caret, frame = 0 }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      margin: 18,
      padding: "14px 16px",
      borderRadius: R.lg * 1.5,
      border: `1px solid ${live > 0.3 ? C.borderLit : C.border}`,
      background: C.surface2,
      boxShadow: live > 0 ? `0 0 ${30 * live}px -8px rgba(76,141,255,${0.6 * live})` : undefined,
    }}
  >
    <span style={{ flex: 1, fontSize: 19, color: text ? C.text : C.faint, whiteSpace: "nowrap", overflow: "hidden" }}>
      {text || `Message ${provider}`}
      {caret ? (
        <span
          style={{
            display: "inline-block",
            width: 2,
            height: 22,
            background: C.accentText,
            marginLeft: 2,
            verticalAlign: "middle",
            opacity: Math.floor(frame / 30) % 2 ? 0.2 : 1,
          }}
        />
      ) : null}
    </span>
    <Button label="Send" icon={<Icon icon={Send} size={16} />} primary={!!text} />
  </div>
);

export const Transcript: React.FC<{ lines: TLine[]; size?: number }> = ({ lines, size = 18 }) => (
  <div
    style={{
      flex: 1,
      padding: "16px 24px",
      fontFamily: FONT.mono,
      fontSize: size,
      lineHeight: 1.65,
      overflow: "hidden",
    }}
  >
    {lines.map((l, i) => (
      <div key={i} style={{ whiteSpace: "pre", color: l.color ?? C.text2, fontWeight: l.bold ? 600 : 400 }}>
        {l.text}
      </div>
    ))}
  </div>
);

// ------------------------------------------------------------------ overlays

export const Dialog: React.FC<{ title: string; body: string; note?: string; confirm: string; press?: number }> = ({
  title,
  body,
  note,
  confirm,
  press = 0,
}) => (
  <div
    style={{
      width: 620,
      padding: 28,
      borderRadius: R.xl * 1.5,
      background: C.surface3,
      border: `1px solid ${C.borderStrong}`,
      boxShadow: "0 40px 90px -20px rgba(0,0,0,0.9)",
    }}
  >
    <div style={{ fontSize: 26, color: C.text, fontWeight: 500 }}>{title}</div>
    <div style={{ fontSize: 19, color: C.text2, marginTop: 12 }}>{body}</div>
    {note ? <div style={{ fontSize: 16, color: C.muted, marginTop: 10, lineHeight: 1.45 }}>{note}</div> : null}
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 24 }}>
      <Button label="Cancel" />
      <Button label={confirm} primary style={{ transform: `scale(${1 - 0.05 * press})` }} />
    </div>
  </div>
);

export const Toast: React.FC<{ title: string; body: string }> = ({ title, body }) => (
  <div
    style={{
      display: "flex",
      gap: 14,
      alignItems: "flex-start",
      width: 520,
      padding: "18px 20px",
      borderRadius: R.lg * 1.5,
      background: C.surface3,
      border: `1px solid ${C.workingLine}`,
      boxShadow: "0 30px 70px -20px rgba(0,0,0,0.9)",
    }}
  >
    <div
      style={{
        width: 10,
        height: 10,
        borderRadius: 9,
        background: C.working,
        marginTop: 8,
        boxShadow: `0 0 10px ${C.working}`,
      }}
    />
    <div>
      <div style={{ fontSize: 19, color: C.text }}>{title}</div>
      <div style={{ fontSize: 15.5, color: C.muted, marginTop: 4 }}>{body}</div>
    </div>
  </div>
);

export const Menu: React.FC<{
  title: string;
  items: { label: string; checked?: boolean; hot?: boolean; icon?: boolean }[];
}> = ({ title, items }) => (
  <div
    style={{
      width: 300,
      padding: 8,
      borderRadius: R.lg * 1.5,
      background: C.surface3,
      border: `1px solid ${C.borderStrong}`,
      boxShadow: "0 30px 70px -20px rgba(0,0,0,0.9)",
    }}
  >
    <div
      style={{ fontSize: 13, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase", padding: "8px 12px" }}
    >
      {title}
    </div>
    {items.map((it) => (
      <div
        key={it.label}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          borderRadius: 8,
          background: it.hot ? C.accentSoft : undefined,
          color: it.hot ? C.text : C.text2,
          fontSize: 17,
        }}
      >
        <Icon icon={it.icon ? Plus : UserRound} size={16} />
        {it.label}
        <div style={{ flex: 1 }} />
        {it.checked ? <span style={{ color: C.accentText }}>✓</span> : null}
      </div>
    ))}
  </div>
);

export const ApprovalCard: React.FC<{ press?: number; resolved?: number }> = ({ press = 0, resolved = 0 }) => (
  <div
    style={{
      width: 760,
      padding: 26,
      borderRadius: R.xl * 1.5,
      background: C.surface3,
      border: `1px solid ${resolved > 0.5 ? C.workingLine : C.borderLit}`,
      boxShadow: "0 40px 90px -20px rgba(0,0,0,0.9), 0 0 40px -12px rgba(76,141,255,0.5)",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <Icon icon={ShieldAlert} size={24} color={C.accentText} />
      <span style={{ fontSize: 16, letterSpacing: "0.12em", textTransform: "uppercase", color: C.accentText }}>
        Needs approval
      </span>
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 15, color: C.muted }}>Claude Code · Release</span>
    </div>
    <div style={{ fontSize: 26, color: C.text, marginTop: 14 }}>Push to a remote</div>
    <div
      style={{
        fontFamily: FONT.mono,
        fontSize: 19,
        color: C.text2,
        marginTop: 10,
        padding: "10px 14px",
        background: C.codeBg,
        borderRadius: 8,
        border: `1px solid ${C.border}`,
      }}
    >
      git push origin main
    </div>
    <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
      <Button label="Deny" />
      <Button label="Allow for workspace" />
      <Button label="Allow for thread" />
      <div style={{ flex: 1 }} />
      <Button
        label={resolved > 0.5 ? "Approved" : "Approve once"}
        primary
        style={{ transform: `scale(${1 - 0.06 * press})` }}
      />
    </div>
  </div>
);

export const UpdateCard: React.FC<{ version?: string; press?: number }> = ({ version = "0.1.7", press = 0 }) => (
  <div
    style={{
      width: 560,
      padding: 24,
      borderRadius: R.xl * 1.5,
      background: C.surface3,
      border: `1px solid ${C.borderLitSoft}`,
      boxShadow: "0 40px 90px -20px rgba(0,0,0,0.9)",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <Symbol size={46} />
      <div>
        <div style={{ fontSize: 21, color: C.text }}>KalCode {version} is ready to install.</div>
        <div style={{ fontSize: 16, color: C.muted, marginTop: 4 }}>Your work stays open until you restart.</div>
      </div>
    </div>
    <div style={{ display: "flex", gap: 10, marginTop: 20, justifyContent: "flex-end" }}>
      <Button label="Details" />
      <Button label="Later" />
      <Button label="Restart to update" primary style={{ transform: `scale(${1 - 0.06 * press})` }} />
    </div>
  </div>
);

/** A minimal macOS window frame (traffic lights) — the update card is shown on macOS only. */
export const MacWindow: React.FC<{ w: number; h: number; title: string; children: React.ReactNode }> = ({
  w,
  h,
  title,
  children,
}) => (
  <div
    style={{
      width: w,
      height: h,
      borderRadius: 14,
      background: C.bg,
      border: `1px solid ${C.borderStrong}`,
      overflow: "hidden",
      boxShadow: "0 40px 90px -20px rgba(0,0,0,0.9)",
      position: "relative",
    }}
  >
    <div
      style={{
        height: 40,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 14px",
        background: C.surface2,
        borderBottom: `1px solid ${C.borderSubtle}`,
      }}
    >
      {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
        <span key={c} style={{ width: 12, height: 12, borderRadius: 9, background: c, opacity: 0.85 }} />
      ))}
      <span style={{ flex: 1, textAlign: "center", fontSize: 14, color: C.muted, marginRight: 50 }}>{title}</span>
    </div>
    <div style={{ position: "absolute", top: 40, left: 0, right: 0, bottom: 0 }}>{children}</div>
  </div>
);

export { ArrowLeftRight };
