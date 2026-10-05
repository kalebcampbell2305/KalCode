import type { EventEnvelope } from "@kalcode/protocol";
import { Button, ErrorState, Skeleton } from "@kalcode/ui/components";
import { useMemo, useState } from "react";
import { describeEvent, formatAbsolute, formatRelative } from "../../../runtime/describeEvent.ts";
import { useEvents } from "../../../runtime/RuntimeProvider.tsx";
import { useThreadSummaries } from "../../../surfaces/dashboard/data/DashboardData.tsx";
import { useClock } from "../../../surfaces/dashboard/useNow.ts";
import styles from "./ActivityWidget.module.css";

const VISIBLE_STEP = 25;

/** The thread an event belongs to, from its correlation or its payload. */
function threadIdOf(event: EventEnvelope): string | null {
  if (event.correlation.threadId) return event.correlation.threadId;
  const payload = event.payload as { threadId?: unknown };
  return typeof payload.threadId === "string" ? payload.threadId : null;
}

/** Recent activity: KalCode's event log, newest first, updating live. */
export function ActivityWidget() {
  const { events, state, error, retry, loadOlder, reachedStart } = useEvents();
  const threads = useThreadSummaries().state;
  const [visible, setVisible] = useState(VISIBLE_STEP);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const threadNames = useMemo(
    () => new Map(threads.status === "ready" ? threads.data.map((t) => [t.id, t.name]) : []),
    [threads],
  );

  // Raised notifications are listed in the notification center, not repeated here.
  const feed = useMemo(() => events.filter((e) => e.type !== "notification.created"), [events]);
  const shown = feed.slice(0, visible);
  const canShowMore = visible < feed.length || !reachedStart;
  // A tick re-renders the feed only when a time it shows changes.
  const now = useClock((at) => shown.map((event) => formatRelative(event.occurredAt, at)).join("|"));

  const showMore = async () => {
    if (visible + VISIBLE_STEP > feed.length && !reachedStart) {
      setLoadingOlder(true);
      await loadOlder();
      setLoadingOlder(false);
    }
    setVisible((v) => v + VISIBLE_STEP);
  };

  if (state === "loading") {
    return (
      <div className={styles.list} role="status" aria-busy="true">
        <span className="visually-hidden">Loading activity</span>
        {[0, 1, 2].map((i) => (
          <div key={i} className={styles.row}>
            <Skeleton width="0.5rem" height="0.5rem" />
            <Skeleton width={`${40 + i * 12}%`} />
            <Skeleton width="4rem" />
          </div>
        ))}
      </div>
    );
  }
  if (state === "error") {
    return (
      <ErrorState
        title="Activity couldn't load"
        code={error ? `${error.category}/${error.code}` : undefined}
        actions={<Button onClick={retry}>Try again</Button>}
        framed={false}
      >
        <p>{error?.message ?? "KalCode couldn't read its event log."} Your data is unchanged.</p>
      </ErrorState>
    );
  }
  return (
    <>
      <ol className={styles.list} aria-live="polite" aria-relevant="additions">
        {shown.map((event) => {
          const description = describeEvent(event);
          const threadId = threadIdOf(event);
          const threadName = threadId ? threadNames.get(threadId) : undefined;
          return (
            <li key={event.seq} className={styles.row}>
              <span className={styles.dot} data-tone={description.tone} aria-hidden="true" />
              <span className={styles.text}>
                <span className={styles.title}>{description.title}</span>
                {threadName ? <span className={styles.thread}>{threadName}</span> : null}
                {description.detail ? <span className={styles.detail}>{description.detail}</span> : null}
              </span>
              <time className={styles.time} dateTime={event.occurredAt} title={formatAbsolute(event.occurredAt)}>
                {formatRelative(event.occurredAt, now)}
              </time>
            </li>
          );
        })}
      </ol>
      {canShowMore ? (
        <div className={styles.more}>
          <Button variant="ghost" size="sm" onClick={showMore} busy={loadingOlder}>
            Show older activity
          </Button>
        </div>
      ) : null}
    </>
  );
}
