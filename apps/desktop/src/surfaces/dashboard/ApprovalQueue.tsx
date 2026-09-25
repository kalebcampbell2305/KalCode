import type { ApprovalDecision } from "@kalcode/protocol";
import { Button, ErrorState, Skeleton } from "@kalcode/ui/components";
import { Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ApprovalPrompt, usePermissions } from "../permissions/index.ts";
import styles from "./ApprovalQueue.module.css";

const VISIBLE = 5;

/**
 * Pending approval requests, longest waiting first, rendered with the same approval prompt as
 * the Approvals panel (Z4). Placed above everything else so a thread blocked on the user is
 * impossible to miss.
 */
export function ApprovalQueue() {
  const { pending, pendingState, pendingError, refreshPending, decide } = usePermissions();
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);

  const queue = useMemo(() => [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [pending]);

  const onDecide = async (requestId: string, decision: ApprovalDecision) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-approval-id]") ?? [])];
    const index = items.findIndex((el) => el.dataset.approvalId === requestId);
    const hadFocus = index >= 0 && items[index]?.contains(document.activeElement);
    const result = await decide(requestId, decision);
    if (!result || !hadFocus) return;
    // Keep keyboard users in the queue: focus the next request's first answer, else the heading.
    requestAnimationFrame(() => {
      const remaining = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-approval-id]") ?? [])];
      const next = remaining[Math.min(index, remaining.length - 1)];
      const target = next?.querySelector<HTMLElement>("button:not([disabled])");
      if (target) target.focus();
      else document.getElementById("approvals-title")?.focus();
    });
  };

  const ready = pendingState === "ready" || (pendingState === "error" && pending.length > 0);
  const count = ready ? queue.length : 0;
  const tone = !ready ? "unknown" : count > 0 ? "waiting" : "calm";
  const Icon = tone === "waiting" ? ShieldAlert : tone === "calm" ? ShieldCheck : Shield;

  return (
    <section id="approvals" className={styles.section} aria-labelledby="approvals-title" data-tone={tone}>
      <header className={styles.header}>
        <h2 id="approvals-title" className={styles.title} tabIndex={-1}>
          <Icon className={styles.icon} aria-hidden="true" />
          Needs approval
          {count > 0 ? <span className={styles.count}>{count}</span> : null}
        </h2>
        {pendingState === "error" && pending.length > 0 ? (
          <p className={styles.stale} role="status">
            Couldn't refresh: {pendingError?.message}{" "}
            <Button variant="ghost" size="sm" onClick={() => void refreshPending()}>
              Try again
            </Button>
          </p>
        ) : null}
      </header>

      {pendingState === "loading" && pending.length === 0 ? (
        <div className={styles.loading} role="status" aria-busy="true">
          <span className="visually-hidden">Loading approval requests</span>
          {[0, 1].map((i) => (
            <div key={i} className={styles.skeletonItem}>
              <Skeleton width="40%" height="1rem" />
              <Skeleton width="70%" />
              <Skeleton width="55%" />
            </div>
          ))}
        </div>
      ) : pendingState === "error" && pending.length === 0 ? (
        <ErrorState
          title="Approval requests couldn't load"
          code={pendingError ? `${pendingError.category}/${pendingError.code}` : undefined}
          actions={<Button onClick={() => void refreshPending()}>Try again</Button>}
        >
          <p>{pendingError?.message}</p>
        </ErrorState>
      ) : queue.length === 0 ? (
        <p className={styles.clear}>Nothing is waiting for your approval.</p>
      ) : (
        <>
          <ol ref={listRef} className={styles.list} aria-label="Pending approvals">
            {(expanded ? queue : queue.slice(0, VISIBLE)).map((request) => (
              <li key={request.id} data-approval-id={request.id}>
                <ApprovalPrompt request={request} onDecide={onDecide} headingLevel={3} />
              </li>
            ))}
          </ol>
          {queue.length > VISIBLE ? (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
                {expanded ? "Show fewer" : `Show ${queue.length - VISIBLE} more`}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
