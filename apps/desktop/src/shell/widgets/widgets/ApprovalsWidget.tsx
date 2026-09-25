import type { ApprovalDecision, ApprovalView } from "@kalcode/protocol";
import { Button, Skeleton } from "@kalcode/ui/components";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { formatAbsolute, formatRelative } from "../../../runtime/describeEvent.ts";
import { DECISION_LABELS } from "../../../surfaces/permissions/labels.ts";
import { usePermissions } from "../../../surfaces/permissions/PermissionsProvider.tsx";
import { useNow } from "../../../surfaces/dashboard/useNow.ts";
import styles from "./Widgets.module.css";

/** Quick answers shown in the widget, in the app's order; standing grants are in the full prompt. */
const QUICK: readonly ApprovalDecision[] = ["deny", "approve_once"];

export function usePendingApprovalCount(): number | null {
  const { pending } = usePermissions();
  return pending.length > 0 ? pending.length : null;
}

/**
 * Every pending approval, oldest first — including requests with no thread card (KalVoice).
 * Deny and Approve once answer here; Review opens the full prompt with every allowed answer.
 */
export function ApprovalsWidget() {
  const { pending, pendingState, pendingError, decide, setPanelOpen } = usePermissions();
  const now = useNow(30_000);
  if (pendingState === "loading" && pending.length === 0) {
    return (
      <div role="status" aria-busy="true">
        <span className="visually-hidden">Loading approvals</span>
        <Skeleton width="70%" />
      </div>
    );
  }
  if (pendingState === "error" && pending.length === 0) {
    return <p className={styles.none}>{pendingError?.message ?? "Approvals couldn't load."}</p>;
  }
  if (pending.length === 0) return <p className={styles.none}>Nothing is waiting for your approval.</p>;
  const oldestFirst = [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <ol className={styles.list} aria-label="Pending approvals">
      {oldestFirst.map((request) => (
        <ApprovalRow
          key={request.id}
          request={request}
          now={now}
          onDecide={decide}
          onReview={() => setPanelOpen(true)}
        />
      ))}
    </ol>
  );
}

function ApprovalRow({
  request,
  now,
  onDecide,
  onReview,
}: {
  request: ApprovalView;
  now: number;
  onDecide: (id: string, decision: ApprovalDecision) => Promise<unknown>;
  onReview: () => void;
}) {
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const who = [request.context?.threadName, request.context?.providerName].filter(Boolean).join(" · ");
  const decide = async (decision: ApprovalDecision) => {
    setBusy(decision);
    try {
      await onDecide(request.id, decision);
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className={styles.item} data-approval-id={request.id}>
      <ShieldAlert className={styles.glyph} aria-hidden="true" />
      <span className={styles.stack}>
        <span className={styles.primary}>{request.action.summary || "An agent wants to act"}</span>
        {who ? <span className={styles.secondary}>{who}</span> : null}
      </span>
      <time className={styles.time} dateTime={request.createdAt} title={formatAbsolute(request.createdAt)}>
        {formatRelative(request.createdAt, now)}
      </time>
      <span className={styles.actions}>
        {QUICK.filter((d) => request.allowedDecisions.includes(d)).map((decision) => (
          <Button
            key={decision}
            size="sm"
            variant={decision === "deny" ? "danger" : "primary"}
            busy={busy === decision}
            disabled={busy !== null && busy !== decision}
            onClick={() => void decide(decision)}
            aria-label={`${DECISION_LABELS[decision]}: ${request.action.summary}`}
          >
            {DECISION_LABELS[decision]}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={onReview}>
          Review
        </Button>
      </span>
    </li>
  );
}
