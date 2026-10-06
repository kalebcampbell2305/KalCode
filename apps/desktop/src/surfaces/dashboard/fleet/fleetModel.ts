/**
 * Agent Fleet read model: who each agent is, what stage it is at, and whether its
 * worktree is ready to merge — from the thread's runtime state plus its worktree's Git facts.
 * Nothing is inferred beyond those facts: "ready to merge" needs every condition observed.
 */
import {
  agentStateOf,
  displayStatusOf,
  isAgentBusy,
  type ThreadSummary,
  type ThreadWorktreeState,
} from "@kalcode/protocol";
import { isLive, needsAttention } from "../data/status.ts";

// ---- Merge readiness ----

export type MergeReadiness = { ready: true; ahead: number; base: string | null } | { ready: false; reason: string };

/**
 * Ready to merge only when every fact is observed: the agent has stopped working and isn't
 * waiting on anyone, it didn't fail, its worktree is clean, its branch has commits the base
 * doesn't, and Git reports the merge would apply without conflicts.
 */
export function mergeReadiness(thread: ThreadSummary, worktree: ThreadWorktreeState | undefined): MergeReadiness {
  if (!thread.worktreeId) return { ready: false, reason: "Runs in the workspace folder, not its own worktree" };
  if (!worktree) return { ready: false, reason: "Checking the worktree…" };
  // The shared agent state, so a card never says "Ready to merge" for an agent every other
  // surface shows as needing the person (a pending approval) or FAILED (idle after a failed turn).
  const state = agentStateOf(thread);
  if (isAgentBusy(state)) return { ready: false, reason: "Still working" };
  if (state === "failed") return { ready: false, reason: "The run failed" };
  if (state === "needs_you") return { ready: false, reason: "Waiting for you" };
  if (state === "waiting") return { ready: false, reason: "Blocked" };
  const dirty = worktree.changed + worktree.untracked;
  if (dirty > 0) return { ready: false, reason: `${dirty} uncommitted ${dirty === 1 ? "change" : "changes"}` };
  if (worktree.ahead === null) return { ready: false, reason: "No base branch to compare with" };
  if (worktree.ahead === 0) return { ready: false, reason: "No commits yet" };
  if (worktree.conflicts === null) return { ready: false, reason: "Merge conflicts couldn't be checked" };
  if (worktree.conflicts) return { ready: false, reason: `Would conflict with ${worktree.baseBranch ?? "the base"}` };
  return { ready: true, ahead: worktree.ahead, base: worktree.baseBranch };
}

// ---- Stage ----

/** The single word a fleet card leads with. */
export type FleetStage =
  | "needs_you"
  | "working"
  | "testing"
  | "reviewing"
  | "ready_to_merge"
  | "blocked"
  | "failed"
  | "done"
  | "idle"
  | "starting";

export const STAGE_LABELS: Record<FleetStage, string> = {
  needs_you: "Needs you",
  working: "Working",
  testing: "Testing",
  reviewing: "Reviewing",
  ready_to_merge: "Ready to merge",
  blocked: "Blocked",
  failed: "Failed",
  done: "Done",
  idle: "Idle",
  starting: "Starting",
};

export function fleetStage(thread: ThreadSummary, readiness: MergeReadiness): FleetStage {
  if (readiness.ready) return "ready_to_merge";
  if (thread.status === "failed") return "failed";
  if (needsAttention(thread.status)) return "needs_you";
  if (thread.status === "testing") return "testing";
  if (thread.status === "reviewing") return "reviewing";
  if (thread.status === "starting") return "starting";
  if (isLive(thread.status)) return "working";
  if (thread.status === "waiting_for_dependency") return "blocked";
  if (displayStatusOf(thread.status).status === "done") return "done";
  return "idle";
}

// ---- Summary ----

/** "6 agents · 3 working · 1 ready to merge · 2 need you": real counts, zeros left out. */
export function fleetSummary(stages: readonly FleetStage[]): string {
  const count = (...s: FleetStage[]) => stages.filter((x) => s.includes(x)).length;
  const working = count("working", "testing", "reviewing", "starting");
  const ready = count("ready_to_merge");
  const needs = count("needs_you");
  const failed = count("failed");
  const parts = [
    `${stages.length} ${stages.length === 1 ? "agent" : "agents"}`,
    working ? `${working} working` : null,
    ready ? `${ready} ready to merge` : null,
    needs ? `${needs} ${needs === 1 ? "needs" : "need"} you` : null,
    failed ? `${failed} failed` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}
