/**
 * Overlapping edits: two coding agents in the same project touching the same files in their own
 * worktrees. Found from each worktree's observed changed files (committed since its branch forked,
 * plus uncommitted and untracked), so the person sees the clash while the agents still work,
 * not at merge time. Only the agents involved are affected; nothing else is held back.
 * Nothing is inferred: a worktree whose files couldn't be read takes no part, and a truncated
 * list is reported as such ("at least N files").
 */
import type { ThreadSummary, ThreadWorktreeState } from "@kalcode/protocol";

export interface Overlap {
  /** The two agents, in the order the threads were listed. */
  agentIds: [string, string];
  workspaceId: string;
  /** Files both changed, sorted. */
  files: string[];
  /** One side listed only some of its files: more may overlap. */
  incomplete: boolean;
}

/** One agent's view of an overlap: the other agent and the shared files. */
export interface AgentOverlap {
  other: ThreadSummary;
  files: readonly string[];
  incomplete: boolean;
}

/** Every pair of open agents in the same workspace whose changed files intersect. */
export function agentOverlaps(
  threads: readonly ThreadSummary[],
  states: ReadonlyMap<string, ThreadWorktreeState>,
): Overlap[] {
  const candidates = threads.flatMap((thread) => {
    if (thread.archivedAt !== null || !thread.worktreeId) return [];
    const state = states.get(thread.id);
    if (!state || state.changedPaths.length === 0) return [];
    return [{ thread, state, files: new Set(state.changedPaths) }];
  });
  const overlaps: Overlap[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const a = candidates[i];
    if (!a) continue;
    for (let j = i + 1; j < candidates.length; j += 1) {
      const b = candidates[j];
      if (!b || b.thread.workspaceId !== a.thread.workspaceId) continue;
      // Two agents in one worktree (never by KalCode's own launch) share every file by design.
      if (b.state.worktreeId === a.state.worktreeId) continue;
      const [small, large] = a.files.size <= b.files.size ? [a.files, b.files] : [b.files, a.files];
      const files = [...small].filter((file) => large.has(file)).sort();
      if (files.length === 0) continue;
      overlaps.push({
        agentIds: [a.thread.id, b.thread.id],
        workspaceId: a.thread.workspaceId,
        files,
        incomplete: a.state.changedPathsTruncated || b.state.changedPathsTruncated,
      });
    }
  }
  return overlaps;
}

/** The overlaps each agent is part of, keyed by agent id, largest overlap first. */
export function overlapsByAgent(
  overlaps: readonly Overlap[],
  threads: readonly ThreadSummary[],
): Map<string, AgentOverlap[]> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const result = new Map<string, AgentOverlap[]>();
  for (const overlap of overlaps) {
    const [a, b] = overlap.agentIds;
    for (const [self, otherId] of [
      [a, b],
      [b, a],
    ] as const) {
      const other = byId.get(otherId);
      if (!other) continue;
      const list = result.get(self) ?? [];
      list.push({ other, files: overlap.files, incomplete: overlap.incomplete });
      result.set(self, list);
    }
  }
  for (const list of result.values()) list.sort((x, y) => y.files.length - x.files.length);
  return result;
}

/** "2 files" / "at least 2 files" (a side's list was truncated). */
export function overlapCount(overlap: Pick<AgentOverlap, "files" | "incomplete">): string {
  const n = overlap.files.length;
  return `${overlap.incomplete ? "at least " : ""}${n} ${n === 1 ? "file" : "files"}`;
}
