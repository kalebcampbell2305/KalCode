import type { TerminalInfo } from "@kalcode/protocol";
import { Button, ErrorState, Skeleton } from "@kalcode/ui/components";
import { SquareTerminal } from "lucide-react";
import { formatAbsolute } from "../../../runtime/describeEvent.ts";
import { useWorkspaces } from "../../../runtime/WorkspaceProvider.tsx";
import { groupRunning, tabLabels } from "../../../runtime/workspaceState.ts";
import { useRunningTerminals, useThreadSummaries } from "../../../surfaces/dashboard/data/DashboardData.tsx";
import { formatElapsed } from "../../../surfaces/dashboard/data/format.ts";
import { useClock } from "../../../surfaces/dashboard/useNow.ts";
import { useNavigation } from "../../navigation.tsx";
import styles from "./TerminalsWidget.module.css";

/** How many terminals are running (the widget's count), or null while unknown. */
export function useRunningTerminalCount(): number | null {
  const { state } = useRunningTerminals();
  return state.status === "ready" && state.data.length > 0 ? state.data.length : null;
}

/**
 * Terminals running now (`terminals_running`), grouped by workspace. Show opens the terminal's
 * tab in Code, switching to its workspace first.
 */
export function TerminalsWidget() {
  const { state, reload } = useRunningTerminals();
  const threads = useThreadSummaries().state;
  const { workspaces, activate, selectTerminal } = useWorkspaces();
  const { navigate } = useNavigation();
  // A tick re-renders the list only when a run time it shows changes.
  const now = useClock((at) =>
    state.status === "ready"
      ? state.data
          .map((terminal) => (terminal.startedAt ? formatElapsed(at - Date.parse(terminal.startedAt)) : ""))
          .join("|")
      : null,
  );

  if (state.status === "unavailable") {
    return <p className={styles.none}>Terminals aren't available in this build.</p>;
  }
  if (state.status === "loading") {
    return (
      <div className={styles.list} role="status" aria-busy="true">
        <span className="visually-hidden">Loading terminals</span>
        <Skeleton width="70%" />
        <Skeleton width="55%" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <ErrorState title="Terminals couldn't load" actions={<Button onClick={reload}>Try again</Button>} framed={false}>
        <p>{state.error.message}</p>
      </ErrorState>
    );
  }
  if (state.data.length === 0) return <p className={styles.none}>No terminals are running.</p>;

  const threadWorkspaceNames = new Map(
    threads.status === "ready" ? threads.data.map((t) => [t.workspaceId, t.workspaceName]) : [],
  );
  const workspaceName = (id: string, fallback: string | undefined) =>
    fallback ?? threadWorkspaceNames.get(id) ?? "Workspace";

  const show = async (terminal: TerminalInfo) => {
    // The displayed workspace may still have an older native switch in flight.
    if (!(await activate(terminal.workspaceId))) return;
    navigate("code");
    selectTerminal(terminal.id, true, terminal.workspaceId);
  };

  return (
    <div className={styles.groups}>
      {groupRunning(state.data, workspaces).map((group) => {
        const name = workspaceName(group.workspaceId, group.workspace?.name);
        const labels = tabLabels(group.terminals);
        return (
          <div key={group.workspaceId} className={styles.group}>
            <h3 className={styles.workspace} title={group.workspace?.displayPath}>
              {name}
            </h3>
            <ul className={styles.list}>
              {group.terminals.map((terminal) => {
                const label = labels.get(terminal.id) ?? terminal.title;
                return (
                  <li key={terminal.id} className={styles.item}>
                    <SquareTerminal className={styles.icon} aria-hidden="true" />
                    <span className={styles.title}>{label}</span>
                    {terminal.startedAt ? (
                      <time
                        className={styles.time}
                        dateTime={terminal.startedAt}
                        title={formatAbsolute(terminal.startedAt)}
                      >
                        <span className="visually-hidden">Running for </span>
                        {formatElapsed(now - Date.parse(terminal.startedAt))}
                      </time>
                    ) : (
                      <span />
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void show(terminal)}
                      aria-label={`Show ${label} in ${name}`}
                    >
                      Show
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
