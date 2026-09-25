import type { EventEnvelope } from "@kalcode/protocol";
import { Button, ErrorState, Panel, Skeleton } from "@kalcode/ui/components";
import { useState } from "react";
import { describeEvent, formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import { useEvents } from "../../runtime/RuntimeProvider.tsx";
import styles from "./ActivityFeed.module.css";
import { useNow } from "./useNow.ts";

const VISIBLE_STEP = 25;

/** The thread an event belongs to, from its correlation or its payload. */
function threadIdOf(event: EventEnvelope): string | null {
  if (event.correlation.threadId) return event.correlation.threadId;
  const payload = event.payload as { threadId?: unknown };
  return typeof payload.threadId === "string" ? payload.threadId : null;
}

interface ActivityFeedProps {
  /** Thread names by id, so thread events say which thread they are about. */
  threadNames?: ReadonlyMap<string, string>;
}

export function ActivityFeed({ threadNames }: ActivityFeedProps = {}) {
  const { events, state, error, retry, loadOlder, reachedStart } = useEvents();
  const [visible, setVisible] = useState(VISIBLE_STEP);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const now = useNow();

  const shown = events.slice(0, visible);
  const canShowMore = visible < events.length || !reachedStart;

  const showMore = async () => {
    if (visible + VISIBLE_STEP > events.length && !reachedStart) {
      setLoadingOlder(true);
      await loadOlder();
      setLoadingOlder(false);
    }
    setVisible((v) => v + VISIBLE_STEP);
  };

  return (
    <Panel id="activity" title="Activity" description="Recorded by KalCode's event log. Updates live.">
      {state === "loading" ? (
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
      ) : state === "error" ? (
        <ErrorState
          title="Activity couldn't load"
          code={error ? `${error.category}/${error.code}` : undefined}
          actions={<Button onClick={retry}>Try again</Button>}
        >
          <p>{error?.message ?? "KalCode couldn't read its event log."} Your data is unchanged.</p>
        </ErrorState>
      ) : (
        <>
          <ol className={styles.list} aria-live="polite" aria-relevant="additions">
            {shown.map((event) => {
              const description = describeEvent(event);
              const threadId = threadIdOf(event);
              const threadName = threadId ? threadNames?.get(threadId) : undefined;
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
            <div>
              <Button variant="ghost" size="sm" onClick={showMore} busy={loadingOlder}>
                Show older activity
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}
