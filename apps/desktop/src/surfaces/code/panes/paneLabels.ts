import {
  AGENT_STATE_LABEL,
  AGENT_STATE_TONE,
  agentStateOf,
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
  cursor: { name: "Cursor", initial: "C", shape: "circle" },
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

type AgentFacts = Pick<ThreadSummary, "status" | "currentActivity" | "pendingApprovals"> &
  Partial<Pick<ThreadSummary, "resumable">>;

/**
 * The agent's state, through the one shared agent-state model (packages/protocol): the same words
 * for every provider ("Codex B · NEEDS YOU"). The qualifier adds the one observed fact the word
 * can't carry.
 */
export function paneStatus(agent: AgentFacts): PaneStatusView {
  const state = agentStateOf(agent);
  const qualifier =
    agent.status === "waiting_for_dependency"
      ? "waiting on another task"
      : agent.status === "interrupted"
        ? agent.resumable
          ? "resumable"
          : "historical"
        : agent.status === "paused"
          ? "paused"
          : agent.status === "offline"
            ? "offline"
            : null;
  return { label: AGENT_STATE_LABEL[state], qualifier, tone: AGENT_STATE_TONE[state], display: state };
}

/** What the header says about who answers approvals and how much KalCode can see. */
export function channelNote(info: PaneInfo | null): { text: string; tone: "neutral" | "limited" | "ended" } | null {
  if (!info) return null;
  if (info.hookChannel === "ended" || !info.running) {
    return { text: info.exitCode === null ? "Ended" : `Ended (exit ${info.exitCode})`, tone: "ended" };
  }
  const name = providerIdentity(info.providerId).name;
  // From the session's real channel state, never the provider's name: every provider reads the same.
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
  if (providerId === "cursor") {
    return {
      summary:
        info?.hookChannel === "active"
          ? "Cursor runs in its native interactive terminal. Native lifecycle hooks report session readiness and completed turns to KalCode."
          : "Cursor lifecycle hooks are unavailable for this session. Work in the terminal; automatic handoffs wait for verified readiness.",
      limitsTitle: "Session visibility:",
      limits: [
        "Cursor handles its own tools, model changes, settings and interactive prompts.",
        "Use Cursor's native commands to inspect or change the running session.",
      ],
      footer: "Your native Cursor authentication and configuration are preserved.",
    };
  }
  if (providerId === "codex" || providerId === "gemini-cli") {
    const codex = providerId === "codex";
    return {
      summary: codex
        ? "KalCode reads Codex's own lifecycle hooks (prompt, tool calls, approval requests, turn end) where this Codex version supports them, otherwise its turn-finished notification and process state. Approvals are answered in Codex's own prompt."
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

/** An agent whose provider process ended (or never started) and can be started again. */
export function canResumePane(status: ThreadStatus, running: boolean): boolean {
  return (
    !running && (status === "failed" || status === "interrupted" || status === "completed" || status === "offline")
  );
}

/** One line for the ended bar: what happened to this agent's provider. */
export function endedSummary(
  status: ThreadStatus,
  providerName: string,
  exitCode: number | null,
  errorMessage: string | null,
  resumable = true,
): string {
  // Short: the bar shares a narrow pane with Resume, and the tab already names the provider.
  if (status === "failed") return errorMessage || `${providerName} stopped with an error`;
  if (status === "interrupted")
    return resumable ? "Stopped · resume to pick up where it left off" : "Ended · saved in history";
  if (status === "offline") return `${providerName} is offline`;
  return exitCode !== null && exitCode !== 0 ? `Exited with code ${exitCode}` : "Finished";
}

/** The live line announced when KalCode starts holding a tool call for this pane. */
export function approvalAnnouncement(providerName: string, paneName: string): string {
  return `${providerName} needs approval in ${paneName}. Press Ctrl+Shift+E to answer.`;
}

/** The region's accessible name. */
export function paneLabel(thread: ThreadSummary): string {
  return `${thread.name}, ${providerIdentity(thread.providerId, thread.providerName).name} agent`;
}

/** What the pane header's tool indicator shows for the tool the agent is running. */
export interface PaneToolView {
  /** Short tool family: "Search web", "Shell", "MCP · github". */
  label: string;
  /** The provider's own summary of the call, for the tooltip. */
  detail: string;
}

const TOOL_STATUSES: ReadonlySet<ThreadStatus> = new Set(["running_tool", "running_command", "editing", "testing"]);

/**
 * The running tool, from the thread's structured status and activity summary (never terminal
 * text). Provider-independent: the summaries come from the shared action classifier.
 */
export function paneToolActivity(status: ThreadStatus, activity: string | null): PaneToolView | null {
  const detail = activity?.trim();
  if (!detail || !TOOL_STATUSES.has(status)) return null;
  const rules: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
    [/^Search the web\b/i, "Search web"],
    [/^Fetch\b/i, "Fetch page"],
    [/^Search files\b/i, "Search repo"],
    [/^Read\b/i, "Read file"],
    [/^(Edit|Write)\b/i, "Edit file"],
    [/^Run\b/i, "Shell"],
    [/^Use mcp__([^_]+(?:_[^_]+)*?)__/i, (m) => `MCP · ${m[1]}`],
    [/^Use (\S+)/i, (m) => m[1] ?? "Tool"],
  ];
  for (const [pattern, label] of rules) {
    const match = detail.match(pattern);
    if (match) return { label: typeof label === "string" ? label : label(match), detail };
  }
  return { label: status === "running_command" ? "Shell" : "Tool", detail };
}
