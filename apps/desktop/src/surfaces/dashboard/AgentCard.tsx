import {
  type ApprovalDecision,
  type ApprovalView,
  DISPLAY_QUALIFIER_LABEL,
  DISPLAY_STATUS_TONE,
  displayStatusOf,
  type ThreadSummary,
} from "@kalcode/protocol";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  ProviderMark,
  StatusChip,
} from "@kalcode/ui/components";
import { Archive, CircleCheck, FileDiff, GitBranch, Hourglass, MoreHorizontal, ShieldAlert } from "lucide-react";
import { type MouseEvent, memo, useEffect, useRef, useState } from "react";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import { MODE_LABELS } from "../permissions/labels.ts";
import { isWaitingForResources, presentThread } from "../threads/model.ts";
import styles from "./AgentCard.module.css";
import { ACTION_LABELS, availableActions, type ThreadAction } from "./data/actions.ts";
import { formatElapsed } from "./data/format.ts";
import { InlineApproval } from "./InlineApproval.tsx";

export interface AgentCardProps {
  thread: ThreadSummary;
  now: number;
  /** Pending approval requests from this thread, oldest first. */
  approvals: readonly ApprovalView[];
  /** The action in flight for this thread, if any. */
  pendingAction: ThreadAction | undefined;
  onFocus: (thread: ThreadSummary) => void;
  onAction: (thread: ThreadSummary, action: Exclude<ThreadAction, "open">) => void;
  onDecide: (requestId: string, decision: ApprovalDecision) => Promise<unknown>;
  onReviewApprovals: () => void;
  /** Present when this build can show a thread's changes (a diff surface). */
  onViewChanges?: (thread: ThreadSummary) => void;
  /**
   * An archived thread, shown read-only: no focus, actions or approvals, only Unarchive
   * (`onAction(thread, "unarchive")`).
   */
  archived?: boolean;
  headingLevel?: 3 | 4;
}

/** "Started 18 min ago" from the thread's real creation time; null when it can't be read. */
export function startedText(createdAt: string, now: number): string | null {
  const started = Date.parse(createdAt);
  if (Number.isNaN(started)) return null;
  const ms = now - started;
  return ms < 60_000 ? "Started just now" : `Started ${formatElapsed(ms)} ago`;
}

/** What the thread is doing, from structured runtime state only (never model prose). */
function activityLine(thread: ThreadSummary): string {
  const display = displayStatusOf(thread.status);
  if (display.status === "failed" && thread.error) return thread.error.message;
  if (thread.currentActivity) return thread.currentActivity;
  // A launch held for system resources is not "waiting on another task": say what the runtime said.
  if (isWaitingForResources(thread) && thread.error) return thread.error.message;
  if (display.qualifier) return DISPLAY_QUALIFIER_LABEL[display.qualifier];
  return "No current activity reported";
}

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, a, input, [role='menuitem'], [role='group']") !== null;
}

/**
 * One agent (thread) on the Dashboard: provider, name, workspace, account and branch, what it is doing now,
 * its status, permission mode and last activity. PERMISSION REQUIRED carries the inline approval;
 * DONE is marked "Completed" with its follow-ups. Clicking the card focuses the thread's pane.
 */
