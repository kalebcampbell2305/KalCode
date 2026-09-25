import type { TerminalInfo, ThreadSummary } from "@kalcode/protocol";
import { Button, ErrorState, Panel, Skeleton } from "@kalcode/ui/components";
import { SquareTerminal } from "lucide-react";
import { formatAbsolute } from "../../runtime/describeEvent.ts";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { groupRunning, tabLabels } from "../../runtime/workspaceState.ts";
import { useNavigation } from "../../shell/navigation.tsx";
import { useRunningTerminals } from "./data/DashboardData.tsx";
import { formatElapsed } from "./data/format.ts";
import styles from "./RunningTerminals.module.css";

interface RunningTerminalsProps {
  threads: readonly ThreadSummary[];
  now: number;
}

/**
 * Terminals running now (`terminals_running`), grouped by workspace. Show opens the terminal's
 * tab in Code, switching to its workspace first. Hidden when this build has no terminals.
 */
export function RunningTerminals({ threads, now }: RunningTerminalsProps) {
  const { state, reload } = useRunningTerminals();
  const { workspaces, active, activate, selectTerminal } = useWorkspaces();
  const { navigate } = useNavigation();
  if (state.status === "unavailable") return null;

  const threadWorkspaceNames = new Map(threads.map((t) => [t.workspaceId, t.workspaceName]));
  const workspaceName = (id: string, fallback: string | undefined) =>
    fallback ?? threadWorkspaceNames.get(id) ?? "Workspace";

  const show = async (terminal: TerminalInfo) => {
    if (active?.id !== terminal.workspaceId && !(await activate(terminal.workspaceId))) return;
    navigate("code");
    selectTerminal(terminal.id, true, terminal.workspaceId);
  };

  return (
    <Panel
      id="terminals"
      title="Terminals"
      count={state.status === "ready" && state.data.length > 0 ? state.data.length : undefined}
    >
      {state.status === "loading" ? (
        <div className={styles.list} role="status" aria-busy="true">
          <span className="visually-hidden">Loading terminals</span>
          <Skeleton width="70%" />
          <Skeleton width="55%" />
        </div>
      ) : state.status === "error" ? (
        <ErrorState title="Terminals couldn't load" actions={<Button onClick={reload}>Try again</Button>}>
          <p>{state.error.message}</p>
        </ErrorState>
      ) : state.data.length === 0 ? (
        <p className={styles.none}>No terminals are running.</p>
      ) : (
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
      )}
    </Panel>
  );
}
