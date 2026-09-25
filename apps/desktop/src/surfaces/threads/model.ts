import {
  DISPLAY_STATUS_TONE,
  type DisplayStatus,
  type StatusTone as DisplayTone,
  displayStatusOf,
  type PermissionMode,
  type ProviderOption,
  type ProviderStatus,
  type ThreadMessage,
  type ThreadStatus,
  type ThreadSummary,
  type ToolCallRecord,
  type ToolCallStatus,
} from "@kalcode/protocol";

export interface StatusPresentation {
  label: string;
  /** Contract tone (working green, waiting neutral, paused amber, failed red, ...). */
  tone: DisplayTone;
  /** The normalized display status (drives the status glyph). */
  display: DisplayStatus;
  /** The provider is actively working (animated indicator). */
  working: boolean;
}

/** Sentence-case labels for the structured thread states. Never derived from model prose. */
const LABELS: Record<ThreadStatus, { label: string; working: boolean }> = {
  starting: { label: "Starting", working: true },
  active: { label: "Working", working: true },
  thinking: { label: "Thinking", working: true },
  running_tool: { label: "Running a tool", working: true },
  running_command: { label: "Running a command", working: true },
  editing: { label: "Editing", working: true },
  testing: { label: "Testing", working: true },
  reviewing: { label: "Reviewing", working: true },
  recovering: { label: "Recovering", working: true },
  idle: { label: "Ready", working: false },
  waiting_for_permission: { label: "Needs approval", working: false },
  waiting_for_user: { label: "Needs your input", working: false },
  waiting_for_dependency: { label: "Waiting on another task", working: false },
  paused: { label: "Paused", working: false },
  completed: { label: "Completed", working: false },
  failed: { label: "Failed", working: false },
  interrupted: { label: "Stopped", working: false },
  offline: { label: "Offline", working: false },
};

const STATUS = Object.fromEntries(
  (Object.keys(LABELS) as ThreadStatus[]).map((status) => {
    const display = displayStatusOf(status).status;
    return [status, { ...LABELS[status], display, tone: DISPLAY_STATUS_TONE[display] }];
  }),
) as Record<ThreadStatus, StatusPresentation>;

export function presentStatus(status: ThreadStatus): StatusPresentation {
  return STATUS[status];
}

export const PERMISSION_MODES: Record<PermissionMode, { label: string; description: string }> = {
  plan: { label: "Plan", description: "Reads and plans. Nothing is changed." },
  approve: {
    label: "Approve",
    description: "Reads run freely. Edits, commands and network access wait for your approval.",
  },
  auto: {
    label: "Auto",
    description: "Actions your permission rules cover run automatically. Everything else still asks.",
  },
  bypass: { label: "Bypass", description: "Broad local authority. Remote actions still follow their own rules." },
  custom: { label: "Custom", description: "A named rule set." },
};

/**
 * What the chosen provider actually enforces in a mode, when it can't hand approvals to KalCode.
 * The text is the provider's own mapping note (generated natively from the flags KalCode passes),
 * so this copy can't claim more than the launch does. Custom runs on the Approve mapping.
 */
export function providerModeNote(
  provider: Pick<ProviderOption, "displayName" | "hostApprovals" | "permissionMappings">,
  mode: PermissionMode,
): string {
  if (provider.hostApprovals) return "";
  const mapped = mode === "custom" ? "approve" : mode;
  const mapping = provider.permissionMappings.find((m) => m.mode === mapped);
  if (!mapping) {
    return ` ${provider.displayName} can't hand approvals to KalCode yet, so anything that would ask is refused.`;
  }
  const custom = mode === "custom" ? " Custom rules aren't applied to this provider yet; it runs as Approve." : "";
  return ` With ${provider.displayName}: ${mapping.notes}${custom}`;
}

const TERMINAL: ReadonlySet<ThreadStatus> = new Set(["completed", "failed", "interrupted"]);

export interface ThreadActions {
  interrupt: boolean;
  stop: boolean;
  resume: boolean;
  archive: boolean;
  /** What the composer does: send to the live session, resume the thread with the message, or nothing. */
  compose: "send" | "resume" | "blocked";
}

