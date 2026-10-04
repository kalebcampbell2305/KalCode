import {
  type ApprovalDecision,
  type ApprovalView,
  DISPLAY_QUALIFIER_LABEL,
  DISPLAY_STATUS_TONE,
  displayStatusOf,
  type ThreadSummary,
  type ThreadWorktreeState,
} from "@kalcode/protocol";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  ProviderGlyph,
} from "@kalcode/ui/components";
import {
  Archive,
  ArrowUp,
  ChevronDown,
  Clock3,
  FolderGit2,
  GitBranch,
  GitMerge,
  MoreHorizontal,
  X,
} from "lucide-react";
import { type MouseEvent, memo, useEffect, useId, useRef, useState } from "react";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import { MODE_LABELS } from "../permissions/labels.ts";
import { isWaitingForResources, presentThread } from "../threads/model.ts";
import styles from "./AgentCard.module.css";
import { ACTION_LABELS, availableActions, type ThreadAction } from "./data/actions.ts";
import { fleetGroupOf } from "./data/board.ts";
import { formatElapsed, providerName, runDurationMs } from "./data/format.ts";
import { STATUS_META } from "./data/status.ts";
import { CommitChanges } from "./fleet/CommitChanges.tsx";
import type { MergeReadiness } from "./fleet/fleetModel.ts";
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
  /**
   * An archived thread, shown read-only: no focus, actions or approvals, only Unarchive
   * (`onAction(thread, "unarchive")`).
   */
  archived?: boolean;
  headingLevel?: 3 | 4;
  /** Git facts of the agent's own worktree, when it has one. */
  worktree?: ThreadWorktreeState;
  /** Whether the agent's worktree is ready to merge, and why not. */
  readiness?: MergeReadiness;
  /** Called with fresh worktree facts after the person commits the agent's changes. */
  onCommitted?: (state: ThreadWorktreeState) => void;
  /** The card shows its details (remembered by the Fleet). */
  expanded?: boolean;
  onToggleExpanded?: (threadId: string) => void;
  /** One-click remove for a failed, finished or stopped agent (the X); absent: not offered. */
  onDismiss?: (thread: ThreadSummary) => void;
}

/**
 * An isolated agent's leftover changes can be committed only once it can no longer change files:
 * stopped, finished or failed (the native command refuses the same set of busy states).
 */
const COMMITTABLE: ReadonlySet<ThreadSummary["status"]> = new Set([
  "idle",
  "completed",
  "failed",
  "interrupted",
  "offline",
]);

/** "Started 18 min ago" from the thread's real creation time; null when it can't be read. */
export function startedText(createdAt: string, now: number): string | null {
  const started = Date.parse(createdAt);
  if (Number.isNaN(started)) return null;
  const ms = now - started;
  return ms < 60_000 ? "Started just now" : `Started ${formatElapsed(ms)} ago`;
}

/** The card's one status word or phrase, from runtime state only. */
export function stateLabel(thread: ThreadSummary, ready: boolean): string {
  if (ready) return "Ready to merge";
  const shown = presentThread(thread);
  if (shown.label === "Waiting for system resources" || shown.label === "Last turn failed") return shown.label;
  if (thread.status === "interrupted") return shown.label === "Not started" ? "Not started" : "Stopped";
  if (thread.status === "waiting_for_dependency") return "Blocked";
  if (thread.status === "completed") return "Done";
  const display = displayStatusOf(thread.status).status;
  if (display === "working") return "Working";
  return STATUS_META[thread.status].label;
}

