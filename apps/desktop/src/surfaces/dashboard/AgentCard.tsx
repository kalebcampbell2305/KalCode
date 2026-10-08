import {
  AGENT_STATE_TEXT,
  AGENT_STATE_TONE,
  type ApprovalDecision,
  type ApprovalView,
  agentStateOf,
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
  Link2,
  MoreHorizontal,
  X,
} from "lucide-react";
import { type MouseEvent, memo, useEffect, useId, useRef, useState } from "react";
import { useOptionalChains } from "../../runtime/chains/useChains.tsx";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import type { AgentOverlap } from "../../runtime/ownership/model.ts";
import { FavoriteButton, useFavoriteMenuItems } from "../../shell/favorites/FavoriteActions.tsx";
import { MODE_LABELS } from "../permissions/labels.ts";
import { AccountUsageBadge } from "../providers/AccountUsageBadge.tsx";
import { useSessionIdentity } from "../providers/useSessionIdentity.ts";
import { isWaitingForResources, presentThread } from "../threads/model.ts";
import styles from "./AgentCard.module.css";
import { ACTION_LABELS, availableActions, type ThreadAction } from "./data/actions.ts";
import { fleetGroupOf } from "./data/board.ts";
import { useOptionalOwnership } from "./data/DashboardData.tsx";
import { formatElapsed, runDurationMs } from "./data/format.ts";
import { CommitChanges } from "./fleet/CommitChanges.tsx";
import type { MergeReadiness } from "./fleet/fleetModel.ts";
import { ClaimNote, OverlapNote } from "./fleet/OverlapNote.tsx";
import { InlineApproval } from "./InlineApproval.tsx";
import { AgentOutcome } from "./outcome/AgentOutcome.tsx";
import { useClock } from "./useNow.ts";

