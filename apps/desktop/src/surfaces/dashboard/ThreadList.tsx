import type { ThreadSummary } from "@kalcode/protocol";
import { Button, EmptyState, ErrorState, Panel, Skeleton } from "@kalcode/ui/components";
import { useNavigation } from "../../shell/navigation.tsx";
import { ConstellationArt } from "./ConstellationArt.tsx";
import { useThreadSummaries } from "./data/DashboardData.tsx";
import { STATUS_META, type StatusGroup, sortOpenThreads } from "./data/status.ts";
import styles from "./ThreadList.module.css";
import { ThreadRow } from "./ThreadRow.tsx";

const GROUPS: { group: Exclude<StatusGroup, "finished">; label: string }[] = [
  { group: "attention", label: "Needs you" },
  { group: "working", label: "Working" },
  { group: "waiting", label: "Blocked" },
  { group: "idle", label: "Idle and paused" },
];

export function ThreadRowsSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div className={styles.skeleton} role="status" aria-busy="true">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
        <div key={i} className={styles.skeletonRow}>
          <Skeleton width="7rem" />
          <div className={styles.skeletonMain}>
            <Skeleton width={`${46 + ((i * 17) % 30)}%`} height="0.9375rem" />
            <Skeleton width={`${62 - ((i * 11) % 20)}%`} />
          </div>
          <Skeleton width="4rem" />
        </div>
      ))}
    </div>
  );
}

/** Open threads grouped by what they need: the user first, then working, blocked and idle. */
export function ThreadList({ now }: { now: number }) {
  const { state, reload, pendingActions, runAction } = useThreadSummaries();
  const { navigate } = useNavigation();

  let body: React.ReactNode;
  if (state.status === "unavailable") {
    body = (
      <EmptyState
        art={<ConstellationArt />}
        artStyle="free"
        framed={false}
        title="Threads arrive with provider support"
        className={styles.empty}
      >
        <p>
          When Claude Code, Codex or Gemini CLI run in your projects, each thread appears here with its provider, model,
          current activity and status, and any approval it's waiting on appears above it.
        </p>
        <p>This build doesn't run threads yet, so there's nothing to show.</p>
      </EmptyState>
    );
  } else if (state.status === "loading") {
    body = <ThreadRowsSkeleton label="Loading threads" rows={4} />;
  } else if (state.status === "error") {
    body = (
      <ErrorState
        title="Threads couldn't load"
        code={`${state.error.category}/${state.error.code}`}
        actions={<Button onClick={reload}>Try again</Button>}
      >
        <p>{state.error.message}</p>
      </ErrorState>
    );
  } else {
    const open = sortOpenThreads(state.data);
    body =
      open.length === 0 ? (
        <EmptyState
          art={<ConstellationArt />}
          artStyle="free"
          framed={false}
          title="No active threads"
          className={styles.empty}
          actions={<Button onClick={() => navigate("threads")}>Go to Threads</Button>}
        >
          <p>
            Start a new thread from Threads. While it works, it shows here with its provider, current activity, status
            and anything it needs from you.
          </p>
        </EmptyState>
      ) : (
        <div className={styles.groups}>
          {GROUPS.map(({ group, label }) => {
            const items = open.filter((t) => STATUS_META[t.status].group === group);
            if (items.length === 0) return null;
            return (
              <div key={group} className={styles.group} data-group={group}>
                <h3 className={styles.groupTitle} id={`threads-${group}`}>
                  {label}
                  <span className={styles.groupCount}>{items.length}</span>
                </h3>
                <ul className={styles.list} aria-labelledby={`threads-${group}`}>
                  {items.map((thread: ThreadSummary) => (
                    <ThreadRow
                      key={thread.id}
                      thread={thread}
                      now={now}
                      pending={pendingActions.get(thread.id)}
                      onAction={(action) => void runAction(thread, action)}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      );
  }

  return (
    <Panel
      id="threads"
      title="Threads"
      description={state.status === "ready" && state.error ? `Couldn't refresh: ${state.error.message}` : undefined}
      actions={
        state.status === "ready" && state.error ? (
          <Button variant="ghost" size="sm" onClick={reload}>
            Try again
          </Button>
        ) : undefined
      }
    >
      {body}
    </Panel>
  );
}
