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

/** Case-insensitive match on what a card shows: name, workspace, branch, provider, model, activity. */
export function matchesQuery(thread: ThreadSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const fields = [
    thread.name,
    thread.workspaceName,
    thread.branch,
    thread.providerName,
    thread.model,
    thread.currentActivity,
  ];
  return q
    .split(/\s+/)
    .every((word) => fields.some((field) => typeof field === "string" && field.toLowerCase().includes(word)));
}

export function filterThreads(threads: readonly ThreadSummary[], chip: DashboardChip, query: string): ThreadSummary[] {
  return threads.filter((t) => (chip === "all" || chipOf(t.status) === chip) && matchesQuery(t, query));
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

/** Urgency within the board: needs you, working, done, idle. */
const CHIP_RANK: Record<DashboardChip, number> = { waiting_for_you: 0, working: 1, done: 2, idle: 3, all: 4 };

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
    CHIP_RANK[da.chip] - CHIP_RANK[db.chip] ||
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
  /** Status groups: the chip. */
  chip?: Exclude<DashboardChip, "all">;
  /** Provider groups: the provider id (for its mark). */
  providerId?: string;
  threads: ThreadSummary[];
  /** How many in this group need the person. */
  needsYou: number;
  working: number;
}

const STATUS_GROUP_LABELS: Record<Exclude<DashboardChip, "all">, string> = {
  waiting_for_you: "Needs you",
  working: "Working",
  done: "Done",
  idle: "Idle",
};

function makeGroup(key: string, label: string, mode: GroupMode, threads: ThreadSummary[]): ThreadGroup {
  let needsYou = 0;
  let working = 0;
  for (const t of threads) {
    const chip = chipOf(t.status);
    if (chip === "waiting_for_you") needsYou += 1;
    if (chip === "working") working += 1;
  }
  return { key, label, mode, threads: [...threads].sort(compareThreads), needsYou, working };
}

/**
 * Groups already-filtered threads. Status groups follow urgency; project and provider groups put
 * the ones that need the person first, then the busiest, then by name.
 */
export function groupThreads(threads: readonly ThreadSummary[], mode: GroupMode): ThreadGroup[] {
  if (mode === "status") {
    const buckets = new Map<Exclude<DashboardChip, "all">, ThreadSummary[]>();
    for (const t of threads) {
      const chip = chipOf(t.status) as Exclude<DashboardChip, "all">;
      const list = buckets.get(chip) ?? [];
      list.push(t);
      buckets.set(chip, list);
    }
    return (["waiting_for_you", "working", "done", "idle"] as const)
      .filter((chip) => buckets.has(chip))
      .map((chip) => ({ ...makeGroup(chip, STATUS_GROUP_LABELS[chip], mode, buckets.get(chip) ?? []), chip }));
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
