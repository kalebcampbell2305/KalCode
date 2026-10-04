import type { ThreadSummary } from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PaneAttention } from "../../shell/panes/contentRegistry.ts";

/** Shared lifecycle facts only: chat sessions and archived agents never request pane attention. */
export function agentAttention(thread: ThreadSummary): PaneAttention | null {
  if (thread.runtimeKind !== "interactive_pty" || thread.archivedAt !== null) return null;
  if (thread.pendingApprovals > 0 || thread.status === "waiting_for_permission" || thread.status === "waiting_for_user")
    return "needs-you";
  return thread.status === "completed" ? "completed" : null;
}

interface AttentionRecord {
  kind: PaneAttention;
  seen: boolean;
}

/**
 * Acknowledgement lasts until the agent leaves this lifecycle state. Output and heartbeat updates
 * do not light it again. This hook only describes chrome: it cannot select, scroll or focus a pane.
 */
export function useAgentAttention(threads: readonly ThreadSummary[]) {
  const current = useMemo(
    () =>
      new Map(
        threads.flatMap((thread) => {
          const kind = agentAttention(thread);
          return kind ? [[thread.id, kind] as const] : [];
        }),
      ),
    [threads],
  );
  const [records, setRecords] = useState<ReadonlyMap<string, AttentionRecord>>(
    () => new Map([...current].map(([id, kind]) => [id, { kind, seen: false }])),
  );
  useEffect(() => {
    setRecords((previous) => {
      let changed = previous.size !== current.size;
      const next = new Map<string, AttentionRecord>();
      for (const [id, kind] of current) {
        const existing = previous.get(id);
        if (existing?.kind === kind) next.set(id, existing);
        else {
          changed = true;
          next.set(id, { kind, seen: false });
        }
      }
      return changed ? next : previous;
    });
  }, [current]);

  const acknowledge = useCallback((agentId: string) => {
    setRecords((previous) => {
      const record = previous.get(agentId);
      if (!record || record.seen) return previous;
      const next = new Map(previous);
      next.set(agentId, { ...record, seen: true });
      return next;
    });
  }, []);
  const pending = useMemo(
    () =>
      new Map(
        [...current].filter(([id, kind]) => {
          const record = records.get(id);
          return record?.kind !== kind || !record.seen;
        }),
      ),
    [current, records],
  );
  return useMemo(() => ({ pending, acknowledge }), [pending, acknowledge]);
}