export interface AgentCardProps {
  thread: ThreadSummary;
  /** The time the card's relative texts read from; omitted, the card follows the shared clock. */
  now?: number;
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
  /** Other agents in the same project editing the same files (clicking one opens it). */
  overlaps?: readonly AgentOverlap[];
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

/**
 * The card's one status word, from the shared agent-state model (the same word every surface
 * shows for every provider). Merge readiness is the one refinement: a fact about the worktree.
 */
export function stateLabel(thread: ThreadSummary, ready: boolean): string {
  if (ready) return "Ready to merge";
  return AGENT_STATE_TEXT[agentStateOf(thread)];
}

/** What the thread is doing, from structured runtime state only (never model prose). */
function activityLine(
  thread: ThreadSummary,
  approval: ApprovalView | undefined,
  readiness: MergeReadiness | undefined,
): string {
  const display = displayStatusOf(thread.status, { resumable: thread.resumable });
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
  if (display.qualifierLabel) {
    const text = display.qualifierLabel;
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

/** Every text the card derives from `now`: the elapsed time, started, archived and last activity. */
function clockTexts({
  thread,
  now,
  archived = false,
}: Pick<AgentCardProps, "thread" | "archived"> & { now: number }): string {
  const elapsedMs = runDurationMs(thread, now);
  return [
    elapsedMs === null || archived ? "" : elapsedMs < 60_000 ? "<1 min" : formatElapsed(elapsedMs),
    startedText(thread.createdAt, now) ?? "",
    archived && thread.archivedAt ? formatRelative(thread.archivedAt, now) : "",
    formatRelative(thread.lastActivityAt, now),
  ].join("\n");
}

/**
 * A card given `now` re-renders for a new time only when a time it shows changes (each card's
 * whole menu subtree re-rendered every 30 s otherwise).
 */
export function sameAgentCardProps(prev: AgentCardProps, next: AgentCardProps): boolean {
  for (const key of Object.keys(next) as (keyof AgentCardProps)[]) {
    if (key !== "now" && !Object.is(prev[key], next[key])) return false;
  }
  for (const key of Object.keys(prev)) if (!(key in next)) return false;
  if (prev.now === next.now) return true;
  if (prev.now === undefined || next.now === undefined) return false;
  return clockTexts({ ...prev, now: prev.now }) === clockTexts({ ...next, now: next.now });
}

/**
 * One coding agent in the Agent Fleet: who it runs as (account), its task, its state and how
 * long it has run; the provider and workspace; model, effort and branch; and what it is doing now
 * (or why it needs you). Common actions sit on the card; the rest are in its menu, and its
 * details expand in place. Clicking the card opens the agent's terminal in Code.
 */
export const AgentCard = memo(function AgentCard({
  thread,
  now: givenNow,
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
  overlaps,
}: AgentCardProps) {
  // Following the shared clock, a tick re-renders this card only when one of its times changes
  // (the board and every card's menu subtree no longer re-render on each tick).
  const clock = useClock((at) => (givenNow === undefined ? clockTexts({ thread, now: at, archived }) : null));
  const now = givenNow ?? clock;
  const ownership = useOptionalOwnership();
  const claimName = (agentId: string) => ownership?.claims.get(agentId)?.name ?? null;
  const display = displayStatusOf(thread.status);
  // A handoff chain step shows its place compactly ("2/4"); its pane header says "Chain · Review 2/4".
  const chainStep = useOptionalChains()?.chainForOperation(thread.id) ?? null;
  const resourceWait = isWaitingForResources(thread) ? presentThread(thread) : null;
  const ready = !archived && readiness?.ready === true;
  const agentState = agentStateOf(thread);
  const tone = ready ? "working" : (resourceWait?.tone ?? AGENT_STATE_TONE[agentState]);
  const group = fleetGroupOf(thread);
  const identity = useSessionIdentity(thread);
  // A missing binding stays visibly distinct from an unmanaged provider session. The shared
  // account registry supplies current nicknames without a request from every Fleet card.
  const hasAccountIdentity = Boolean(thread.providerAccountId || thread.accountLabel?.trim());
  const accountLabel = hasAccountIdentity ? identity.accountName : null;
  const provider = identity.providerName;
  const [confirmStop, setConfirmStop] = useState(false);
  const stopRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  // The menu returns focus to its trigger on close; Stop… moves it to the confirmation instead.
  const confirmFromMenu = useRef(false);
  const nameId = `agent-${thread.id}-name`;
  const favoriteItems = useFavoriteMenuItems(
    { kind: "agent", id: thread.id, workspaceId: thread.workspaceId },
    thread.name,
  );
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
    : (availableActions(thread).filter((a) => a !== "open") as Exclude<ThreadAction, "open">[]);
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
  let primary: {
    label: string;
    run: () => void;
    busy?: boolean;
    aria?: string;
    action?: Exclude<ThreadAction, "open">;
  } | null = null;
  if (!archived) {
    if (failed && actions.includes("retry")) {
      primary = {
        label: "Retry",
        run: () => onAction(thread, "retry"),
        busy: pendingAction === "retry",
        action: "retry",
      };
    } else if (display.status === "waiting_for_you") {
      primary = { label: "Reply", run: () => onFocus(thread) };
    } else if (resumable) {
      primary = {
        label: "Resume",
        run: () => onAction(thread, "resume"),
        busy: pendingAction === "resume",
        aria: `Resume ${thread.name}`,
        action: "resume",
      };
    } else if (actions.includes("start_anyway")) {
      // A launch held for system resources: the real reason is on the card, and the person's
      // own override is one click away, as in the agent's pane.
      primary = {
        label: ACTION_LABELS.start_anyway,
        run: () => onAction(thread, "start_anyway"),
        busy: pendingAction === "start_anyway",
        aria: `Start ${thread.name} anyway`,
        action: "start_anyway",
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
      data-state={agentState}
      data-group={group}
      data-changed={changed || undefined}
      data-archived={archived || undefined}
      data-ready={ready || undefined}
      data-expanded={expanded || undefined}
      aria-busy={pendingAction ? true : undefined}
      onClick={onCardClick}
    >
      {/* Decoration on inert elements, not pseudo-elements (see AgentCard.module.css). */}
      <span className={styles.rail} aria-hidden="true" />
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
        {identity.account ? (
          <span className={styles.usage} data-agent-usage>
            <AccountUsageBadge account={identity.account} size="xs" interactive />
          </span>
        ) : null}
        <span className={styles.state} data-tone={archived ? "muted" : tone} data-kind="state">
          {archived ? <Archive aria-hidden="true" className={styles.stateGlyph} /> : null}
          {ready ? <GitMerge aria-hidden="true" className={styles.stateGlyph} /> : null}
          {label}
        </span>
        {chainStep ? (
          // Compact so the state chip keeps its words; the full place is in the label and tooltip.
          <span
            className={styles.chain}
            data-kind="chain"
            role="img"
            aria-label={`Chain step ${chainStep.step.position + 1} of ${chainStep.chain.steps.length}: ${chainStep.step.name}, ${chainStep.chain.name}`}
            title={`${chainStep.chain.name} · ${chainStep.step.name}, step ${chainStep.step.position + 1} of ${chainStep.chain.steps.length}`}
          >
            <Link2 aria-hidden="true" className={styles.stateGlyph} />
            {chainStep.step.position + 1}/{chainStep.chain.steps.length}
          </span>
        ) : null}
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

      {/* The pin follows the name, so the card's first stop is its name and the heading (the card's
          accessible name) holds only the name. An archived card is read-only: no pin. */}
      <div className={styles.titleRow}>
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
        {archived ? null : (
          <FavoriteButton
            target={{ kind: "agent", id: thread.id, workspaceId: thread.workspaceId }}
            title={thread.name}
          />
        )}
      </div>

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

      {identity.model.label || identity.effort.label || thread.branch ? (
        <p className={styles.tech} title={identity.detail} data-session-identity>
          <span className={styles.model} data-source={identity.model.source}>
            {identity.model.label}
          </span>
          <span className={styles.effort} data-source={identity.effort.source}>
            <span className="visually-hidden">reasoning </span>
            {identity.effort.label}
          </span>
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

      {/* What the work amounted to: agent → changed → tests → merge → release, each observed. */}
      {archived ? null : <AgentOutcome thread={thread} worktree={worktree} variant="card" />}

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

      {/* Another agent edits the same files: seen now, not at merge time. */}
      {!archived && overlaps && overlaps.length > 0 ? (
        <OverlapNote overlaps={overlaps} selfName={thread.name.trim() || thread.providerName} onFocus={onFocus} />
      ) : null}
      {!archived ? <ClaimNote claim={ownership?.claims.get(thread.id)} nameOf={claimName} /> : null}

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
            <dd title={identity.detail}>{identity.model.label}</dd>
          </div>
          <div>
            <dt>Reasoning</dt>
            <dd title={identity.detail}>{identity.effort.label}</dd>
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
              variant={
                failed || display.status === "waiting_for_you" || primary.action === "start_anyway"
                  ? "primary"
                  : "secondary"
              }
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
                    busy={
                      pendingAction !== undefined &&
                      pendingAction !== "retry" &&
                      pendingAction !== "resume" &&
                      pendingAction !== primary?.action
                    }
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
                  {favoriteItems.map((item) =>
                    "separator" in item ? null : (
                      <DropdownMenuItem key={item.id} icon={item.icon} onSelect={item.onSelect}>
                        {item.label}
                      </DropdownMenuItem>
                    ),
                  )}
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
      <span className={styles.horizon} aria-hidden="true" />
    </article>
  );
}, sameAgentCardProps);
