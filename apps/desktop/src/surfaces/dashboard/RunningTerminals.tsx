import type { ThreadSummary } from "@kalcode/protocol";
import { Button, ErrorState, Section, Skeleton } from "@kalcode/ui/components";
import { SquareTerminal } from "lucide-react";
import { formatAbsolute } from "../../runtime/describeEvent.ts";
import { useRunningTerminals } from "./data/DashboardData.tsx";
import { formatElapsed } from "./data/format.ts";
import styles from "./RunningTerminals.module.css";

interface RunningTerminalsProps {
  threads: readonly ThreadSummary[];
  now: number;
}

/** Terminals running now (Z1 `terminals_running`). Hidden when this build has no terminals. */
export function RunningTerminals({ threads, now }: RunningTerminalsProps) {
  const { state, reload } = useRunningTerminals();
  if (state.status === "unavailable") return null;

  const workspaceNames = new Map(threads.map((t) => [t.workspaceId, t.workspaceName]));

  return (
    <Section id="terminals" title="Terminals">
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
        <ul className={styles.list}>
          {state.data.map((terminal) => (
            <li key={terminal.id} className={styles.item}>
              <SquareTerminal className={styles.icon} aria-hidden="true" />
              <span className={styles.text}>
                <span className={styles.title}>{terminal.title}</span>
                {workspaceNames.has(terminal.workspaceId) ? (
                  <span className={styles.where}>{workspaceNames.get(terminal.workspaceId)}</span>
                ) : null}
              </span>
              {terminal.startedAt ? (
                <time className={styles.time} dateTime={terminal.startedAt} title={formatAbsolute(terminal.startedAt)}>
                  <span className="visually-hidden">Running for </span>
                  {formatElapsed(now - Date.parse(terminal.startedAt))}
                </time>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