/** What the thread is doing, from structured runtime state only (never model prose). */
function activityLine(
  thread: ThreadSummary,
  approval: ApprovalView | undefined,
  readiness: MergeReadiness | undefined,
): string {
  const display = displayStatusOf(thread.status);
  if (readiness?.ready) {
    return `${readiness.ahead} ${readiness.ahead === 1 ? "commit" : "commits"} ahead of ${readiness.base ?? "base"} · merges cleanly`;
  }
  if (display.status === "failed" && thread.error) return thread.error.message;
  if (display.status === "permission_required" && approval) {
    return `Wants to ${approval.action.summary ? approval.action.summary.charAt(0).toLowerCase() + approval.action.summary.slice(1) : "act"}`;
  }
  if (thread.currentActivity) return thread.currentActivity;
  // A launch held for system resources is not "waiting on another task": say what the runtime said.
  if (isWaitingForResources(thread) && thread.error) return thread.error.message;
  if (display.qualifier) {
    const text = DISPLAY_QUALIFIER_LABEL[display.qualifier];
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return "No current activity reported";
}

function isInteractive(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("button, a, input, textarea, [role='menuitem'], [role='group'], [data-details]") !== null
  );
}

/**
 * One coding agent in the Agent Fleet: who it runs as (account), its task, its state and how
 * long it has run; the provider and workspace; model, effort and branch; and what it is doing now
 * (or why it needs you). Common actions sit on the card; the rest are in its menu, and its
 * details expand in place. Clicking the card opens the agent's terminal in Code.
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
  archived = false,
  headingLevel = 3,
  worktree,
  readiness,
  onCommitted,
  expanded = false,
  onToggleExpanded,
  onDismiss,
}: AgentCardProps) {
  const display = displayStatusOf(thread.status);
  const resourceWait = isWaitingForResources(thread) ? presentThread(thread) : null;
  const ready = !archived && readiness?.ready === true;
  const tone = ready ? "working" : (resourceWait?.tone ?? DISPLAY_STATUS_TONE[display.status]);
  const group = fleetGroupOf(thread.status);
  // The provider account the agent runs on (text, never a credential), e.g. "Claude A".
  // SEAM(kalcode-e4): show this account's usage via useAccountUsage(thread.providerAccountId) once it lands.
  const accountLabel = thread.accountLabel?.trim() || null;
  const provider = thread.providerName || providerName(thread.providerId);
  const [confirmStop, setConfirmStop] = useState(false);
  const stopRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  // The menu returns focus to its trigger on close; Stop… moves it to the confirmation instead.
  const confirmFromMenu = useRef(false);
  const nameId = `agent-${thread.id}-name`;
  const detailsId = useId();
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
  const actionNeeded = !archived && display.status === "permission_required";
  const failed = display.status === "failed";
  const elapsedMs = runDurationMs(thread, now);
  const started = startedText(thread.createdAt, now);
  const activity = activityLine(thread, request, archived ? undefined : readiness);
  const label = archived ? "Archived" : stateLabel(thread, ready);
  const resumable = actions.includes("resume");
  const dirty = worktree ? worktree.changed + worktree.untracked : 0;

  const onCardClick = (event: MouseEvent<HTMLElement>) => {
    if (archived || isInteractive(event.target)) return;
    if (window.getSelection()?.toString()) return;
    onFocus(thread);
  };

  // The one primary follow-up each state needs, on the card.
  let primary: { label: string; run: () => void; busy?: boolean; aria?: string } | null = null;
  if (!archived) {
    if (failed && actions.includes("retry")) {
      primary = { label: "Retry", run: () => onAction(thread, "retry"), busy: pendingAction === "retry" };
    } else if (display.status === "waiting_for_you") {
      primary = { label: "Reply", run: () => onFocus(thread) };
    } else if (resumable) {
      primary = {
        label: "Resume",
        run: () => onAction(thread, "resume"),
        busy: pendingAction === "resume",
        aria: `Resume ${thread.name}`,
      };
    } else if (group === "done" || ready) {
      primary = { label: "Open", run: () => onFocus(thread), aria: `Open ${thread.name}` };
    }
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the name button is the keyboard path; the card is a larger mouse target.
    <article
      className={styles.card}
      aria-labelledby={nameId}
      data-thread-id={thread.id}
      data-tone={tone}
      data-status={display.status}
      data-group={group}
      data-changed={changed || undefined}
      data-archived={archived || undefined}
      data-ready={ready || undefined}
      data-expanded={expanded || undefined}
      aria-busy={pendingAction ? true : undefined}
      onClick={onCardClick}
    >
      <header className={styles.top}>
        <span className={styles.signal} data-tone={archived ? "muted" : tone} aria-hidden="true" />
        {accountLabel ? (
          <span className={styles.who} title={`Account: ${accountLabel}`}>
            <span className="visually-hidden">account </span>
            {accountLabel}
          </span>
        ) : (
          <span className={styles.who}>{provider}</span>
        )}
        <span className={styles.state} data-tone={archived ? "muted" : tone} data-kind="state">
          {archived ? <Archive aria-hidden="true" className={styles.stateGlyph} /> : null}
          {ready ? <GitMerge aria-hidden="true" className={styles.stateGlyph} /> : null}
          {label}
        </span>
        {elapsedMs !== null && !archived ? (
          <time
            className={styles.elapsed}
            data-kind="elapsed"
            dateTime={thread.createdAt}
            title={`${started ?? "Started"} · ${formatAbsolute(thread.createdAt)}`}
          >
            <Clock3 aria-hidden="true" />
            <span className="visually-hidden">Running time </span>
            {elapsedMs < 60_000 ? "<1 min" : formatElapsed(elapsedMs)}
          </time>
        ) : null}
        {archived && thread.archivedAt ? (
          <time className={styles.elapsed} dateTime={thread.archivedAt} title={formatAbsolute(thread.archivedAt)}>
            {formatRelative(thread.archivedAt, now)}
          </time>
        ) : null}
        {onDismiss && !archived ? (
          <IconButton
            size="sm"
            className={styles.dismiss}
            label={`Clear ${thread.name}`}
            title="Clear from the Fleet (restore it from Archived)"
            icon={<X />}
            busy={pendingAction === "archive"}
            onClick={() => onDismiss(thread)}
          />
        ) : null}
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
        <ProviderGlyph provider={thread.providerId} size="xs" className={styles.whereGlyph} />
        <span className={styles.providerName}>{provider}</span>
        <span className={styles.sep} aria-hidden="true">
          ·
        </span>
        <span className={styles.workspace} title={thread.workspaceName}>
          {thread.workspaceName}
        </span>
      </p>

      {thread.model || thread.effort || thread.branch ? (
        <p className={styles.tech}>
          {thread.model ? <span className={styles.model}>{thread.model}</span> : null}
          {thread.effort ? (
            <span className={styles.effort}>
              <span className="visually-hidden">effort </span>
              {thread.effort}
            </span>
          ) : null}
          {thread.branch ? (
            <span
              className={styles.branch}
              title={thread.worktreeId ? `${thread.branch} · its own worktree and branch` : thread.branch}
            >
              {thread.worktreeId ? (
                <FolderGit2 aria-hidden="true" className={styles.branchGlyph} />
              ) : (
                <GitBranch aria-hidden="true" className={styles.branchGlyph} />
              )}
              <span className="visually-hidden">{thread.worktreeId ? "worktree branch " : "branch "}</span>
              <span className={styles.branchName}>{thread.branch}</span>
            </span>
          ) : null}
          {worktree?.ahead ? (
            <span
              className={styles.ahead}
              title={`${worktree.ahead} commits ahead of ${worktree.baseBranch ?? "base"}`}
            >
              <ArrowUp aria-hidden="true" />
              <span className="visually-hidden">commits ahead </span>
              {worktree.ahead}
            </span>
          ) : null}
        </p>
      ) : null}

      {/* The inline approval already says what the agent asks for; anything else, say it here. */}
      {actionNeeded && request ? null : (
        <p className={styles.activity} data-tone={tone} data-group={group} title={activity}>
          <span className={styles.activityText}>{activity}</span>
        </p>
      )}

      {actionNeeded && request ? (
        <InlineApproval
          request={request}
          more={approvals.length - 1}
          onDecide={onDecide}
          onReviewAll={onReviewApprovals}
        />
      ) : null}

      {/* Work an isolated agent left uncommitted: KalCode commits it on the agent's branch when asked. */}
      {!archived && worktree && dirty > 0 && COMMITTABLE.has(thread.status) ? (
        <div className={styles.followUps}>
          <CommitChanges thread={thread} worktree={worktree} onCommitted={onCommitted} />
        </div>
      ) : null}

      {/* A finished agent in its own worktree says what still stands between it and a merge. */}
      {!archived && readiness && !readiness.ready && (display.status === "done" || display.status === "idle") ? (
        <p className={styles.mergeNote}>
          <GitMerge aria-hidden="true" />
          <span>Not ready to merge: {readiness.reason}</span>
        </p>
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

      {expanded ? (
        <dl className={styles.details} id={detailsId} data-details>
          <div>
            <dt>Account</dt>
            <dd>{accountLabel ?? "Provider default"}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>
              {thread.model ?? "Provider default"}
              {thread.effort ? ` · ${thread.effort} effort` : ""}
            </dd>
          </div>
          <div>
            <dt>Runs in</dt>
            <dd>
              {thread.worktreeId
                ? `Its own worktree${worktree?.baseBranch ? ` (from ${worktree.baseBranch})` : ""}`
                : "The workspace folder"}
            </dd>
          </div>
          <div>
            <dt>Permissions</dt>
            <dd>
              <span className="visually-hidden">Permission mode </span>
              {MODE_LABELS[thread.permissionMode]}
            </dd>
          </div>
          {thread.filesChanged !== null ? (
            <div>
              <dt>Files</dt>
              <dd>
                {thread.filesChanged} {thread.filesChanged === 1 ? "file" : "files"} touched
                {dirty > 0 ? ` · ${dirty} uncommitted` : ""}
              </dd>
            </div>
          ) : null}
          {started ? (
            <div>
              <dt>Started</dt>
              <dd>
                <time
                  data-kind="started"
                  dateTime={thread.createdAt}
                  title={`Started ${formatAbsolute(thread.createdAt)}`}
                >
                  {started}
                </time>
              </dd>
            </div>
          ) : null}
          {thread.error ? (
            <div>
              <dt>Error</dt>
              <dd className={styles.detailError}>{thread.error.message}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {archived ? (
        <footer className={styles.foot}>
          <Button
            size="sm"
            variant="secondary"
            busy={pendingAction === "unarchive"}
            aria-label={`Unarchive ${thread.name}`}
            onClick={() => onAction(thread, "unarchive")}
          >
            Unarchive
          </Button>
        </footer>
      ) : (
        <footer className={styles.foot}>
          {primary ? (
            <Button
              size="sm"
              variant={failed || display.status === "waiting_for_you" ? "primary" : "secondary"}
              className={styles.primary}
              busy={primary.busy}
              aria-label={primary.aria}
              onClick={primary.run}
            >
              {primary.label}
            </Button>
          ) : null}
          {thread.permissionMode === "bypass" ? (
            <span className={styles.bypass} title="Bypass: runs without asking">
              Bypass
            </span>
          ) : null}
          {thread.filesChanged ? (
            <span className={styles.meta} data-kind="files">
              {thread.filesChanged} {thread.filesChanged === 1 ? "file" : "files"}
            </span>
          ) : null}
          <time
            className={styles.meta}
            data-kind="last-activity"
            dateTime={thread.lastActivityAt}
            title={`Last activity ${formatAbsolute(thread.lastActivityAt)}`}
          >
            <span className="visually-hidden">Last activity </span>
            {formatRelative(thread.lastActivityAt, now)}
          </time>
          <span className={styles.tools}>
            {actions.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    ref={menuRef}
                    size="sm"
                    className={styles.tool}
                    label={`More actions for ${thread.name}`}
                    icon={<MoreHorizontal />}
                    busy={pendingAction !== undefined && pendingAction !== "retry" && pendingAction !== "resume"}
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
            {onToggleExpanded ? (
              <IconButton
                size="sm"
                className={styles.tool}
                label={expanded ? `Hide details for ${thread.name}` : `Show details for ${thread.name}`}
                aria-expanded={expanded}
                aria-controls={expanded ? detailsId : undefined}
                icon={<ChevronDown className={styles.chevron} data-open={expanded || undefined} />}
                onClick={() => onToggleExpanded(thread.id)}
              />
            ) : null}
          </span>
        </footer>
      )}
    </article>
  );
});
