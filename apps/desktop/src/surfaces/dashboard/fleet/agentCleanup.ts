/**
 * Agent Fleet cleanup: the card X, Clear failed, Clear finished, Close idle and Close all.
 *
 * KalTidy is the one cleanup tool (AGENTS.md agent cleanup rule). When the KalTidy context offers
 * its canonical agent removal (`dismissAgent`, `clearFailed`, `clearFinished`, `closeAll`; kalcode-d5,
 * PR #152) the Fleet calls exactly that. Until it is on main, this file carries the same names
 * over the same thread commands, so nothing about the Fleet changes when it lands.
 *
 * Semantics come from the native commands, not invented here:
 * - `thread_archive` removes an agent from the Fleet (restorable from Archived). Native accepts it
 *   for an agent that isn't running; an idle session (idle, or waiting for a reply) ends with it.
 * - `thread_stop` ends a turn, a start or a wait (what closing an agent's pane in Code does); an
 *   agent whose archive is refused because its session still runs is stopped first, then archived.
 */
import type { ThreadStatus, ThreadSummary } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { useCallback, useMemo } from "react";
import { useKalTidy } from "../../code/kaltidy/kalTidyContext.ts";
import { fleetGroupOf } from "../data/board.ts";
import { type BulkResult, type BulkStep, useArchivedCodingAgents, useCodingAgents } from "../data/DashboardData.tsx";

export type CleanupKind = "failed" | "finished" | "idle" | "all";

/** KalTidy's canonical agent removal (PR #152), when this build's KalTidy offers it. */
interface CanonicalCleanup {
  dismissAgent: (agentId: string) => Promise<boolean>;
  clearFailed: () => Promise<unknown>;
  clearFinished: () => Promise<unknown>;
  /** Opens KalTidy's single "Close all terminals and agents?" confirmation. */
  closeAll: () => void;
}

function canonicalOf(api: object | null): CanonicalCleanup | null {
  if (!api) return null;
  const candidate = api as Partial<CanonicalCleanup>;
  return typeof candidate.dismissAgent === "function" &&
    typeof candidate.clearFailed === "function" &&
    typeof candidate.clearFinished === "function" &&
    typeof candidate.closeAll === "function"
    ? (candidate as CanonicalCleanup)
    : null;
}

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

/** Finished, as KalTidy clears it: done, stopped or offline (the session is over). */
const FINISHED: ReadonlySet<ThreadStatus> = new Set(["completed", "interrupted", "offline"]);

/** The card's one-click remove (X): agents whose session is over (FAILED in the shared state too). */
export function canDismiss(thread: Pick<ThreadSummary, "status" | "currentActivity" | "pendingApprovals">): boolean {
  return fleetGroupOf(thread) === "failed" || FINISHED.has(thread.status);
}

/** Exactly which agents a cleanup touches, and the commands each needs. */
export function cleanupSteps(threads: readonly ThreadSummary[], kind: CleanupKind): BulkStep[] {
  switch (kind) {
    case "failed":
      // FAILED in the shared agent state: a failed session, or one idle after a failed turn.
      return threads.filter((t) => fleetGroupOf(t) === "failed").map((thread) => ({ thread, commands: ["archive"] }));
    case "finished":
      return threads.filter((t) => FINISHED.has(t.status)).map((thread) => ({ thread, commands: ["archive"] }));
    case "idle":
      // READY or IDLE at its prompt (any provider): the archive ends the quiet session. Paused or
      // blocked agents keep their turn.
      return threads
        .filter((t) => fleetGroupOf(t) === "idle" && t.status === "idle")
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
  /** KalTidy's canonical removal is in use (its own toasts and its Close all confirmation). */
  canonical: boolean;
  dismissAgent: (agentId: string) => Promise<void>;
  clearFailed: () => Promise<void>;
  clearFinished: () => Promise<void>;
  closeIdle: () => Promise<void>;
  /**
   * Canonical: opens KalTidy's one confirmation. Fallback: closes every agent at once; the
   * Fleet asks its own single confirmation first.
   */
  closeAll: () => Promise<void>;
}

/**
 * The Fleet's cleanup actions over the open coding agents. The fallback reports one outcome
 * toast with Undo (restores what it archived; an agent that was stopped stays stopped).
 */
export function useAgentCleanup(): AgentCleanup {
  const { state, runBulk } = useCodingAgents();
  const archived = useArchivedCodingAgents();
  const kalTidy = canonicalOf(useKalTidy());
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
      canonical: kalTidy !== null,
      dismissAgent: async (agentId: string) => {
        if (kalTidy) {
          await kalTidy.dismissAgent(agentId);
          return;
        }
        const thread = threads.find((t) => t.id === agentId);
        if (thread && canDismiss(thread)) await run("dismiss", [{ thread, commands: ["archive"] }]);
      },
      clearFailed: async () => {
        if (kalTidy) await kalTidy.clearFailed();
        else await run("failed", cleanupSteps(threads, "failed"));
      },
      clearFinished: async () => {
        if (kalTidy) await kalTidy.clearFinished();
        else await run("finished", cleanupSteps(threads, "finished"));
      },
      closeIdle: () => run("idle", cleanupSteps(threads, "idle")),
      closeAll: async () => {
        if (kalTidy) kalTidy.closeAll();
        else await run("all", cleanupSteps(threads, "all"));
      },
    }),
    [counts, threads, run, kalTidy],
  );
}

const NO_THREADS: readonly ThreadSummary[] = [];
