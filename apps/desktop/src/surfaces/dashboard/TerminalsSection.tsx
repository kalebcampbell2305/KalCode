import type { TerminalInfo } from "@kalcode/protocol";
import { Button, Section, StatusIndicator } from "@kalcode/ui/components";
import { useEffect, useState } from "react";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { groupRunning, tabLabels } from "../../runtime/workspaceState.ts";
import { useNavigation } from "../../shell/navigation.tsx";
import styles from "./TerminalsSection.module.css";

/** Running terminals across workspaces. Updates live from shell and workspace events. */
export function TerminalsSection() {
  const { running, workspaces, active, activate, selectTerminal, state } = useWorkspaces();
  const { navigate } = useNavigation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const groups = groupRunning(running, workspaces);
  const labels = tabLabels(running);

  const open = async (terminal: TerminalInfo) => {
    if (active?.id !== terminal.workspaceId && !(await activate(terminal.workspaceId))) return;
    navigate("code");
    selectTerminal(terminal.id, true);
  };

  return (
    <Section
      id="terminals"
      title="Terminals"
      description="Shells running in your workspaces."
      actions={
        <Button variant="ghost" size="sm" onClick={() => navigate("code")}>
          Open Code
        </Button>
      }
    >
      {state === "loading" ? null : groups.length === 0 ? (
        <p className={styles.empty}>No terminals are running.</p>
      ) : (
        <div className={styles.groups}>
          {groups.map((group) => (
            <div key={group.workspaceId} className={styles.group}>
              <h3 className={styles.workspace}>
                {group.workspace?.name ?? "Workspace"}
                <span className={styles.path}>{group.workspace?.displayPath}</span>
              </h3>
              <ul className={styles.list}>
                {group.terminals.map((terminal) => (
                  <li key={terminal.id} className={styles.row}>
                    <StatusIndicator tone="live">Running</StatusIndicator>
                    <span className={styles.title}>{labels.get(terminal.id) ?? terminal.title}</span>
                    {terminal.startedAt ? (
                      <time
                        className={styles.time}
                        dateTime={terminal.startedAt}
                        title={formatAbsolute(terminal.startedAt)}
                      >
                        Started {formatRelative(terminal.startedAt, now)}
                      </time>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void open(terminal)}
                      aria-label={`Show ${labels.get(terminal.id) ?? terminal.title} in ${group.workspace?.name ?? "its workspace"}`}
                    >
                      Show
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
