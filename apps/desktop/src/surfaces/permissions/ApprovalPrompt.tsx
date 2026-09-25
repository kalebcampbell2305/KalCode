import type { ApprovalDecision, ApprovalView } from "@kalcode/protocol";
import { PermissionPrompt, type PermissionPromptOption } from "@kalcode/ui/components";
import { useState } from "react";
import { formatRelative } from "../../runtime/describeEvent.ts";
import {
  actionDetail,
  DECISION_LABELS,
  MODE_LABELS,
  PROMPT_DECISIONS,
  SCOPE_LABELS,
  scopeTone,
  shortId,
  statusText,
} from "./labels.ts";

export interface ApprovalPromptProps {
  request: ApprovalView;
  /** Records the answer; resolves when done (null on failure). */
  onDecide: (requestId: string, decision: ApprovalDecision) => Promise<unknown>;
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

/**
 * The approval prompt for one request (directive §7.4): provider, thread, requested action,
 * workspace and mode, with Deny · Allow for workspace · Allow for thread · Approve once — only
 * the answers the engine allows for this request. Used by the approvals panel and the Dashboard.
 */
export function ApprovalPrompt({ request, onDecide, headingLevel = 3, className }: ApprovalPromptProps) {
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const context = request.context;
  const coverage = request.grantCoverage
    ? request.grantCoverage.charAt(0).toUpperCase() + request.grantCoverage.slice(1)
    : "This request";

  const options: PermissionPromptOption<ApprovalDecision>[] = PROMPT_DECISIONS.filter((decision) =>
    request.allowedDecisions.includes(decision),
  ).map((decision) => ({
    value: decision,
    label: DECISION_LABELS[decision],
    variant: decision === "deny" ? "danger" : decision === "approve_once" ? "primary" : "secondary",
    description:
      decision === "approve_for_thread"
        ? `${coverage}, in this thread until it stops (24 hours at most).`
        : decision === "approve_for_workspace"
          ? `${coverage}, in every thread of this workspace for 30 days.`
          : undefined,
  }));

  const decide = async (decision: ApprovalDecision) => {
    setBusy(decision);
    try {
      await onDecide(request.id, decision);
    } finally {
      setBusy(null);
    }
  };

  return (
    <PermissionPrompt<ApprovalDecision>
      id={request.id}
      title={request.action.summary || actionDetail(request.action.action) || "An agent wants to act"}
      detail={actionDetail(request.action.action)}
      reason={request.decision.reason}
      context={{
        // Requests from KalVoice (CA-1 non-thread origin) have no thread or provider of their own.
        provider:
          context?.providerName ??
          (request.action.providerId || (request.action.origin?.kind === "kalvoice" ? "KalVoice" : "None")),
        thread: context?.threadName ?? (request.action.threadId ? shortId("Thread", request.action.threadId) : "None"),
        workspace:
          context?.workspaceName ??
          (request.action.workspaceId ? shortId("Workspace", request.action.workspaceId) : "None"),
        mode: MODE_LABELS[request.permissionMode],
        modeTone: request.permissionMode === "bypass" ? "danger" : "neutral",
      }}
      scopes={request.decision.scopes.map((scope) => ({
        id: scope,
        label: SCOPE_LABELS[scope],
        tone: scopeTone(scope),
      }))}
      options={options}
      onDecide={(decision) => void decide(decision)}
      busy={busy}
      status={request.status}
      statusText={statusText(request)}
      requestedAt={formatRelative(request.createdAt)}
      headingLevel={headingLevel}
      className={className}
    />
  );
}
