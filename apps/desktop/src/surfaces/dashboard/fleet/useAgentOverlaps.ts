import { useMemo } from "react";
import type { AgentOverlap, OwnershipOverlap } from "../../../runtime/ownership/model.ts";
import { useAgentWorktreeStates, useOwnership } from "../data/DashboardData.tsx";

export interface AgentOverlaps {
  /** Every overlapping pair, most expensive first (for an inbox: one item per pair). */
  overlaps: readonly OwnershipOverlap[];
  /** Each agent's overlaps (for its card and pane). */
  byAgent: ReadonlyMap<string, readonly AgentOverlap[]>;
  ready: boolean;
  failed: boolean;
  incomplete: boolean;
}

/**
 * Agents whose work collides in one project, from the shared Agent File Ownership projection
 * (`runtime/ownership`). Must render inside a Dashboard data boundary (the Shell mounts one).
 */
export function useAgentOverlaps(): AgentOverlaps {
  const ownership = useOwnership();
  const read = useAgentWorktreeStates();
  return useMemo(
    () => ({
      overlaps: ownership.overlaps,
      byAgent: ownership.byAgent,
      ready: read.ready,
      failed: read.failed,
      incomplete: read.incomplete,
    }),
    [ownership, read.ready, read.failed, read.incomplete],
  );
}
