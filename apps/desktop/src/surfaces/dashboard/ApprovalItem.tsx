import type { ApprovalDecision, ApprovalRequest, ThreadSummary } from "@kalcode/protocol";
import { isRemoteConsequential } from "@kalcode/protocol";
import { Badge, Button, Kbd } from "@kalcode/ui/components";
import { type KeyboardEvent, useId } from "react";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import styles from "./ApprovalItem.module.css";
import {
  describeAction,
  PERMISSION_MODE_HINTS,
  PERMISSION_MODE_LABELS,
  providerName,
  SCOPE_LABELS,
} from "./data/format.ts";

interface ApprovalItemProps {
  request: ApprovalRequest;
  /** The requesting thread, when its summary is available. */
  thread: ThreadSummary | undefined;
  busy: boolean;
  /** Plays the arrival motion (the request arrived while the Dashboard was open). */
  arrived: boolean;
  now: number;
  onDecide: (decision: ApprovalDecision) => void;
}

const SHORTCUTS: Record<string, ApprovalDecision> = {
  a: "approve_once",
  t: "approve_for_thread",
  d: "deny",
};

/**
 * One pending approval request: what is asked, by whom, where and under which mode, with the
 * policy's reason. Dashboard-specific; may be unified with Z4's PermissionPrompt at integration.
 *
 * Keyboard: the request is focusable; with focus on it, A approves once, T allows for the thread
 * and D denies. Tab reaches the buttons.
 */
export function ApprovalItem({ request, thread, busy, arrived, now, onDecide }: ApprovalItemProps) {
  const id = useId();
  const detail = describeAction(request.action.action);
  const approvable = request.decision.approvable;
  const leavesMachine = request.decision.scopes.some(isRemoteConsequential);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Only when the request itself has focus, so a letter typed while a button is focused never decides.
    if (event.target !== event.currentTarget) return;
    if (busy || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const decision = SHORTCUTS[event.key.toLowerCase()];
    if (!decision || (!approvable && decision !== "deny")) return;
    event.preventDefault();
    onDecide(decision);
  };

  return (
    <article
      className={styles.item}
      data-arrived={arrived || undefined}
      data-busy={busy || undefined}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-meta ${id}-keys`}
      aria-keyshortcuts={approvable ? "A T D" : "D"}
      aria-busy={busy || undefined}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the request is focusable so its keyboard shortcuts work.
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-approval-id={request.id}
    >
      <div className={styles.head}>
        <div className={styles.what}>
          <h3 id={`${id}-title`} className={styles.title}>
            {request.action.summary}
          </h3>
          <p className={styles.kind}>
            {detail.kind}
            {leavesMachine ? <Badge tone="danger">Leaves this machine</Badge> : null}
          </p>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" size="sm" onClick={() => onDecide("deny")} disabled={busy}>
            Deny
          </Button>
          {approvable ? (
            <>
              <Button size="sm" onClick={() => onDecide("approve_for_thread")} disabled={busy}>
                Allow for thread
              </Button>
              <Button variant="primary" size="sm" onClick={() => onDecide("approve_once")} busy={busy}>
                Approve once
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {detail.target ? (
        <pre className={styles.target}>
          <code>{detail.target}</code>
          {detail.context ? <span className={styles.context}>in {detail.context}</span> : null}
        </pre>
      ) : null}

      <dl id={`${id}-meta`} className={styles.meta}>
        <div>
          <dt>Thread</dt>
          <dd>{thread?.name ?? "Unknown thread"}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{thread?.providerName ?? providerName(request.action.providerId)}</dd>
          {thread?.model ? <dd className={styles.sub}>{thread.model}</dd> : null}
        </div>
        <div>
          <dt>Workspace</dt>
          <dd>{thread?.workspaceName ?? "Unknown workspace"}</dd>
          {thread?.branch ? <dd className={styles.sub}>{thread.branch}</dd> : null}
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{PERMISSION_MODE_LABELS[request.permissionMode]}</dd>
          <dd className={styles.sub}>{PERMISSION_MODE_HINTS[request.permissionMode]}</dd>
        </div>
      </dl>

      <div className={styles.foot}>
        <p className={styles.reason}>
          {request.decision.scopes.length > 0 ? (
            <span className={styles.scopes}>
              {request.decision.scopes.map((scope) => (
                <Badge key={scope} tone="outline">
                  {SCOPE_LABELS[scope]}
                </Badge>
              ))}
            </span>
          ) : null}
          <span>
            {approvable ? request.decision.reason : `${request.decision.reason} A rule forbids approving it.`}
          </span>
        </p>
        <p className={styles.when}>
          <span id={`${id}-keys`} className={styles.keys}>
            {approvable ? (
              <>
                <Kbd>A</Kbd> approve once <Kbd>T</Kbd> allow for thread <Kbd>D</Kbd> deny
              </>
            ) : (
              <>
                <Kbd>D</Kbd> deny
              </>
            )}
          </span>
          <time dateTime={request.action.requestedAt} title={formatAbsolute(request.action.requestedAt)}>
            Asked {formatRelative(request.action.requestedAt, now)}
          </time>
        </p>
      </div>
    </article>
  );
}
