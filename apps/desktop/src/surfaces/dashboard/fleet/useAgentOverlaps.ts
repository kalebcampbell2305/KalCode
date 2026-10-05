import type { ThreadSummary, ThreadWorktreeState } from "@kalcode/protocol";
import { useMemo } from "react";
import { useCodingAgents } from "../data/DashboardData.tsx";
import { type AgentOverlap, agentOverlaps, type Overlap, overlapsByAgent } from "./overlap.ts";
import { useWorktreeStates } from "./useWorktreeStates.ts";

export interface AgentOverlaps {
  /** Every overlapping pair (for an inbox: one item per pair). */
  overlaps: Overlap[];
  /** Each agent's overlaps (for its card). */
  byAgent: Map<string, AgentOverlap[]>;
}

/**
 * Agents editing the same files in one project. With `source`, it uses worktree facts the caller
 * already reads (the Fleet board); without, it reads the coding agents and their worktree facts
 * itself (inside a Dashboard data boundary), on the same cadence as the Fleet.
 */
export function useAgentOverlaps(source?: {
  threads: readonly ThreadSummary[];
  states: ReadonlyMap<string, ThreadWorktreeState>;
}): AgentOverlaps {
  const { state } = useCodingAgents();
  const own = source ? null : state.status === "ready" ? state.data : null;
  // Never a second Git read when the caller already has the facts.
  const read = useWorktreeStates(own);
  const threads = source?.threads ?? own ?? NONE;
  const states = source?.states ?? read.states;
  return useMemo(() => {
    const overlaps = agentOverlaps(threads, states);
    return { overlaps, byAgent: overlapsByAgent(overlaps, threads) };
  }, [threads, states]);
}

const NONE: ThreadSummary[] = [];
