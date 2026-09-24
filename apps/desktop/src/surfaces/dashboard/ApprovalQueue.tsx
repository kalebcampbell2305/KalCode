import type { ApprovalDecision, ApprovalRequest, ThreadSummary } from "@kalcode/protocol";
import { Button, ErrorState, Skeleton } from "@kalcode/ui/components";
import { Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";
import { ApprovalItem } from "./ApprovalItem.tsx";
import styles from "./ApprovalQueue.module.css";
import { usePendingApprovals } from "./data/DashboardData.tsx";

const VISIBLE = 5;

interface ApprovalQueueProps {
  threadsById: ReadonlyMap<string, ThreadSummary>;
  now: number;
}

/**
 * Pending approval requests, longest waiting first. Rendered above everything else so a thread
 * blocked on the user is impossible to miss. Hidden entirely when this build has no approvals.
 */
export function ApprovalQueue({ threadsById, now }: ApprovalQueueProps) {
  const { state, reload, deciding, decide } = usePendingApprovals();
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const initialIds = useRef<Set<string> | null>(null);

  if (state.status === "unavailable") return null;

  if (state.status === "ready" && initialIds.current === null) {
    initialIds.current = new Set(state.data.map((r) => r.id));
  }

  const onDecide = async (request: ApprovalRequest, decision: ApprovalDecision) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-approval-id]") ?? [])];
    const index = items.findIndex((el) => el.dataset.approvalId === request.id);
    const hadFocus = index >= 0 && items[index]?.contains(document.activeElement);
    await decide(request, decision);
    if (!hadFocus) return;
    // Keep keyboard users in the queue: focus the next request, else the previous, else the heading.
    requestAnimationFrame(() => {
      const remaining = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-approval-id]") ?? [])];
      const next = remaining[Math.min(index, remaining.length - 1)];
      if (next) next.focus();
      else document.getElementById("approvals-title")?.focus();
    });
  };

  const count = state.status === "ready" ? state.data.length : 0;
  const tone = state.status !== "ready" ? "unknown" : count > 0 ? "waiting" : "calm";
  const Icon = tone === "waiting" ? ShieldAlert : tone === "calm" ? ShieldCheck : Shield;

  return (
    <section id="approvals" className={styles.section} aria-labelledby="approvals-title" data-tone={tone}>
      <header className={styles.header}>
        <h2 id="approvals-title" className={styles.title} tabIndex={-1}>
          <Icon className={styles.icon} aria-hidden="true" />
          Needs approval
          {count > 0 ? <span className={styles.count}>{count}</span> : null}
        </h2>
        {state.status === "ready" && state.error ? (
          <p className={styles.stale} role="status">
            Couldn't refresh: {state.error.message}{" "}
            <Button variant="ghost" size="sm" onClick={reload}>
              Try again
            </Button>
          </p>
        ) : null}
      </header>

      {state.status === "loading" ? (
        <div className={styles.panel} role="status" aria-busy="true">
          <span className="visually-hidden">Loading approval requests</span>
          {[0, 1].map((i) => (
            <div key={i} className={styles.skeletonItem}>
              <Skeleton width="40%" height="1rem" />
              <Skeleton width="70%" />
              <Skeleton width="55%" />
            </div>
          ))}
        </div>
      ) : state.status === "error" ? (
        <ErrorState
          title="Approval requests couldn't load"
          code={`${state.error.category}/${state.error.code}`}
          actions={<Button onClick={reload}>Try again</Button>}
        >
          <p>{state.error.message}</p>
        </ErrorState>
      ) : state.data.length === 0 ? (
        <p className={styles.clear}>Nothing is waiting for your approval.</p>
      ) : (
        <>
          <div ref={listRef} className={styles.panel}>
            {(expanded ? state.data : state.data.slice(0, VISIBLE)).map((request) => (
              <ApprovalItem
                key={request.id}
                request={request}
                thread={threadsById.get(request.action.threadId)}
                busy={deciding.has(request.id)}
                arrived={!initialIds.current?.has(request.id)}
                now={now}
                onDecide={(decision) => void onDecide(request, decision)}
              />
            ))}
          </div>
          {state.data.length > VISIBLE ? (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
                {expanded ? "Show fewer" : `Show ${state.data.length - VISIBLE} more`}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
