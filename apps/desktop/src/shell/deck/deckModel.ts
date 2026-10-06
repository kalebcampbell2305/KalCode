/**
 * The Command Deck's read model: pure projections of real runtime state (threads and Operations
 * environments) into what the deck answers — what is working, what needs me, where it is shipped. Nothing here invents state: an empty input
 * produces an honest "none" rather than a placeholder.
 */
import {
  agentStateOf,
  isAgentBusy,
  type OperationEnvironment,
  type StatusTone,
  type ThreadSummary,
} from "@kalcode/protocol";

// ---- Agents (right rail) ----

/** The rail's sections, from the shared agent-state model: the same for every provider. */
export interface AgentSections {
  /** Can't continue until the person answers (an approval or a reply). */
  needsYou: ThreadSummary[];
  /** Failed sessions or turns, newest first: a decision (retry or clear), not a question. */
  failed: ThreadSummary[];
  /** Starting, working or testing now. */
  working: ThreadSummary[];
  /** Waiting on something other than the person. */
  blocked: ThreadSummary[];
  /** Open and at rest: ready for a task, idle, paused or offline. */
  idle: ThreadSummary[];
  /** Done or stopped within the recent window, newest first. */
  finished: ThreadSummary[];
}

/** How long a finished agent stays in the rail's "Just finished" list. */
export const RECENT_FINISH_MS = 60 * 60_000;
export const RECENT_FINISH_LIMIT = 3;

function at(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
}

const newestFirst = (a: ThreadSummary, b: ThreadSummary) =>
  at(b.lastActivityAt) - at(a.lastActivityAt) || a.name.localeCompare(b.name);

export function agentSections(threads: readonly ThreadSummary[], now: number): AgentSections {
  const sections: AgentSections = { needsYou: [], failed: [], working: [], blocked: [], idle: [], finished: [] };
  const finished: ThreadSummary[] = [];
  // Most recent activity first within each section.
  const open = threads.filter((t) => t.archivedAt === null).sort(newestFirst);
  for (const thread of open) {
    const state = agentStateOf(thread);
    if (state === "needs_you") sections.needsYou.push(thread);
    else if (state === "failed") sections.failed.push(thread);
    else if (isAgentBusy(state)) sections.working.push(thread);
    else if (state === "waiting") sections.blocked.push(thread);
    else if (state === "ready" || state === "idle") sections.idle.push(thread);
    else finished.push(thread);
  }
  sections.finished = finished
    .slice(0, RECENT_FINISH_LIMIT)
    .filter((t) => now - at(t.lastActivityAt) <= RECENT_FINISH_MS);
  return sections;
}

/** Agents that are running in the deck's sense: working, needing the person, or blocked. */
export function runningAgentCount(sections: AgentSections): number {
  return sections.needsYou.length + sections.working.length + sections.blocked.length;
}

/**
 * Whether the rail opens on its own (until the person pins or collapses it): an agent is doing
 * work or needs the person. An agent that is only starting doesn't count: a launch passes through
 * "Starting" for about a second before the agent rests at "Ready", and opening for that blip
 * squeezed Code, then left an empty full-width rail while it folded back.
 */
export function railWantsOpen(sections: AgentSections): boolean {
  return (
    sections.needsYou.length > 0 ||
    sections.blocked.length > 0 ||
    sections.working.some((thread) => agentStateOf(thread) !== "starting")
  );
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
