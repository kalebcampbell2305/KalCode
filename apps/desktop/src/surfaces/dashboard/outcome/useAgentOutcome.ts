import type { OperationTestResult, ThreadSummary, ThreadWorktreeState } from "@kalcode/protocol";
import { useEffect, useMemo, useState } from "react";
import { OperationsClient } from "../../../ipc/operations.ts";
import { useOptionalRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { useOptionalDeckData } from "../../../shell/deck/DeckData.tsx";
import { useOptionalOwnership } from "../data/DashboardData.tsx";
import { agentOutcome, linkedRuns, type OutcomeRow } from "./outcomeModel.ts";

/**
 * An agent's outcome rows from data KalCode already reads: the shell's Operations snapshot (Deck
 * data, already polled) and the worktree facts the caller has. Nothing new polls. Only when the
 * person opens the full outcome (`expanded`) does it read more, once: the latest linked test run's
 * results and, for a pane without worktree facts, the worktree itself.
 */
export function useAgentOutcome(
  thread: ThreadSummary,
  worktree: ThreadWorktreeState | undefined,
  expanded: boolean,
): OutcomeRow[] {
  // Rendered standalone (a card in a test, an isolated pane) it shows only what it was given.
  const client = useOptionalRuntime()?.client ?? null;
  const deck = useOptionalDeckData();
  const snapshot = deck?.operations.data ?? null;
  const runs = snapshot?.items;
  const environments = snapshot?.environments;

  const [latestTest] = useMemo(() => linkedRuns(thread.id, runs, ["test"]), [thread.id, runs]);
  const testKey =
    latestTest && (latestTest.status === "succeeded" || latestTest.status === "failed")
      ? `${latestTest.id}:${latestTest.status}`
      : null;
  const [tests, setTests] = useState<{ key: string; results: OperationTestResult[] } | null>(null);
  const [ownWorktree, setOwnWorktree] = useState<ThreadWorktreeState | undefined>(undefined);

  useEffect(() => {
    if (!client || !expanded || !testKey || tests?.key === testKey) return;
    const id = testKey.slice(0, testKey.lastIndexOf(":"));
    let live = true;
    new OperationsClient((command, args) => client.transport.invoke(command, args)).detail(id).then(
      (detail) => {
        if (live) setTests({ key: testKey, results: detail.tests });
      },
      () => undefined, // The run's status still says passed or failed.
    );
    return () => {
      live = false;
    };
  }, [expanded, testKey, tests?.key, client]);

  useEffect(() => {
    if (!client || !expanded || worktree || !thread.worktreeId) return;
    let live = true;
    client.threadWorktreeStates([thread.id]).then(
      ([state]) => {
        if (live) setOwnWorktree(state);
      },
      () => undefined, // Unknown stays unknown.
    );
    return () => {
      live = false;
    };
  }, [expanded, worktree, thread.worktreeId, thread.id, client]);

  // Git-confirmed conflicts with other agents (Agent File Ownership), as names; stable while unchanged.
  const overlaps = useOptionalOwnership()?.byAgent.get(thread.id);
  const conflictKey = JSON.stringify(
    (overlaps ?? [])
      .filter(({ overlap }) => overlap.risk === "conflict")
      .map(({ other }) => other.name.trim() || other.providerName),
  );
  const conflictsWith = useMemo<readonly string[]>(() => JSON.parse(conflictKey), [conflictKey]);

  const facts = worktree ?? ownWorktree;
  const results = tests && tests.key === testKey ? tests.results : null;
  return useMemo(
    () => agentOutcome(thread, facts, { runs, tests: results, environments, conflictsWith }),
    [thread, facts, runs, results, environments, conflictsWith],
  );
}
