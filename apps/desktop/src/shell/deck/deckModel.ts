/**
 * The Command Deck's read model: pure projections of real runtime state (threads, Operations
 * runs and environments, provider health) into the three questions the deck always answers —
 * what is working, what needs me, what is shipping. Nothing here invents state: an empty input
 * produces an honest "none" rather than a placeholder.
 */
import type {
  OperationEnvironment,
  OperationKind,
  OperationRecord,
  ProviderHealth,
  StatusTone,
  ThreadSummary,
} from "@kalcode/protocol";
import { recentOutcomes, STATUS_META, sortOpenThreads } from "../../surfaces/dashboard/data/status.ts";

// ---- Agents (right rail) ----

export interface AgentSections {
  /** Can't continue until the person acts (approval, reply). */
  needsYou: ThreadSummary[];
  /** A provider process is doing work now. */
  working: ThreadSummary[];
  /** Waiting on something other than the person. */
  blocked: ThreadSummary[];
  /** Open but not doing anything. */
  idle: ThreadSummary[];
  /** Completed, failed or stopped within the recent window, newest first. */
  finished: ThreadSummary[];
}

/** How long a finished agent stays in the rail's "Just finished" list. */
export const RECENT_FINISH_MS = 60 * 60_000;
export const RECENT_FINISH_LIMIT = 3;

function at(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
}

export function agentSections(threads: readonly ThreadSummary[], now: number): AgentSections {
  const open = threads.filter((t) => t.archivedAt === null);
  const sections: AgentSections = {
    needsYou: [],
    working: [],
    blocked: [],
    idle: [],
    finished: recentOutcomes(open, RECENT_FINISH_LIMIT).filter((t) => now - at(t.lastActivityAt) <= RECENT_FINISH_MS),
  };
  // Dashboard order within each group: most recent activity first.
  for (const thread of sortOpenThreads(open)) {
    const group = STATUS_META[thread.status].group;
    if (group === "attention") sections.needsYou.push(thread);
    else if (group === "working") sections.working.push(thread);
    else if (group === "waiting") sections.blocked.push(thread);
    else if (group === "idle") sections.idle.push(thread);
  }
  return sections;
}

/** Agents that are running in the deck's sense: working, needing the person, or blocked. */
export function runningAgentCount(sections: AgentSections): number {
  return sections.needsYou.length + sections.working.length + sections.blocked.length;
}

/**
 * Everything waiting on the person: agents that need a reply or approval, plus pending approvals
 * that no such agent already accounts for (each counted once).
 */
export function needsYouCount(
  needsYou: readonly ThreadSummary[],
  approvals: readonly { action: { threadId?: string | null } }[],
): number {
  const threads = new Set(needsYou.map((t) => t.id));
  return threads.size + approvals.filter((a) => !a.action.threadId || !threads.has(a.action.threadId)).length;
}

// ---- Runs (status strip: builds, tests, shipping) ----

export type RunState = "running" | "queued" | "passed" | "failed" | "cancelled" | "none";

export interface RunSummary {
  state: RunState;
  /** Runs of these kinds in progress now. */
  running: number;
  /** Runs waiting in the queue (queued, paused or blocked). */
  queued: number;
  /** The run the summary describes: the newest running one, else the newest finished one. */
  latest: OperationRecord | null;
}

const ACTIVE = new Set(["starting", "running"]);
const WAITING = new Set(["queued", "paused", "blocked"]);

export const BUILD_KINDS: readonly OperationKind[] = ["build"];
export const TEST_KINDS: readonly OperationKind[] = ["test"];
export const SHIP_KINDS: readonly OperationKind[] = ["deploy", "release"];

export function runSummary(items: readonly OperationRecord[], kinds: readonly OperationKind[]): RunSummary {
  const mine = items.filter((item) => kinds.includes(item.spec.kind));
  const active = mine.filter((item) => ACTIVE.has(item.status));
  const queued = mine.filter((item) => WAITING.has(item.status)).length;
  if (active.length > 0) {
    const latest = [...active].sort((a, b) => at(b.startedAt) - at(a.startedAt))[0] ?? null;
    return { state: "running", running: active.length, queued, latest };
  }
  const finished = mine.filter((item) => item.endedAt !== null).sort((a, b) => at(b.endedAt) - at(a.endedAt));
  const latest = finished[0] ?? null;
  if (latest) {
    const state: RunState =
      latest.status === "succeeded"
        ? "passed"
        : latest.status === "failed" || latest.status === "interrupted"
          ? "failed"
          : "cancelled";
    return { state, running: 0, queued, latest };
  }
  return { state: queued > 0 ? "queued" : "none", running: 0, queued, latest: null };
}

