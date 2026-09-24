import type { ThreadStatus, ThreadSummary } from "@kalcode/protocol";

export type StatusTone = "live" | "success" | "waiting" | "danger" | "idle";

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
  tone: StatusTone;
  group: StatusGroup;
}

/** Every contract status, exhaustively (a new status fails to compile until it is described). */
export const STATUS_META: Record<ThreadStatus, StatusMeta> = {
  starting: { label: "Starting", tone: "live", group: "working" },
  active: { label: "Working", tone: "live", group: "working" },
  thinking: { label: "Thinking", tone: "live", group: "working" },
  running_tool: { label: "Using a tool", tone: "live", group: "working" },
  running_command: { label: "Running command", tone: "live", group: "working" },
  editing: { label: "Editing files", tone: "live", group: "working" },
  testing: { label: "Testing", tone: "live", group: "working" },
  reviewing: { label: "Reviewing", tone: "live", group: "working" },
  recovering: { label: "Recovering", tone: "waiting", group: "working" },
  waiting_for_permission: { label: "Needs approval", tone: "waiting", group: "attention" },
  waiting_for_user: { label: "Needs your reply", tone: "waiting", group: "attention" },
  waiting_for_dependency: { label: "Blocked", tone: "idle", group: "waiting" },
  idle: { label: "Idle", tone: "idle", group: "idle" },
  paused: { label: "Paused", tone: "idle", group: "idle" },
  offline: { label: "Offline", tone: "danger", group: "idle" },
  completed: { label: "Completed", tone: "success", group: "finished" },
  failed: { label: "Failed", tone: "danger", group: "finished" },
  interrupted: { label: "Stopped", tone: "idle", group: "finished" },
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
