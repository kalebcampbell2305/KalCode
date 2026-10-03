import { displayStatusOf, type ThreadSummary } from "@kalcode/protocol";
import { ProviderGlyph, Skeleton, StatusChip } from "@kalcode/ui/components";
import { useMemo } from "react";
import { useOptionalUiIntents } from "../../../runtime/uiIntents.tsx";
import { compareThreads } from "../../../surfaces/dashboard/data/board.ts";
import { useCodingAgents } from "../../../surfaces/dashboard/data/DashboardData.tsx";
import { formatElapsed } from "../../../surfaces/dashboard/data/format.ts";
import { useNow } from "../../../surfaces/dashboard/useNow.ts";
import { useNavigation } from "../../navigation.tsx";
import styles from "./Widgets.module.css";

function working(threads: readonly ThreadSummary[]): ThreadSummary[] {
  return threads.filter((t) => displayStatusOf(t.status).chip === "working").sort(compareThreads);
}

export function useActiveAgentCount(): number | null {
  const { state } = useCodingAgents();
  const n = state.status === "ready" ? working(state.data).length : 0;
  return n > 0 ? n : null;
}

/** Agents working right now, with what each is doing (structured activity only). */
export function ActiveAgentsWidget() {
  const { state } = useCodingAgents();
  const intents = useOptionalUiIntents();
  const { navigate } = useNavigation();
  const now = useNow(30_000);
  const list = useMemo(() => (state.status === "ready" ? working(state.data) : []), [state]);

  if (state.status === "loading") {
    return (
      <div role="status" aria-busy="true">
        <span className="visually-hidden">Loading agents</span>
        <Skeleton width="60%" />
      </div>
    );
  }
  if (state.status === "unavailable") return <p className={styles.none}>Agents aren't available in this build.</p>;
  if (state.status === "error") return <p className={styles.none}>{state.error.message}</p>;
  if (list.length === 0) return <p className={styles.none}>No agents are working right now.</p>;

  const open = (thread: ThreadSummary) => {
    if (intents) void intents.focus({ kind: "agent", agentId: thread.id, workspaceId: thread.workspaceId });
    else navigate("code");
  };

  return (
    <ul className={styles.list} aria-label="Working agents">
      {list.map((thread) => {
        const display = displayStatusOf(thread.status);
        return (
          <li key={thread.id} className={styles.item}>
            <ProviderGlyph provider={thread.providerId} size="sm" />
            <span className={styles.stack}>
              <button
                type="button"
                className={`${styles.primary} ${styles.linkish}`}
                onClick={() => open(thread)}
                title={thread.name}
              >
                {thread.name}
              </button>
              <span className={styles.secondary}>
                {thread.currentActivity ?? `${thread.providerName} · ${thread.workspaceName}`}
              </span>
            </span>
            <span className={styles.stack}>
              <StatusChip status={display.status} variant="dot" size="sm" />
              <span className={styles.time}>
                <span className="visually-hidden">Started </span>
                {formatElapsed(now - Date.parse(thread.createdAt))}
                <span className="visually-hidden"> ago</span>
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