export function runTone(state: RunState): StatusTone {
  switch (state) {
    case "running":
      return "recovering";
    case "passed":
      return "working";
    case "failed":
      return "failed";
    case "queued":
      return "paused";
    default:
      return "muted";
  }
}

// ---- Provider health (status strip) ----

export interface ProviderRollup {
  tone: StatusTone;
  /** Short words for the strip, e.g. "3 healthy" or "Codex degraded". */
  label: string;
  /** Installed providers considered. */
  installed: number;
  healthy: number;
}

const HEALTH_RANK = { unavailable: 3, degraded: 2, unknown: 1, healthy: 0 } as const;

/** Installed providers only: a CLI the person never installed isn't an outage. */
export function providerRollup(list: readonly ProviderHealth[] | null): ProviderRollup {
  if (list === null) return { tone: "muted", label: "Checking", installed: 0, healthy: 0 };
  const installed = list.filter((p) => p.detection !== "not_installed");
  if (installed.length === 0) return { tone: "muted", label: "None installed", installed: 0, healthy: 0 };
  const healthy = installed.filter((p) => p.state === "healthy").length;
  if (healthy === installed.length) {
    return { tone: "working", label: `${healthy} healthy`, installed: installed.length, healthy };
  }
  if (installed.every((p) => p.state === "unknown")) {
    return { tone: "muted", label: "Not checked yet", installed: installed.length, healthy: 0 };
  }
  const worst = [...installed].sort((a, b) => HEALTH_RANK[b.state] - HEALTH_RANK[a.state])[0];
  const sameState = installed.filter((p) => p.state === worst?.state);
  const word = worst?.state === "unknown" ? "unchecked" : (worst?.state ?? "unknown");
  const label = sameState.length === 1 ? `${worst?.displayName} ${word}` : `${sameState.length} ${word}`;
  const tone: StatusTone =
    worst?.state === "unavailable" ? "failed" : worst?.state === "degraded" ? "waiting" : "muted";
  return { tone, label, installed: installed.length, healthy };
}

// ---- Environments (top bar, status strip) ----

const ENV_RANK = { production: 3, staging: 2, preview: 1, local: 0 } as const;

export const ENVIRONMENT_LABELS: Record<OperationEnvironment["kind"], string> = {
  local: "Local",
  preview: "Preview",
  staging: "Staging",
  production: "Production",
};

/** The furthest-promoted environment Operations observed for a workspace, if any. */
export function primaryEnvironment(
  environments: readonly OperationEnvironment[],
  workspaceId: string | null,
): OperationEnvironment | null {
  const mine = environments.filter((e) => workspaceId === null || e.workspaceId === workspaceId);
  return [...mine].sort((a, b) => ENV_RANK[b.kind] - ENV_RANK[a.kind])[0] ?? null;
}

/** Health as reported: verified good, verified bad, or not verified. Never inferred. */
export function environmentTone(environment: OperationEnvironment): StatusTone {
  const health = environment.health.toLowerCase();
  const status = environment.deploymentStatus.toLowerCase();
  if (health === "healthy" || health === "live") return "working";
  if (health === "failed" || health === "unhealthy" || status === "failed") return "failed";
  if (status === "running") return "recovering";
  return "muted";
}

/** "Not probed" style machine words as sentence case. */
export function humanize(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : "Unknown";
}

// ---- Time ----

/** "now", "4m", "2h", "3d": the shortest honest elapsed time (minute granularity). */
export function shortElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "just now", "4m ago", "2h ago", "3d ago": compact relative time for the strip. */
export function ago(iso: string | null, now: number): string {
  const t = at(iso);
  if (t === 0) return "";
  const short = shortElapsed(Math.max(0, now - t));
  return short === "now" ? "just now" : `${short} ago`;
}
