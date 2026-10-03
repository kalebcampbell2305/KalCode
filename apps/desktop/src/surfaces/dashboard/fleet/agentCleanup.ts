/**
 * Agent Fleet cleanup: remove failed or finished agents, close idle ones, or close every agent.
 *
 * SEAM (kalcode-d5): the canonical removal API is landing on the KalTidy context as
 * `dismissAgent(agentId)`, `clearFailed()`, `clearFinished()` and `closeAll()`. Until it is on
 * main, this one file implements those names over the existing thread commands, so switching the
 * Fleet to KalTidy's versions is a one-line change in `useAgentCleanup`.
 *
 * Semantics come from the native commands, not invented here:
 * - `thread_archive` removes an agent from the Fleet (restorable from Archived). Native accepts it
 *   for an agent that isn't running; an idle session (idle, or waiting for a reply) ends with it.
 * - `thread_stop` ends a turn, a start or a wait (what closing an agent's pane in Code does), after
 *   which the agent can be archived.
 */
import type { ThreadStatus, ThreadSummary } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { useCallback, useMemo } from "react";
import { type FleetGroupId, fleetGroupOf } from "../data/board.ts";
import { type BulkResult, type BulkStep, useArchivedCodingAgents, useCodingAgents } from "../data/DashboardData.tsx";

export type CleanupKind = "failed" | "finished" | "idle" | "all";

/** Statuses `thread_archive` accepts as they are (nothing is running). */
const ARCHIVABLE: ReadonlySet<ThreadStatus> = new Set([
  "completed",
  "failed",
  "interrupted",
  "idle",
  "waiting_for_user",
  "offline",
]);

/** Statuses `thread_stop` ends (a turn, a start, a wait, a pause). */
const STOPPABLE: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "active",
  "thinking",
  "running_tool",
  "running_command",
  "editing",
  "testing",
  "reviewing",
  "recovering",
  "waiting_for_permission",
  "waiting_for_dependency",
  "paused",
]);

/** Idle agents "Close idle" closes: quiet ones. Paused or blocked agents keep their turn. */
const QUIET_IDLE: ReadonlySet<ThreadStatus> = new Set(["idle", "interrupted", "offline"]);

/** The card's one-click remove (X): failed, finished, stopped or offline agents only. */
export function canDismiss(status: ThreadStatus): boolean {
  return status === "failed" || status === "completed" || status === "interrupted" || status === "offline";
}

function inGroup(group: FleetGroupId) {
  return (thread: ThreadSummary) => fleetGroupOf(thread.status) === group;
}

/** Exactly which agents a cleanup touches, and the commands each needs. */
export function cleanupSteps(threads: readonly ThreadSummary[], kind: CleanupKind): BulkStep[] {
  switch (kind) {
    case "failed":
      return threads.filter(inGroup("failed")).map((thread) => ({ thread, commands: ["archive"] }));
    case "finished":
      return threads.filter(inGroup("done")).map((thread) => ({ thread, commands: ["archive"] }));
    case "idle":
      return threads
        .filter((t) => inGroup("idle")(t) && QUIET_IDLE.has(t.status))
        .map((thread) => ({ thread, commands: ["archive"] }));
    case "all":
      return threads.flatMap<BulkStep>((thread) =>
        ARCHIVABLE.has(thread.status)
          ? [{ thread, commands: ["archive"] }]
          : STOPPABLE.has(thread.status)
            ? [{ thread, commands: ["stop", "archive"] }]
            : [],
      );
  }
}

export type CleanupCounts = Record<CleanupKind, number>;

export function cleanupCounts(threads: readonly ThreadSummary[]): CleanupCounts {
  return {
    failed: cleanupSteps(threads, "failed").length,
    finished: cleanupSteps(threads, "finished").length,
    idle: cleanupSteps(threads, "idle").length,
    all: cleanupSteps(threads, "all").length,
  };
}

const agents = (n: number) => (n === 1 ? "1 agent" : `${n} agents`);

/** One sentence for the toast (and the screen-reader announcement). */
export function cleanupSummary(kind: CleanupKind | "dismiss", result: Pick<BulkResult, "failed"> & { done: number }) {
  const verb = kind === "idle" || kind === "all" ? "Closed" : "Cleared";
  const what =
    kind === "failed"
      ? `${result.done} failed ${result.done === 1 ? "agent" : "agents"}`
      : kind === "finished"
        ? `${result.done} finished ${result.done === 1 ? "agent" : "agents"}`
        : kind === "idle"
          ? `${result.done} idle ${result.done === 1 ? "agent" : "agents"}`
          : agents(result.done);
  const head = result.done > 0 ? `${verb} ${what}.` : "Nothing was closed.";
  return result.failed > 0 ? `${head} ${agents(result.failed)} couldn't be closed.` : head;
}

export interface AgentCleanup {
  counts: CleanupCounts;
  dismissAgent: (agentId: string) => Promise<void>;
  clearFailed: () => Promise<void>;
  clearFinished: () => Promise<void>;
  closeIdle: () => Promise<void>;
  closeAll: () => Promise<void>;
}

/**
 * The Fleet's cleanup actions over the open coding agents. Each reports one outcome toast with
 * Undo (restores what it archived; an agent that was stopped stays stopped).
 */
export function useAgentCleanup(): AgentCleanup {
  const { state, runBulk } = useCodingAgents();
  const archived = useArchivedCodingAgents();
  const toast = useToast();
  const threads = state.status === "ready" ? state.data : NO_THREADS;
  const counts = useMemo(() => cleanupCounts(threads), [threads]);

  const run = useCallback(
    async (kind: CleanupKind | "dismiss", steps: BulkStep[]) => {
      if (steps.length === 0) return;
      const result = await runBulk(steps);
      const restorable = result.done.filter((t) => t.archivedAt !== null);
      toast.show({
        tone: result.failed > 0 ? "danger" : "success",
        title:
          kind === "dismiss" && result.failed === 0
            ? `Cleared ${steps[0]?.thread.name ?? "agent"}.`
            : cleanupSummary(kind, { done: result.done.length, failed: result.failed }),
        description: restorable.length > 0 ? "Restore them any time from Archived." : undefined,
        action:
          restorable.length > 0
            ? {
                label: "Undo",
                onSelect: () => {
                  void archived.runBulk(restorable.map((thread) => ({ thread, commands: ["unarchive"] })));
                },
              }
            : undefined,
      });
    },
    [runBulk, archived.runBulk, toast],
  );

  return useMemo(
    () => ({
      counts,
      dismissAgent: async (agentId: string) => {
        const thread = threads.find((t) => t.id === agentId);
        if (thread && canDismiss(thread.status)) await run("dismiss", [{ thread, commands: ["archive"] }]);
      },
      clearFailed: () => run("failed", cleanupSteps(threads, "failed")),
      clearFinished: () => run("finished", cleanupSteps(threads, "finished")),
      closeIdle: () => run("idle", cleanupSteps(threads, "idle")),
      closeAll: () => run("all", cleanupSteps(threads, "all")),
    }),
    [counts, threads, run],
  );
}

const NO_THREADS: readonly ThreadSummary[] = [];
