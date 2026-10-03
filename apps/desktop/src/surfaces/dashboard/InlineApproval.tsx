import type { ApprovalDecision, ApprovalView } from "@kalcode/protocol";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@kalcode/ui/components";
import { ChevronDown, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { actionDetail, DECISION_LABELS, SCOPE_LABELS, scopeTone } from "../permissions/labels.ts";
import styles from "./AgentCard.module.css";

/**
 * The approval answers, in the app's order (Z4 `PROMPT_DECISIONS`). On a card the two common
 * answers sit inline (Deny · Approve once) and the broader grants (Allow for workspace · Allow for
 * thread) wait in a More menu, so the row never wraps. Only the answers the engine allows for this
 * request render (remote-consequential requests offer Deny and Approve once).
 */
const INLINE: readonly ApprovalDecision[] = ["deny", "approve_once"];
const MORE: readonly ApprovalDecision[] = ["approve_for_workspace", "approve_for_thread"];

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
export function InlineApproval({ request, more: moreRequests, onDecide, onReviewAll }: InlineApprovalProps) {
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const detail = actionDetail(request.action.action);
  const title = request.action.summary || detail || "An agent wants to act";
  const inline = INLINE.filter((decision) => request.allowedDecisions.includes(decision));
  const more = MORE.filter((decision) => request.allowedDecisions.includes(decision));
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
        {inline.map((decision) => (
          <Button
            key={decision}
            size="sm"
            variant={decision === "deny" ? "danger" : "primary"}
            busy={busy === decision}
            disabled={busy !== null && busy !== decision}
            onClick={() => void decide(decision)}
          >
            {DECISION_LABELS[decision]}
          </Button>
        ))}
        {more.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className={styles.decisionMore}
                busy={busy !== null && more.includes(busy)}
                disabled={busy !== null && !more.includes(busy)}
              >
                More
                <ChevronDown aria-hidden="true" className={styles.decisionMoreGlyph} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {more.map((decision) => (
                <DropdownMenuItem key={decision} onSelect={() => void decide(decision)}>
                  {DECISION_LABELS[decision]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {moreRequests > 0 ? (
        <button type="button" className={styles.linkButton} onClick={onReviewAll}>
          {moreRequests} more {moreRequests === 1 ? "request" : "requests"} from this agent · Review all
        </button>
      ) : null}
    </div>
  );
}
