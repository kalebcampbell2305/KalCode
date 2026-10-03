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
  const name = providerIdentity(info.providerId).name;
  // Codex: notifications and process state; approvals always in Codex's own prompt.
  if (info.providerId === "codex") {
    return info.hookChannel === "waiting"
      ? { text: "Limited status — no Codex notification yet", tone: "limited" }
      : { text: "Limited status — approvals in Codex", tone: "limited" };
  }
  // Gemini CLI: process state only.
  if (info.providerId === "gemini-cli") {
    return { text: "Process state only — approvals in Gemini CLI", tone: "limited" };
  }
  if (info.hookChannel === "limited") return { text: `Limited status — approvals in ${name}`, tone: "limited" };
  if (info.hookChannel === "waiting") return { text: `Connecting to ${name}…`, tone: "neutral" };
  if (!info.kalcodeAnswersApprovals) return { text: `Approvals in ${name}`, tone: "neutral" };
  return null;
}

/** What the pane info panel says KalCode sees in this pane (PROVIDER_PANES.md §4). */
export interface PaneInfoCopy {
  summary: string;
  /** Heading for the list of things KalCode doesn't see or stop. */
  limitsTitle: string;
  limits: string[];
  footer: string;
}

export function paneInfoCopy(providerId: string, info: PaneInfo | null, providerName?: string): PaneInfoCopy {
  const name = providerIdentity(providerId, providerName).name;
  if (providerId === "codex" || providerId === "gemini-cli") {
    const codex = providerId === "codex";
    return {
      summary: codex
        ? "Limited status: KalCode reads Codex's notifications (turn finished, approval requested) and process state. Approvals are answered in Codex's own prompt."
        : "Process state only: KalCode can't see Gemini CLI's tool calls yet. Approvals are answered in Gemini CLI's own prompt.",
      limitsTitle: "KalCode doesn't check in this pane:",
      limits: [
        `The tool calls ${name} makes. ${name}'s own prompt and settings decide them.`,
        `Commands you type into ${name} yourself. They carry your authority, like a terminal.`,
        `${name}'s own network traffic to its service.`,
      ],
      footer: codex
        ? "In Code, Plan is read-only. Auto keeps work inside the workspace and Codex asks only when it needs to leave that sandbox. Explicit Bypass uses Codex's unrestricted sandbox only after the separate high-risk confirmation."
        : "KalCode starts Gemini CLI in an approval mode no broader than this agent's permission mode (never yolo), but it can't block a single tool call here.",
    };
  }
  const answers = info?.kalcodeAnswersApprovals ?? false;
  return {
    summary:
      info?.hookChannel === "limited"
        ? `${name} isn't sending hook events, so KalCode shows limited status from the process only and approvals happen in ${name}. Your ${name} settings may turn hooks off.`
        : answers
          ? `Every tool call ${name} makes is checked by KalCode first. When KalCode asks, you answer here or in the approval queue.`
          : `Every tool call ${name} makes reaches KalCode first, and is blocked if KalCode can't be reached. Approvals are answered in ${name}'s own prompt in the pane.`,
    limitsTitle: "KalCode can't intercept:",
    limits: [
      `Commands you type into ${name} yourself. They carry your authority, like a terminal.`,
      "What a script run by an allowed command does inside itself.",
      `${name}'s own network traffic to its service.`,
      `Slash commands and mode changes in the pane. They change ${name}'s prompting only.`,
    ],
    footer: `KalCode always blocks pushes, publishes, deploy and cloud CLIs, and reading credential files, whatever ${name}'s settings allow.`,
  };
}

/** The activity a pane's provider sets while its own prompt waits for the person. */
export function isAnswerInProvider(activity: string | null): boolean {
  return activity?.startsWith("Answer in ") ?? false;
}

export function modelLabel(thread: ThreadSummary): string {
  return thread.model ?? (thread.providerId === "claude-code" ? "Account default" : "Provider default");
}

/** The region's accessible name. */
export function paneLabel(thread: ThreadSummary): string {
  return `${thread.name}, ${providerIdentity(thread.providerId, thread.providerName).name} agent`;
}
