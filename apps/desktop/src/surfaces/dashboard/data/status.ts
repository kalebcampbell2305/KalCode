import {
  DISPLAY_STATUS_TONE,
  displayStatusOf,
  type StatusTone,
  type ThreadStatus,
  type ThreadSummary,
} from "@kalcode/protocol";

/**
 * The contract tone: working green, waiting / permission amber, muted, done high-contrast
 * neutral, failed red, paused amber, recovering blue.
 */
export type { StatusTone };

/**
 * Where a thread belongs on the Dashboard:
 * - attention: cannot continue until someone acts (permission, input)
 * - working:   a process is doing work now
 * - waiting:   blocked on something other than the user
 * - idle:      open but not doing anything (idle, paused, offline)
 * - finished:  reached an end state (completed, failed, interrupted)
 */
export type StatusGroup = "attention" | "working" | "waiting" | "idle" | "finished";

export interface StatusMeta {
  /** Sentence-case label shown next to the status glyph. */
  label: string;
  /** Always the contract tone of the status's display status (never chosen per surface). */
  tone: StatusTone;
  group: StatusGroup;
}

const toneOf = (status: ThreadStatus): StatusTone => DISPLAY_STATUS_TONE[displayStatusOf(status).status];

function meta(status: ThreadStatus, label: string, group: StatusGroup): StatusMeta {
  return { label, tone: toneOf(status), group };
}

/** Every contract status, exhaustively (a new status fails to compile until it is described). */
export const STATUS_META: Record<ThreadStatus, StatusMeta> = {
  starting: meta("starting", "Starting", "working"),
  active: meta("active", "Working", "working"),
  thinking: meta("thinking", "Thinking", "working"),
  running_tool: meta("running_tool", "Using a tool", "working"),
  running_command: meta("running_command", "Running command", "working"),
  editing: meta("editing", "Editing files", "working"),
  testing: meta("testing", "Testing", "working"),
  reviewing: meta("reviewing", "Reviewing", "working"),
  recovering: meta("recovering", "Recovering", "working"),
  waiting_for_permission: meta("waiting_for_permission", "Needs approval", "attention"),
  waiting_for_user: meta("waiting_for_user", "Needs your reply", "attention"),
  waiting_for_dependency: meta("waiting_for_dependency", "Blocked", "waiting"),
  idle: meta("idle", "Idle", "idle"),
  paused: meta("paused", "Paused", "idle"),
  offline: meta("offline", "Offline", "idle"),
  completed: meta("completed", "Completed", "finished"),
  failed: meta("failed", "Failed", "finished"),
  interrupted: meta("interrupted", "Stopped", "finished"),
};

/** Mirrors `ThreadStatus::is_live` in crates/contracts/src/threads.rs. */
export function isLive(status: ThreadStatus): boolean {
  return (
    status === "starting" ||
    status === "active" ||
    status === "thinking" ||
    status === "running_tool" ||
    status === "running_command" ||
    status === "editing" ||
    status === "testing" ||
    status === "reviewing" ||
    status === "recovering"
  );
}

/** Mirrors `ThreadStatus::is_terminal`. */
export function isTerminal(status: ThreadStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

/** Mirrors `ThreadStatus::needs_attention`. */
export function needsAttention(status: ThreadStatus): boolean {
  return status === "waiting_for_permission" || status === "waiting_for_user" || status === "failed";
}

const GROUP_RANK: Record<StatusGroup, number> = { attention: 0, working: 1, waiting: 2, idle: 3, finished: 4 };

function time(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Open threads in Dashboard order: those that need someone first, then working, then blocked,
 * then idle; most recent activity first within a group; name breaks ties so order is stable.
 */
export function sortOpenThreads(threads: readonly ThreadSummary[]): ThreadSummary[] {
  return threads
    .filter((t) => !isTerminal(t.status))
    .sort(
      (a, b) =>
        GROUP_RANK[STATUS_META[a.status].group] - GROUP_RANK[STATUS_META[b.status].group] ||
        time(b.lastActivityAt) - time(a.lastActivityAt) ||
        a.name.localeCompare(b.name),
    );
}

/** Finished threads (completed, failed, stopped), newest first, at most `limit`. */
export function recentOutcomes(threads: readonly ThreadSummary[], limit = 6): ThreadSummary[] {
  return threads
    .filter((t) => isTerminal(t.status))
    .sort((a, b) => time(b.lastActivityAt) - time(a.lastActivityAt) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export interface DashboardCounts {
  /** Threads with a process doing work now. */
  running: number;
  /** Pending approval requests (from the approval queue, not thread counters). */
  approvals: number;
  /** Threads waiting for the user's reply. */
  waitingForUser: number;
  failed: number;
  idle: number;
  completed: number;
  open: number;
}

export function countThreads(threads: readonly ThreadSummary[], pendingApprovals: number): DashboardCounts {
  const counts: DashboardCounts = {
    running: 0,
    approvals: pendingApprovals,
    waitingForUser: 0,
    failed: 0,
    idle: 0,
    completed: 0,
    open: 0,
  };
  for (const t of threads) {
    if (isLive(t.status)) counts.running += 1;
    if (t.status === "waiting_for_user") counts.waitingForUser += 1;
    if (t.status === "failed") counts.failed += 1;
    if (t.status === "completed") counts.completed += 1;
    if (STATUS_META[t.status].group === "idle") counts.idle += 1;
    if (!isTerminal(t.status)) counts.open += 1;
  }
  return counts;
}
