import {
  type DashboardChip,
  type DisplayStatus,
  displayStatusOf,
  type EventEnvelope,
  type ThreadStatus,
  type ThreadSummary,
} from "@kalcode/protocol";

/**
 * The Dashboard board's pure model (Z7-W3): chip counts, the one-line summary, filtering,
 * grouping and ordering. Everything is derived from `ThreadSummary.status` through the one
 * contract mapping (`displayStatusOf`), so the board, rail, panes and KalVoice agree.
 */

export const CHIPS: readonly DashboardChip[] = ["all", "waiting_for_you", "working", "done", "idle"];

export const CHIP_LABELS: Record<DashboardChip, string> = {
  all: "All",
  waiting_for_you: "Waiting for you",
  working: "Working",
  done: "Done",
  idle: "Idle",
};

export type ChipCounts = Record<DashboardChip, number>;

export function chipOf(status: ThreadStatus): DashboardChip {
  return displayStatusOf(status).chip;
}

export function chipCounts(threads: readonly ThreadSummary[]): ChipCounts {
  const counts: ChipCounts = { all: 0, waiting_for_you: 0, working: 0, done: 0, idle: 0 };
  for (const thread of threads) {
    counts.all += 1;
    counts[chipOf(thread.status)] += 1;
  }
  return counts;
}

const SUMMARY_PARTS: readonly [Exclude<DashboardChip, "all">, string][] = [
  ["working", "working"],
  ["waiting_for_you", "waiting for you"],
  ["done", "done"],
  ["idle", "idle"],
];

/** "21 agents · 2 working · 19 idle" — only real counts, zero groups left out. */
export function summaryLine(counts: ChipCounts): string {
  const head = `${counts.all} ${counts.all === 1 ? "agent" : "agents"}`;
  const parts = SUMMARY_PARTS.filter(([chip]) => counts[chip] > 0).map(([chip, words]) => `${counts[chip]} ${words}`);
  return [head, ...parts].join(" · ");
}

// ---- Agent Fleet groups (owner request 2026-10-03) ----
//
// The Fleet shows six filters: ALL, NEEDS YOU, WORKING, DONE, IDLE and FAILED. They partition the
// agents exactly (every agent is in one group), so the summary adds up. They follow the contract
// chips, except that FAILED is its own group: a failed run needs a decision (retry or clear), not
// an answer, and hundreds of old failures must never bury the agents that are waiting on a reply.

export type FleetGroupId = "needs_you" | "working" | "done" | "idle" | "failed";
export type FleetFilter = "all" | FleetGroupId;

export const FLEET_FILTERS: readonly FleetFilter[] = ["all", "needs_you", "working", "done", "idle", "failed"];
/** Status groups in board order: what needs the person first, history last. */
export const FLEET_GROUPS: readonly FleetGroupId[] = ["needs_you", "working", "done", "idle", "failed"];

export const FLEET_FILTER_LABELS: Record<FleetFilter, string> = {
  all: "All",
  needs_you: "Needs you",
  working: "Working",
  done: "Done",
  idle: "Idle",
  failed: "Failed",
};

export type FleetCounts = Record<FleetFilter, number>;

export function fleetGroupOf(status: ThreadStatus): FleetGroupId {
  if (status === "failed") return "failed";
  const chip = chipOf(status);
  return chip === "waiting_for_you" ? "needs_you" : chip === "all" ? "idle" : chip;
}

export function fleetCounts(threads: readonly ThreadSummary[]): FleetCounts {
  const counts: FleetCounts = { all: 0, needs_you: 0, working: 0, done: 0, idle: 0, failed: 0 };
  for (const thread of threads) {
    counts.all += 1;
    counts[fleetGroupOf(thread.status)] += 1;
  }
  return counts;
}

/** "27 agents · 1 working · 2 need you · 9 done · 15 idle": real counts, zero groups left out. */
export function fleetSummaryLine(counts: FleetCounts): string {
  const head = `${counts.all} ${counts.all === 1 ? "agent" : "agents"}`;
  const parts = [
    counts.working ? `${counts.working} working` : null,
    counts.needs_you ? `${counts.needs_you} ${counts.needs_you === 1 ? "needs" : "need"} you` : null,
    counts.done ? `${counts.done} done` : null,
    counts.idle ? `${counts.idle} idle` : null,
    counts.failed ? `${counts.failed} failed` : null,
  ];
  return [head, ...parts.filter(Boolean)].join(" · ");
}

/** A Dashboard chip request (KalVoice, notifications) as the Fleet filter that shows it. */
export function fleetFilterOf(chip: DashboardChip): FleetFilter {
  return chip === "waiting_for_you" ? "needs_you" : chip;
}

function searchFields(thread: ThreadSummary, extra: readonly (string | undefined)[]): string[] {
  const group = fleetGroupOf(thread.status);
  return [
    thread.name,
    thread.workspaceName,
    thread.branch,
    thread.providerName,
    thread.accountLabel,
    thread.model,
    thread.effort,
    thread.currentActivity,
    FLEET_FILTER_LABELS[group],
    group === "needs_you" ? "waiting" : null,
    thread.error?.message,
    ...extra,
  ]
    .filter((field): field is string => typeof field === "string")
    .map((field) => field.toLowerCase());
}

/**
 * Case-insensitive match on what a card shows: task, account, provider, workspace,
 * branch, model, effort, activity and status. Every word must match some field.
 */
export function matchesQuery(
  thread: ThreadSummary,
  query: string,
  extra: readonly (string | undefined)[] = [],
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const fields = searchFields(thread, extra);
  return q.split(/\s+/).every((word) => fields.some((field) => field.includes(word)));
}

