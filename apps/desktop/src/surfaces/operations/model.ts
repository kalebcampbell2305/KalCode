import {
  type EntitlementTier,
  limitsFor,
  type OperationActivity,
  type OperationRecord,
  type OperationStatus,
  type OperationsSnapshot,
} from "@kalcode/protocol";

export type OperationsTab = "runs" | "queue" | "squads" | "services" | "environments" | "activity";
export type ActivityRange = "1h" | "today" | "7d" | "release";

export const FINISHED_STATUSES = new Set<OperationStatus>(["succeeded", "failed", "cancelled", "interrupted"]);
export const QUEUED_STATUSES = new Set<OperationStatus>(["queued", "paused", "blocked"]);
export const ACTIVE_STATUSES = new Set<OperationStatus>(["starting", "running"]);

export function isActiveRun(item: OperationRecord): boolean {
  return (
    item.endedAt === null &&
    (ACTIVE_STATUSES.has(item.status) || (item.startedAt !== null && QUEUED_STATUSES.has(item.status)))
  );
}

export function durationLabel(startedAt: string | null, endedAt: string | null, now = Date.now()): string {
  if (!startedAt) return "Not started";
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "Unknown";
  const seconds = Math.floor((end - start) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function operationDurationLabel(record: OperationRecord, now = Date.now()): string {
  return record.status === "unknown" ? "Unavailable" : durationLabel(record.startedAt, record.endedAt, now);
}

export function timeLabel(value: string | null): string {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function operationStatusLabel(status: OperationStatus): string {
  return status.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

export function filteredSnapshot(snapshot: OperationsSnapshot, workspaceId: string): OperationsSnapshot {
  if (!workspaceId) return snapshot;
  const runIds = new Set(snapshot.items.filter((item) => item.spec.workspaceId === workspaceId).map((item) => item.id));
  return {
    ...snapshot,
    items: snapshot.items.filter((item) => item.spec.workspaceId === workspaceId),
    services: snapshot.services.filter((service) => service.workspaceId === workspaceId),
    environments: snapshot.environments.filter((environment) => environment.workspaceId === workspaceId),
    activity: snapshot.activity.filter(
      (event) => event.workspaceId === workspaceId || (event.runId !== null && runIds.has(event.runId)),
    ),
  };
}

export function orderedQueue(items: readonly OperationRecord[]): OperationRecord[] {
  return items
    .filter((item) => QUEUED_STATUSES.has(item.status) && !isActiveRun(item))
    .toSorted((left, right) => left.position - right.position || right.spec.priority - left.spec.priority);
}

export function queueSections(items: readonly OperationRecord[]): {
  now: OperationRecord[];
  next: OperationRecord[];
  later: OperationRecord[];
} {
  const ordered = orderedQueue(items);
  return {
    now: items.filter(isActiveRun).toSorted((a, b) => a.position - b.position),
    next: ordered.filter((item) => item.spec.lane === "next"),
    later: ordered.filter((item) => item.spec.lane === "later"),
  };
}

export function moveQueueItem(ids: readonly string[], id: string, direction: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[target]] = [next[target] as string, next[index] as string];
  return next;
}

export interface ActivityBin {
  key: string;
  label: string;
  start: number;
  end: number;
}

export interface ActivityRow {
  area: string;
  counts: number[];
  total: number;
}

export interface ActivityHeatmap {
  bins: ActivityBin[];
  rows: ActivityRow[];
  events: OperationActivity[];
  max: number;
  rangeNote: string | null;
}

function rangeStart(
  range: ActivityRange,
  events: readonly OperationActivity[],
  runs: readonly OperationRecord[],
  now: Date,
) {
  const end = now.getTime();
  if (range === "1h") return { start: end - 60 * 60_000, step: 5 * 60_000, note: null };
  if (range === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { start: start.getTime(), step: 60 * 60_000, note: null };
  }
  if (range === "7d") return { start: end - 7 * 24 * 60 * 60_000, step: 24 * 60 * 60_000, note: null };
  const release = runs
    .filter((run) => run.spec.kind === "release" && run.status === "succeeded" && run.endedAt)
    .toSorted((a, b) => Date.parse(b.endedAt ?? "") - Date.parse(a.endedAt ?? ""))[0];
  if (!release?.endedAt) {
    const earliestObserved = events.reduce(
      (value, event) => Math.min(value, Date.parse(event.at)),
      end - 7 * 24 * 60 * 60_000,
    );
    const earliest = Number.isFinite(earliestObserved) ? Math.max(earliestObserved, end - 7 * 24 * 60 * 60_000) : end;
    return {
      start: earliest,
      step: 24 * 60 * 60_000,
      note: "No completed release is recorded; showing available activity.",
    };
  }
  const start = Date.parse(release.endedAt);
  return { start, step: Math.max(60 * 60_000, Math.ceil((end - start) / 14)), note: `Since ${release.spec.name}.` };
}

export function buildActivityHeatmap(
  activity: readonly OperationActivity[],
  runs: readonly OperationRecord[],
  range: ActivityRange,
  now = new Date(),
): ActivityHeatmap {
  const end = now.getTime();
  const window = rangeStart(range, activity, runs, now);
  const boundedStep = Math.max(window.step, Math.ceil(Math.max(0, end - window.start) / 56));
  const count = Math.min(56, Math.max(1, Math.ceil((end - window.start) / boundedStep)));
  const bins: ActivityBin[] = Array.from({ length: count }, (_, index) => {
    const start = window.start + index * boundedStep;
    const binEnd = Math.min(end + 1, start + boundedStep);
    const date = new Date(start);
    const label =
      range === "1h"
        ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
        : range === "today"
          ? date.toLocaleTimeString([], { hour: "numeric" })
          : range === "7d"
            ? date.toLocaleDateString([], { weekday: "short" })
            : boundedStep >= 24 * 60 * 60_000
              ? date.toLocaleDateString([], { month: "short", day: "numeric" })
              : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" });
    return {
      key: `${start}`,
      label,
      start,
      end: binEnd,
    };
  });
  const events = activity.filter((event) => {
    const at = Date.parse(event.at);
    return Number.isFinite(at) && at >= window.start && at <= end;
  });
  const areas = [...new Set(events.map((event) => event.area.trim() || "Project"))].sort((a, b) => a.localeCompare(b));
  const rows = areas.map((area) => {
    const counts = bins.map(
      (bin) =>
        events.filter(
          (event) =>
            (event.area.trim() || "Project") === area &&
            Date.parse(event.at) >= bin.start &&
            Date.parse(event.at) < bin.end,
        ).length,
    );
    return { area, counts, total: counts.reduce((sum, value) => sum + value, 0) };
  });
  return { bins, rows, events, max: Math.max(0, ...rows.flatMap((row) => row.counts)), rangeNote: window.note };
}

export function activityLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

export function activityRun(events: readonly OperationActivity[], itemId: string): string | null {
  return events.find((event) => event.id === itemId)?.runId ?? null;
}

/** Apply plan history to sorted finished runs. Active work and the inspected run remain visible. */
export function planRunHistory(
  runs: readonly OperationRecord[],
  tier: EntitlementTier,
  observedAt: string,
  selected: string | null = null,
): OperationRecord[] {
  const limits = limitsFor(tier);
  const cutoff =
    limits.operationsHistoryDays === null ? null : Date.parse(observedAt) - limits.operationsHistoryDays * 86_400_000;
  let finished = 0;
  return runs.filter((run) => {
    if (run.endedAt === null || run.id === selected) return true;
    if (cutoff !== null && Date.parse(run.endedAt) < cutoff) return false;
    if (limits.runHistory !== null && finished >= limits.runHistory) return false;
    finished += 1;
    return true;
  });
}

/** Starter shows recent activity; paid history uses the same retention window as Runs. */
export function planActivityHistory(
  events: readonly OperationActivity[],
  tier: EntitlementTier,
  observedAt: string,
): OperationActivity[] {
  const limits = limitsFor(tier);
  const cutoff =
    limits.operationsHistoryDays === null ? null : Date.parse(observedAt) - limits.operationsHistoryDays * 86_400_000;
  const recent = events
    .filter((event) => cutoff === null || Date.parse(event.at) >= cutoff)
    .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return limits.runHistory === null ? recent : recent.slice(0, limits.runHistory);
}
