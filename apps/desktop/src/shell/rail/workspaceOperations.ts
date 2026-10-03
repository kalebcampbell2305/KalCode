import type { OperationRecord, OperationsSnapshot } from "@kalcode/protocol";

/** Only configured, ready queue entries can be launched; historic runs are never guessed at. */
export function workspaceDeployments(snapshot: OperationsSnapshot | null, workspaceId: string): OperationRecord[] {
  if (!snapshot || snapshot.paused) return [];
  return snapshot.items.filter(
    (run) =>
      run.spec.workspaceId === workspaceId &&
      run.source === "operations" &&
      (run.spec.kind === "deploy" || run.spec.kind === "release") &&
      run.status === "queued" &&
      run.blockers.length === 0,
  );
}
