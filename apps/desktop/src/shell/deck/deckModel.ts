/**
 * The Command Deck's read model: pure projections of real runtime state (threads and Operations
 * environments) into what the deck answers — what is working, what needs me, where it is shipped. Nothing here invents state: an empty input
 * produces an honest "none" rather than a placeholder.
 */
import { displayStatusOf, type OperationEnvironment, type StatusTone, type ThreadSummary } from "@kalcode/protocol";
import { recentOutcomes, STATUS_META, sortOpenThreads } from "../../surfaces/dashboard/data/status.ts";

// ---- Agents (right rail) ----

export interface AgentSections {
  /** Can't continue until the person acts (approval, reply, a failure to look at). */
  needsYou: ThreadSummary[];
  /** A provider process is doing work now. */
  working: ThreadSummary[];
  /** Waiting on something other than the person. */
  blocked: ThreadSummary[];
  /** Open but not doing anything. */
  idle: ThreadSummary[];
  /** Completed or stopped within the recent window, newest first. */
  finished: ThreadSummary[];
}

/** How long a finished agent stays in the rail's "Just finished" list. */
export const RECENT_FINISH_MS = 60 * 60_000;
export const RECENT_FINISH_LIMIT = 3;

function at(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** The Fleet's "Waiting for you" chip (approval, reply or failed), so every surface counts alike. */
function waitsForYou(thread: ThreadSummary): boolean {
  return displayStatusOf(thread.status).chip === "waiting_for_you";
}

export function agentSections(threads: readonly ThreadSummary[], now: number): AgentSections {
  const open = threads.filter((t) => t.archivedAt === null);
  const sections: AgentSections = {
    // Failed agents stay here until someone acts, however long ago they failed.
    needsYou: open
      .filter(waitsForYou)
      .sort((a, b) => at(b.lastActivityAt) - at(a.lastActivityAt) || a.name.localeCompare(b.name)),
    working: [],
    blocked: [],
    idle: [],
    finished: recentOutcomes(
      open.filter((t) => !waitsForYou(t)),
      RECENT_FINISH_LIMIT,
    ).filter((t) => now - at(t.lastActivityAt) <= RECENT_FINISH_MS),
  };
  // Dashboard order within each group: most recent activity first.
  for (const thread of sortOpenThreads(open)) {
    if (waitsForYou(thread)) continue;
    const group = STATUS_META[thread.status].group;
    if (group === "working") sections.working.push(thread);
    else if (group === "waiting") sections.blocked.push(thread);
    else if (group === "idle") sections.idle.push(thread);
  }
  return sections;
}

/**
 * Agents that are running in the deck's sense: working, needing the person, or blocked. A failed
 * agent needs the person too, but it has stopped, so it isn't counted as running.
 */
export function runningAgentCount(sections: AgentSections): number {
  const waiting = sections.needsYou.filter((thread) => thread.status !== "failed").length;
  return waiting + sections.working.length + sections.blocked.length;
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

/**
 * Where the "N need you" chip leads. Approvals only when every need is an
 * approval; replies and failures live on the agents, so show those instead.
 */
export function needsChipTarget(needs: number, pendingApprovals: number): "approvals" | "agents" | "dashboard" {
  if (needs === 0) return "dashboard";
  return pendingApprovals > 0 && needs <= pendingApprovals ? "approvals" : "agents";
}

// ---- Environments (top bar) ----

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

/** "just now", "4m ago", "2h ago", "3d ago": compact relative time. */
export function ago(iso: string | null, now: number): string {
  const t = at(iso);
  if (t === 0) return "";
  const short = shortElapsed(Math.max(0, now - t));
  return short === "now" ? "just now" : `${short} ago`;
}
