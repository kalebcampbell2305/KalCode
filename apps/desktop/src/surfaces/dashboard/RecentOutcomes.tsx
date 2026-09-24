import { Section } from "@kalcode/ui/components";
import { useThreadSummaries } from "./data/DashboardData.tsx";
import { recentOutcomes } from "./data/status.ts";
import styles from "./ThreadList.module.css";
import { ThreadRow } from "./ThreadRow.tsx";

/**
 * The most recent completed, failed and stopped threads, with Retry, Resume and Archive. Shown
 * only once threads have loaded; loading and read errors are reported once, by the Threads section.
 */
export function RecentOutcomes({ now }: { now: number }) {
  const { state, pendingActions, runAction } = useThreadSummaries();
  if (state.status !== "ready") return null;
  const outcomes = recentOutcomes(state.data);
  if (outcomes.length === 0) return null;

  return (
    <Section id="recent" title="Recent completions and failures">
      <div className={styles.groups}>
        <ul className={styles.list} aria-label="Recent completions and failures">
          {outcomes.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              now={now}
              variant="outcome"
              pending={pendingActions.get(thread.id)}
              onAction={(action) => void runAction(thread, action)}
            />
          ))}
        </ul>
      </div>
    </Section>
  );
}