/** The query as one phrase inside one field ("Codex B" the account, not "Codex" plus any "b"). */
function matchesPhrase(thread: ThreadSummary, phrase: string, extra: readonly (string | undefined)[]): boolean {
  return searchFields(thread, extra).some((field) => field.includes(phrase));
}

/**
 * The agents a filter and search show. A multi-word search that names something exactly (an
 * account like "Claude B", a task title) shows those matches; otherwise every word must match.
 */
export function filterThreads(
  threads: readonly ThreadSummary[],
  filter: FleetFilter,
  query: string,
  extraFields?: (thread: ThreadSummary) => readonly (string | undefined)[],
): ThreadSummary[] {
  const inFilter = filter === "all" ? [...threads] : threads.filter((t) => fleetGroupOf(t.status) === filter);
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return inFilter;
  const extra = (t: ThreadSummary) => extraFields?.(t) ?? [];
  if (q.includes(" ")) {
    const exact = inFilter.filter((t) => matchesPhrase(t, q, extra(t)));
    if (exact.length > 0) return exact;
  }
  return inFilter.filter((t) => matchesQuery(t, q, extra(t)));
}

export type GroupMode = "status" | "project" | "provider";

export const GROUP_MODE_LABELS: Record<GroupMode, string> = {
  status: "Status",
  project: "Project",
  provider: "Provider",
};

/**
 * Grouping modes this build can offer. Agent and Mission grouping arrive with Agents (Z8) and
 * Missions (Z9); until then they are not shown at all (never faked).
 */
export const GROUP_MODES: readonly GroupMode[] = ["status", "project", "provider"];

/** Urgency within the board: needs you, working, failed (a decision), done, idle. */
const GROUP_RANK: Record<FleetGroupId, number> = { needs_you: 0, working: 1, failed: 2, done: 3, idle: 4 };

/** Within a chip: the display statuses that need the person most come first. */
const DISPLAY_RANK: Record<DisplayStatus, number> = {
  permission_required: 0,
  failed: 1,
  waiting_for_you: 2,
  working: 3,
  testing: 3,
  reviewing: 3,
  recovering: 4,
  starting: 5,
  waiting: 5,
  done: 6,
  paused: 7,
  idle: 8,
  offline: 9,
};

function time(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

export function compareThreads(a: ThreadSummary, b: ThreadSummary): number {
  const da = displayStatusOf(a.status);
  const db = displayStatusOf(b.status);
  return (
    GROUP_RANK[fleetGroupOf(a.status)] - GROUP_RANK[fleetGroupOf(b.status)] ||
    DISPLAY_RANK[da.status] - DISPLAY_RANK[db.status] ||
    time(b.lastActivityAt) - time(a.lastActivityAt) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

export interface ThreadGroup {
  key: string;
  label: string;
  mode: GroupMode;
  /** Status groups: the Fleet group. */
  status?: FleetGroupId;
  /** Provider groups: the provider id (for its mark). */
  providerId?: string;
  threads: ThreadSummary[];
  /** How many in this group need the person. */
  needsYou: number;
  working: number;
}

function makeGroup(key: string, label: string, mode: GroupMode, threads: ThreadSummary[]): ThreadGroup {
  let needsYou = 0;
  let working = 0;
  for (const t of threads) {
    const group = fleetGroupOf(t.status);
    if (group === "needs_you") needsYou += 1;
    if (group === "working") working += 1;
  }
  return { key, label, mode, threads: [...threads].sort(compareThreads), needsYou, working };
}

/**
 * Groups already-filtered threads. Status groups follow urgency; project and provider groups put
 * the ones that need the person first, then the busiest, then by name.
 */
export function groupThreads(threads: readonly ThreadSummary[], mode: GroupMode): ThreadGroup[] {
  if (mode === "status") {
    const buckets = new Map<FleetGroupId, ThreadSummary[]>();
    for (const t of threads) {
      const group = fleetGroupOf(t.status);
      const list = buckets.get(group) ?? [];
      list.push(t);
      buckets.set(group, list);
    }
    return FLEET_GROUPS.filter((group) => buckets.has(group)).map((group) => ({
      ...makeGroup(group, FLEET_FILTER_LABELS[group], mode, buckets.get(group) ?? []),
      status: group,
    }));
  }
  const buckets = new Map<string, { label: string; providerId?: string; threads: ThreadSummary[] }>();
  for (const t of threads) {
    const key = mode === "project" ? t.workspaceId : t.providerId;
    const entry = buckets.get(key) ?? {
      label: mode === "project" ? t.workspaceName : t.providerName,
      ...(mode === "provider" ? { providerId: t.providerId } : {}),
      threads: [],
    };
    entry.threads.push(t);
    buckets.set(key, entry);
  }
  return [...buckets.entries()]
    .map(([key, entry]) => ({
      ...makeGroup(key, entry.label, mode, entry.threads),
      ...(entry.providerId ? { providerId: entry.providerId } : {}),
    }))
    .sort((a, b) => b.needsYou - a.needsYou || b.working - a.working || a.label.localeCompare(b.label));
}

/**
 * Events per bucket over the last `minutes`, oldest first — the Dashboard's activity trend. Real
 * data only: the event log the Activity feed shows. Returns null when nothing happened in the
 * window (no trend line is drawn from nothing).
 */
export function activityBuckets(
  events: readonly Pick<EventEnvelope, "occurredAt">[],
  now: number,
  minutes = 60,
  buckets = 12,
): number[] | null {
  const span = minutes * 60_000;
  const size = span / buckets;
  const counts = new Array<number>(buckets).fill(0);
  let any = false;
  for (const event of events) {
    const age = now - time(event.occurredAt);
    if (age < 0 || age >= span) continue;
    const index = buckets - 1 - Math.floor(age / size);
    counts[index] = (counts[index] ?? 0) + 1;
    any = true;
  }
  return any ? counts : null;
}
