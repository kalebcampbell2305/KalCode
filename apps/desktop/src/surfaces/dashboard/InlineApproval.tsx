import type { ApprovalDecision, ApprovalView } from "@kalcode/protocol";
import { Button } from "@kalcode/ui/components";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { actionDetail, DECISION_LABELS, SCOPE_LABELS, scopeTone } from "../permissions/labels.ts";
import styles from "./AgentCard.module.css";

/**
 * The approval answers, in the app's order: Deny · Allow for workspace · Allow for thread ·
 * Approve once (Z4 `PROMPT_DECISIONS`). Only the answers the engine allows for this request
 * render (remote-consequential requests offer Deny and Approve once).
 */
const ORDER: readonly ApprovalDecision[] = ["deny", "approve_for_workspace", "approve_for_thread", "approve_once"];

export interface InlineApprovalProps {
  request: ApprovalView;
  /** Other pending requests from the same thread. */
  more: number;
  onDecide: (requestId: string, decision: ApprovalDecision) => Promise<unknown>;
  onReviewAll: () => void;
}

/**
 * ACTION NEEDED on a Dashboard card: the exact action the agent asks for and the answers, answered
 * through Z4 `approval_decide`. The full prompt (reason, grant coverage) is in the approvals panel.
 */
export function InlineApproval({ request, more, onDecide, onReviewAll }: InlineApprovalProps) {
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const detail = actionDetail(request.action.action);
  const title = request.action.summary || detail || "An agent wants to act";
  const decisions = ORDER.filter((decision) => request.allowedDecisions.includes(decision));
  const labelId = `approval-${request.id}-title`;

  const decide = async (decision: ApprovalDecision) => {
    setBusy(decision);
    try {
      await onDecide(request.id, decision);
    } finally {
      setBusy(null);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of buttons, not form fields.
    <div className={styles.approval} role="group" aria-labelledby={labelId} data-approval-id={request.id}>
      <p className={styles.approvalTitle} id={labelId}>
        <ShieldAlert aria-hidden="true" className={styles.approvalGlyph} />
        <span>{title}</span>
      </p>
      {detail && detail !== title ? <code className={styles.approvalDetail}>{detail}</code> : null}
      {request.decision.scopes.length > 0 ? (
        <ul className={styles.scopes} aria-label="Permissions this needs">
          {request.decision.scopes.map((scope) => (
            <li key={scope} className={styles.scope} data-tone={scopeTone(scope)}>
              {SCOPE_LABELS[scope]}
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.decisions}>
        {decisions.map((decision) => (
          <Button
            key={decision}
            size="sm"
            variant={decision === "deny" ? "danger" : decision === "approve_once" ? "primary" : "secondary"}
            busy={busy === decision}
            disabled={busy !== null && busy !== decision}
            onClick={() => void decide(decision)}
          >
            {DECISION_LABELS[decision]}
          </Button>
        ))}
      </div>
      {more > 0 ? (
        <button type="button" className={styles.linkButton} onClick={onReviewAll}>
          {more} more {more === 1 ? "request" : "requests"} from this agent · Review all
        </button>
      ) : null}
    </div>
  );
}
