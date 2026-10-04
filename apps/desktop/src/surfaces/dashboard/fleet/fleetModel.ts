/**
 * Agent Fleet read model: who each agent is ("Claude A"), what stage it is at, and whether its
 * worktree is ready to merge — from the thread's runtime state plus its worktree's Git facts.
 * Nothing is inferred beyond those facts: "ready to merge" needs every condition observed.
 */
import { displayStatusOf, type ThreadSummary, type ThreadWorktreeState } from "@kalcode/protocol";
import { isLive, needsAttention } from "../data/status.ts";

// ---- Handles ----

const SHORT_PROVIDER: Record<string, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  cursor: "Cursor",
  "gemini-cli": "Gemini",
};

function letters(index: number): string {
  // A, B, … Z, AA, AB, …
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * A short, stable call sign per agent: the provider's short name plus a letter in the order the
 * provider's agents were started ("Claude A", "Claude B", "Codex A"). Order is by creation time,
 * then id; callers pass archived agents too, so archiving one never shifts another's letter.
 */
export function fleetHandles(threads: readonly ThreadSummary[]): Map<string, string> {
  const byProvider = new Map<string, ThreadSummary[]>();
  for (const thread of threads) {
    const list = byProvider.get(thread.providerId) ?? [];
    list.push(thread);
    byProvider.set(thread.providerId, list);
  }
  const handles = new Map<string, string>();
  for (const [providerId, list] of byProvider) {
    const short = SHORT_PROVIDER[providerId] ?? list[0]?.providerName ?? providerId;
    const ordered = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    for (const [index, thread] of ordered.entries()) handles.set(thread.id, `${short} ${letters(index)}`);
  }
  return handles;
}

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
  if (isLive(thread.status)) return { ready: false, reason: "Still working" };
  if (needsAttention(thread.status)) {
    return { ready: false, reason: thread.status === "failed" ? "The run failed" : "Waiting for you" };
  }
  if (thread.status === "waiting_for_dependency") return { ready: false, reason: "Blocked" };
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