/** Which actions are valid for a thread in its current state (mirrors the native rules). */
export function threadActions(thread: Pick<ThreadSummary, "status">, archived = false): ThreadActions {
  const status = thread.status;
  const terminal = TERMINAL.has(status);
  const working = STATUS[status].working;
  if (archived) {
    return { interrupt: false, stop: false, resume: false, archive: false, compose: "blocked" };
  }
  return {
    interrupt: (working && status !== "starting" && status !== "recovering") || status === "waiting_for_permission",
    stop: !terminal,
    resume: terminal || status === "paused",
    archive: terminal,
    compose: terminal || status === "paused" ? "resume" : status === "waiting_for_permission" ? "blocked" : "send",
  };
}

export type TimelineItem =
  | { kind: "message"; at: string; key: string; message: ThreadMessage }
  | { kind: "tool"; at: string; key: string; tool: ToolCallRecord };

/** Messages and tool calls in the order they happened. Ties keep messages first. */
export function buildTimeline(messages: readonly ThreadMessage[], tools: readonly ToolCallRecord[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...messages.map((message) => ({ kind: "message" as const, at: message.createdAt, key: message.id, message })),
    ...tools.map((tool) => ({ kind: "tool" as const, at: tool.requestedAt, key: tool.id, tool })),
  ];
  const order = new Map(items.map((item, index) => [item.key, index]));
  return items.sort((a, b) => a.at.localeCompare(b.at) || (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}

export const TOOL_STATUS: Record<ToolCallStatus, { label: string; tone: DisplayTone }> = {
  requested: { label: "Requested", tone: "waiting" },
  running: { label: "Running", tone: "working" },
  completed: { label: "Done", tone: "done" },
  failed: { label: "Failed", tone: "failed" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

/** Case-insensitive match on the fields people search threads by. */
export function matchesQuery(thread: ThreadSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    thread.name,
    thread.providerName,
    thread.workspaceName,
    thread.currentActivity ?? "",
    presentStatus(thread.status).label,
  ]
    .join("\n")
    .toLowerCase()
    .includes(q);
}

/** Event types that change what the Threads surface shows. */
export function isThreadEvent(type: string): boolean {
  return (
    type.startsWith("thread.") ||
    type.startsWith("agent.") ||
    type.startsWith("tool.") ||
    type.startsWith("file.") ||
    type.startsWith("approval.") ||
    type === "provider.error" ||
    type === "permission.mode_changed"
  );
}

export interface UnavailableProvider {
  id: string;
  name: string;
  /** Plain-language reason threads can't use it, e.g. "Not installed". */
  reason: string;
}

/**
 * Providers KalCode knows that the New thread flow does not offer, with the reason. Threads use
 * a provider only when KalCode has an adapter for it (Claude Code, Codex and Gemini CLI) and
 * detection found it installed at a supported version and not signed out
 * (`ProviderRegistry::usable`).
 */
export function unavailableProviders(
  statuses: readonly ProviderStatus[],
  offered: ReadonlySet<string>,
): UnavailableProvider[] {
  return statuses
    .filter((status) => !offered.has(status.id))
    .map((status) => ({ id: status.id, name: status.displayName, reason: unavailableReason(status) }));
}

export function unavailableReason(status: ProviderStatus): string {
  const detection = status.detection;
  const state = detection?.state;
  if (status.adapter !== "implemented") {
    return state === "installed" || state === "outdated"
      ? "Installed, but KalCode can't run threads with it yet"
      : "KalCode can't run threads with it yet";
  }
  if (!detection) return "Not checked yet";
  switch (detection.state) {
    case "not_installed":
      return "Not installed";
    case "outdated":
      return detection.minimumVersion ? `Needs version ${detection.minimumVersion} or later` : "Needs an update";
    case "error":
      return "Couldn't be checked";
    default:
      // Plain text: the person runs the provider's own sign-in command in a terminal.
      return detection.auth === "not_authenticated" ? `Signed out — run ${status.signInCommand}` : "Not available";
  }
}
