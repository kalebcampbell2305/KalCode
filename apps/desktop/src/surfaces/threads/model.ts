import type {
  PermissionMode,
  ProviderOption,
  ProviderStatus,
  ThreadMessage,
  ThreadStatus,
  ThreadSummary,
  ToolCallRecord,
  ToolCallStatus,
} from "@kalcode/protocol";
import type { StatusTone } from "@kalcode/ui/components";

export interface StatusPresentation {
  label: string;
  tone: StatusTone;
  /** The provider is actively working (animated indicator). */
  working: boolean;
}

/** Sentence-case labels for the structured thread states. Never derived from model prose. */
const STATUS: Record<ThreadStatus, StatusPresentation> = {
  starting: { label: "Starting", tone: "live", working: true },
  active: { label: "Working", tone: "live", working: true },
  thinking: { label: "Thinking", tone: "live", working: true },
  running_tool: { label: "Running a tool", tone: "live", working: true },
  running_command: { label: "Running a command", tone: "live", working: true },
  editing: { label: "Editing", tone: "live", working: true },
  testing: { label: "Testing", tone: "live", working: true },
  reviewing: { label: "Reviewing", tone: "live", working: true },
  recovering: { label: "Recovering", tone: "live", working: true },
  idle: { label: "Ready", tone: "success", working: false },
  waiting_for_permission: { label: "Needs approval", tone: "waiting", working: false },
  waiting_for_user: { label: "Needs your input", tone: "waiting", working: false },
  waiting_for_dependency: { label: "Waiting on another task", tone: "waiting", working: false },
  paused: { label: "Paused", tone: "idle", working: false },
  completed: { label: "Completed", tone: "success", working: false },
  failed: { label: "Failed", tone: "danger", working: false },
  interrupted: { label: "Stopped", tone: "idle", working: false },
  offline: { label: "Offline", tone: "danger", working: false },
};

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

export const TOOL_STATUS: Record<ToolCallStatus, { label: string; tone: StatusTone }> = {
  requested: { label: "Requested", tone: "waiting" },
  running: { label: "Running", tone: "live" },
  completed: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "idle" },
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
 * a provider only when KalCode has an adapter for it (Claude Code today) and detection found it
 * installed at a supported version and not signed out (`ProviderRegistry::usable`).
 */
export function unavailableProviders(
  statuses: readonly ProviderStatus[],
  offered: ReadonlySet<string>,
): UnavailableProvider[] {
  return statuses
    .filter((status) => !offered.has(status.id))
    .map((status) => ({ id: status.id, name: status.displayName, reason: unavailableReason(status) }));
}

function unavailableReason(status: ProviderStatus): string {
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
      return detection.auth === "not_authenticated" ? "Signed out" : "Not available";
  }
}
