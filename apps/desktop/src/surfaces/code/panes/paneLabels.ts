import {
  DISPLAY_QUALIFIER_LABEL,
  DISPLAY_STATUS_LABEL,
  DISPLAY_STATUS_TONE,
  displayStatusOf,
  type PaneInfo,
  type StatusTone,
  type ThreadStatus,
  type ThreadSummary,
} from "@kalcode/protocol";

/** Provider identity (ADVANCED.md §17): a neutral KalCode glyph + the name in plain text. */
export interface ProviderIdentity {
  name: string;
  /** The glyph's letter. Glyphs never imitate a provider's own mark. */
  initial: string;
  shape: "square" | "hexagon" | "circle";
}

const IDENTITIES: Record<string, ProviderIdentity> = {
  "claude-code": { name: "Claude Code", initial: "C", shape: "square" },
  codex: { name: "Codex", initial: "X", shape: "hexagon" },
  "gemini-cli": { name: "Gemini CLI", initial: "G", shape: "circle" },
};

export function providerIdentity(providerId: string, fallbackName?: string): ProviderIdentity {
  return (
    IDENTITIES[providerId] ?? {
      name: fallbackName ?? providerId,
      initial: (fallbackName ?? providerId).charAt(0).toUpperCase() || "?",
      shape: "circle",
    }
  );
}

export interface PaneStatusView {
  /** UPPERCASE label (never colour alone). */
  label: string;
  qualifier: string | null;
  tone: StatusTone;
  display: string;
}

/** The display status of a thread, through the one shared mapping (packages/protocol). */
export function paneStatus(status: ThreadStatus): PaneStatusView {
  const { status: display, qualifier } = displayStatusOf(status);
  return {
    label: DISPLAY_STATUS_LABEL[display],
    qualifier: qualifier ? DISPLAY_QUALIFIER_LABEL[qualifier] : null,
    tone: DISPLAY_STATUS_TONE[display],
    display,
  };
}

/** What the header says about who answers approvals and how much KalCode can see. */
export function channelNote(info: PaneInfo | null): { text: string; tone: "neutral" | "limited" | "ended" } | null {
  if (!info) return null;
  if (info.hookChannel === "ended" || !info.running) {
    return { text: info.exitCode === null ? "Ended" : `Ended (exit ${info.exitCode})`, tone: "ended" };
  }
  if (info.hookChannel === "limited") return { text: "Limited status — approvals in Claude Code", tone: "limited" };
  if (info.hookChannel === "waiting") return { text: "Connecting to Claude Code…", tone: "neutral" };
  if (!info.kalcodeAnswersApprovals) return { text: "Approvals in Claude Code", tone: "neutral" };
  return null;
}

export function modelLabel(thread: ThreadSummary): string {
  return thread.model ?? "Account default";
}

/** The region's accessible name. */
export function paneLabel(thread: ThreadSummary): string {
  return `${thread.name}, ${providerIdentity(thread.providerId, thread.providerName).name} pane`;
}