export const AgentCard = memo(function AgentCard({
  thread,
  now,
  approvals,
  pendingAction,
  onFocus,
  onAction,
  onDecide,
  onReviewApprovals,
  onViewChanges,
  archived = false,
  headingLevel = 3,
}: AgentCardProps) {
  const display = displayStatusOf(thread.status);
  // The runtime holds this thread's launch for system resources (its `waiting_for_resources`
  // error), so the shared "waiting on another task" qualifier would be untrue. Same words and
  // tone as the Threads surface.
  const resourceWait = isWaitingForResources(thread) ? presentThread(thread) : null;
  const tone = resourceWait?.tone ?? DISPLAY_STATUS_TONE[display.status];
  // The provider account the thread runs on (text, never a credential), e.g. "Gemini B".
  const accountLabel = thread.accountLabel?.trim() || null;
  const [confirmStop, setConfirmStop] = useState(false);
  const stopRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  // The menu returns focus to its trigger on close; Stop… moves it to the confirmation instead.
  const confirmFromMenu = useRef(false);
  const nameId = `agent-${thread.id}-name`;
  const Heading = `h${headingLevel}` as const;

  // A status that changes while the card is on screen gets a brief transition (not on first paint).
  const firstStatus = useRef(thread.status);
  const changed = firstStatus.current !== thread.status;

  useEffect(() => {
    if (confirmStop) stopRef.current?.focus();
  }, [confirmStop]);

  const actions = archived
    ? []
    : (availableActions(thread.status).filter((a) => a !== "open") as Exclude<ThreadAction, "open">[]);
  const request = archived ? undefined : approvals[0];
  const done = !archived && display.status === "done";
  const actionNeeded = !archived && display.status === "permission_required";
  const failed = display.status === "failed";
  const canViewChanges = done && onViewChanges !== undefined && (thread.filesChanged ?? 0) > 0;
  const started = startedText(thread.createdAt, now);

  const onCardClick = (event: MouseEvent<HTMLElement>) => {
    if (archived || isInteractive(event.target)) return;
    if (window.getSelection()?.toString()) return;
    onFocus(thread);
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the name button is the keyboard path; the card is a larger mouse target.
    <article
      className={styles.card}
      aria-labelledby={nameId}
      data-thread-id={thread.id}
      data-tone={tone}
      data-status={display.status}
      data-changed={changed || undefined}
      data-archived={archived || undefined}
      aria-busy={pendingAction ? true : undefined}
      onClick={onCardClick}
    >
      {/* DONE and PERMISSION REQUIRED carry their status in a band (glyph + words) instead of a chip. */}
      {archived ? (
        <p className={styles.band} data-kind="archived">
          <Archive aria-hidden="true" className={styles.bandGlyph} />
          <span>Archived</span>
          {thread.archivedAt ? (
            <time className={styles.bandDetail} dateTime={thread.archivedAt} title={formatAbsolute(thread.archivedAt)}>
              {formatRelative(thread.archivedAt, now)}
            </time>
          ) : null}
        </p>
      ) : done ? (
        <p className={styles.band} data-kind="done">
          <CircleCheck aria-hidden="true" className={styles.bandGlyph} />
          <span>Completed</span>
        </p>
      ) : actionNeeded ? (
        <p className={styles.band} data-kind="action">
          <ShieldAlert aria-hidden="true" className={styles.bandGlyph} />
          <span>Action needed</span>
          <span className={styles.bandDetail}>Permission required</span>
        </p>
      ) : null}

      <header className={styles.head}>
        <ProviderMark
          provider={thread.providerId}
          name={thread.providerName}
          detail={thread.model ?? undefined}
          size="sm"
          tile
          className={styles.provider}
        />
        {done || actionNeeded ? null : (
          <StatusChip
            status={display.status}
            qualifier={resourceWait ? null : display.qualifier}
            label={resourceWait?.label}
            tone={resourceWait?.tone}
            icon={resourceWait ? Hourglass : undefined}
            size="sm"
            className={styles.status}
          />
        )}
      </header>

      <Heading className={styles.name} id={nameId}>
        {archived ? (
          <span className={styles.nameText} title={thread.name}>
            {thread.name}
          </span>
        ) : (
          <button type="button" className={styles.nameButton} onClick={() => onFocus(thread)} title={thread.name}>
            {thread.name}
          </button>
        )}
      </Heading>

      <p className={styles.where}>
        <span className={styles.workspace}>{thread.workspaceName}</span>
        {accountLabel ? (
          <span className={styles.account} title={`Account: ${accountLabel}`}>
            <span className="visually-hidden">account </span>
            {accountLabel}
          </span>
        ) : null}
        {thread.branch ? (
          <span className={styles.branch}>
            <GitBranch aria-hidden="true" className={styles.branchGlyph} />
            <span className="visually-hidden">branch </span>
            {thread.branch}
          </span>
        ) : null}
      </p>

      <p className={styles.activity} data-failed={failed || undefined} title={activityLine(thread)}>
        {activityLine(thread)}
      </p>

      {actionNeeded && request ? (
        <InlineApproval
          request={request}
          more={approvals.length - 1}
          onDecide={onDecide}
          onReviewAll={onReviewApprovals}
        />
      ) : null}

      {archived ? (
        <div className={styles.followUps}>
          <Button
            size="sm"
            variant="secondary"
            busy={pendingAction === "unarchive"}
            aria-label={`Unarchive ${thread.name}`}
            onClick={() => onAction(thread, "unarchive")}
          >
            Unarchive
          </Button>
        </div>
      ) : done ? (
        <div className={styles.followUps}>
          <Button size="sm" variant="secondary" onClick={() => onFocus(thread)}>
            Open
          </Button>
          {canViewChanges ? (
            <Button size="sm" variant="ghost" icon={<FileDiff />} onClick={() => onViewChanges?.(thread)}>
              View changes
            </Button>
          ) : null}
        </div>
      ) : failed && actions.includes("retry") ? (
        <div className={styles.followUps}>
          <Button
            size="sm"
            variant="secondary"
            busy={pendingAction === "retry"}
            onClick={() => onAction(thread, "retry")}
          >
            Retry
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onFocus(thread)}>
            Open
          </Button>
        </div>
      ) : display.status === "waiting_for_you" ? (
        <div className={styles.followUps}>
          <Button size="sm" variant="secondary" onClick={() => onFocus(thread)}>
            Reply
          </Button>
        </div>
      ) : null}

      {confirmStop ? (
        // biome-ignore lint/a11y/useSemanticElements: a labelled group of buttons, not form fields.
        <div className={styles.confirm} role="group" aria-label={`Stop ${thread.name}?`}>
          <p className={styles.confirmText}>Stop this agent? Its process ends; you can resume it later.</p>
          <div className={styles.confirmActions}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfirmStop(false);
                menuRef.current?.focus();
              }}
            >
              Cancel
            </Button>
            <Button
              ref={stopRef}
              size="sm"
              variant="danger"
              busy={pendingAction === "stop"}
              onClick={() => {
                setConfirmStop(false);
                onAction(thread, "stop");
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setConfirmStop(false);
                  menuRef.current?.focus();
                }
              }}
            >
              Stop agent
            </Button>
          </div>
        </div>
      ) : null}

      <footer className={styles.foot}>
        <Badge tone={thread.permissionMode === "bypass" ? "danger" : "outline"} className={styles.mode}>
          <span className="visually-hidden">Permission mode </span>
          {MODE_LABELS[thread.permissionMode]}
        </Badge>
        {thread.filesChanged ? (
          <span className={styles.meta}>
            {thread.filesChanged} {thread.filesChanged === 1 ? "file" : "files"}
          </span>
        ) : null}
        {started ? (
          <time
            className={styles.meta}
            data-kind="started"
            dateTime={thread.createdAt}
            title={`Started ${formatAbsolute(thread.createdAt)}`}
          >
            {started}
          </time>
        ) : null}
        <time
          className={styles.meta}
          data-kind="last-activity"
          dateTime={thread.lastActivityAt}
          title={formatAbsolute(thread.lastActivityAt)}
        >
          <span className="visually-hidden">Last activity </span>
          {formatRelative(thread.lastActivityAt, now)}
        </time>
        {actions.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                ref={menuRef}
                size="sm"
                className={styles.more}
                label={`More actions for ${thread.name}`}
                icon={<MoreHorizontal />}
                busy={pendingAction !== undefined && pendingAction !== "retry"}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                if (!confirmFromMenu.current) return;
                confirmFromMenu.current = false;
                event.preventDefault();
                stopRef.current?.focus();
              }}
            >
              <DropdownMenuItem onSelect={() => onFocus(thread)}>Open</DropdownMenuItem>
              {actions.map((action) =>
                action === "stop" ? (
                  <DropdownMenuItem
                    key={action}
                    tone="danger"
                    onSelect={() => {
                      confirmFromMenu.current = true;
                      setConfirmStop(true);
                    }}
                  >
                    Stop…
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem key={action} onSelect={() => onAction(thread, action)}>
                    {ACTION_LABELS[action]}
                  </DropdownMenuItem>
                ),
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </footer>
    </article>
  );
});
