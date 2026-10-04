import type { ApprovalDecision, PaneInfo, ThreadSummary } from "@kalcode/protocol";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
} from "@kalcode/ui/components";
import {
  Handshake,
  Info,
  MessageCircleQuestion,
  MoreHorizontal,
  PenLine,
  Play,
  RotateCcw,
  ShieldAlert,
  Square,
  Unplug,
} from "lucide-react";
import { type KeyboardEvent, memo, type RefObject, useEffect, useId, useRef, useState } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { ApprovalPrompt } from "../../permissions/ApprovalPrompt.tsx";
import { MODE_LABELS } from "../../permissions/labels.ts";
import { usePermissions } from "../../permissions/PermissionsProvider.tsx";
import { AccountUsageBadge } from "../../providers/AccountUsageBadge.tsx";
import { PaneAccountPicker, type PaneAccountPickerProps } from "./PaneAccountPicker.tsx";
import { PaneAccountSuggestion } from "./PaneAccountSuggestion.tsx";
import {
  PaneAccountChip,
  type PaneAccountIdentity,
  PaneStatusChip,
  PaneToolChip,
  paneAccountLabel,
  samePaneAccount,
} from "./PaneParts.tsx";
import styles from "./Panes.module.css";
import { PaneTerminal } from "./PaneTerminal.tsx";
import type { PaneChannel } from "./paneChannel.ts";
import {
  approvalAnnouncement,
  canResumePane,
  channelNote,
  endedSummary,
  isAnswerInProvider,
  paneEffort,
  paneInfoCopy,
  paneLabel,
  paneModel,
  paneStatus,
  providerIdentity,
} from "./paneLabels.ts";

export interface ProviderPaneProps {
  thread: ThreadSummary;
  info: PaneInfo | null;
  channel: PaneChannel;
  account: PaneAccountIdentity | null;
  theme: "light" | "dark";
  focusRequest: number;
  visible?: boolean;
  /** The canvas owns the single close confirmation. */
  closePending?: boolean;
  /** The thread changed (rename, stop, resume); the host refreshes its list. */
  onChanged?: (thread: ThreadSummary) => void;
  /** The pane isn't focused (Z7-W1): terminal output renders in batches. */
  throttled?: boolean;
  /** Pane-system controls (Z7-W1). Rendered only when provided. */
  onClose?: () => void;
  onMaximize?: () => void;
  onSplit?: () => void;
  /** Opens the governed agent-to-agent handoff flow for this coding terminal. */
  onHandOff?: () => void;
  onContinue?: PaneAccountPickerProps["onContinue"];
}

/**
 * One provider pane: the provider's real TUI in a terminal view, under one compact KalCode
 * header (Z7-15): "name · Account · model · effort · usage" and the agent's status. The canvas
 * tab strip already carries the provider mark, so the header never repeats it. Closing or hiding
 * the pane never stops the provider; only Stop does (Z7-14).
 */
export const ProviderPane = memo(function ProviderPane({
  thread,
  info,
  channel,
  account,
  theme,
  focusRequest,
  visible = true,
  closePending = false,
  onChanged,
  onClose,
  onMaximize,
  onSplit,
  onHandOff,
  onContinue,
  throttled = false,
}: ProviderPaneProps) {
  const { client } = useRuntime();
  const { pending, decide } = usePermissions();
  const [showInfo, setShowInfo] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  useEffect(() => {
    if (closePending) setConfirmStop(false);
  }, [closePending]);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [overlayDismissed, setOverlayDismissed] = useState<string | null>(null);
  const [localFocus, setLocalFocus] = useState(0);
  const overlayRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const confirmTextId = useId();
  const identity = providerIdentity(thread.providerId, thread.providerName);
  const status = paneStatus(thread.status);
  const note = channelNote(info);
  const running = info?.running ?? false;
  // Capability, not provider identity: only a session whose adapter reports that KalCode answers
  // its approvals shows a KalCode approval here. Every other pane answers in the provider's prompt.
  const kalcodeDecides = info?.kalcodeAnswersApprovals ?? false;
  const request = [...pending]
    .filter((r) => kalcodeDecides && r.action.threadId === thread.id && r.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const showOverlay = request !== undefined && overlayDismissed !== request.id;
  const providerAsking =
    !request && (thread.status === "waiting_for_permission" || isAnswerInProvider(thread.currentActivity));
  const accountLabel = account ? paneAccountLabel(account) : null;
  const resumable = canResumePane(thread.status, running);
  const tone = showOverlay ? "waiting" : status.tone;

  // A new run clears the last run's resume error.
  useEffect(() => {
    if (running) setResumeError(null);
  }, [running]);

  const focusTerminal = () => setLocalFocus((n) => n + 1);

  const cancelStop = () => {
    setConfirmStop(false);
    setStopError(null);
    focusTerminal();
  };

  const stop = async () => {
    setStopping(true);
    setStopError(null);
    try {
      onChanged?.(await client.stopThread(thread.id));
      setConfirmStop(false);
    } catch (error) {
      // Keep the bar open: the person sees why, and can try again or keep it running.
      setStopError(toKalCodeError(error).message);
    } finally {
      setStopping(false);
    }
  };

  const resume = async () => {
    setResuming(true);
    setResumeError(null);
    try {
      onChanged?.(await client.resumeThread(thread.id));
      focusTerminal();
    } catch (error) {
      setResumeError(toKalCodeError(error).message);
    } finally {
      setResuming(false);
    }
  };

  // Ctrl+Shift+E moves focus between the terminal and the approval (or the header). Code's own
  // window-level tab shortcuts (Ctrl+Shift+W, Ctrl+Tab) pass through untouched.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const ctrlShift = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
    if (ctrlShift && event.key.toLowerCase() === "e") {
      event.preventDefault();
      if (showOverlay && !overlayRef.current?.contains(document.activeElement)) overlayRef.current?.focus();
      else focusTerminal();
    }
  };

  const decideHere = (requestId: string, decision: ApprovalDecision) =>
    decide(requestId, decision).then((result) => {
      focusTerminal();
      return result;
    });

  return (
    <section
      className={styles.pane}
      aria-label={`${paneLabel(thread)}${accountLabel ? `, account ${accountLabel}` : ""}`}
      data-provider-pane={thread.id}
      data-tone={tone}
      onKeyDown={onKeyDown}
    >
      <PaneHeader
        thread={thread}
        providerName={identity.name}
        account={account}
        note={note}
        moreRef={moreRef}
        onRename={(renamed) => onChanged?.(renamed)}
        onStop={() => {
          setStopError(null);
          setConfirmStop(true);
        }}
        onInfo={() => setShowInfo((v) => !v)}
        onResume={resumable ? () => void resume() : undefined}
        canStop={running || !resumable}
        onMaximize={onMaximize}
        onSplit={onSplit}
        onHandOff={onHandOff}
        onContinue={onContinue}
      />
      {onContinue ? <PaneAccountSuggestion thread={thread} account={account} onContinue={onContinue} /> : null}
      {confirmStop && !closePending ? (
        <div
          className={styles.confirm}
          role="alertdialog"
          aria-label="Stop this provider"
          aria-describedby={confirmTextId}
          data-state={stopError ? "error" : undefined}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancelStop();
            }
          }}
        >
          <span className={styles.confirmCopy}>
            <span id={confirmTextId} className={styles.confirmText}>
              Stop {identity.name} in this pane? Its process ends; the conversation can be resumed later.
            </span>
            {stopError ? (
              <span className={styles.confirmError} role="alert">
                Couldn't stop {identity.name}: {stopError} Try again, or keep it running.
              </span>
            ) : null}
          </span>
          <span className={styles.confirmActions}>
            <Button size="sm" variant="ghost" onClick={cancelStop} autoFocus>
              Keep running
            </Button>
            <Button size="sm" variant="danger" busy={stopping} onClick={() => void stop()}>
              {stopError ? "Try again" : "Stop"}
            </Button>
          </span>
        </div>
      ) : null}
      <div className={styles.body}>
        <PaneTerminal
          channel={channel}
          threadId={thread.id}
          instanceId={info?.instanceId ?? null}
          terminalId={thread.terminalId}
          providerId={thread.providerId}
          providerAccountId={thread.providerAccountId}
          status={thread.status}
          errorMessage={thread.error?.message}
          providerPromptActive={providerAsking}
          label={`${thread.name} ${identity.name}${accountLabel ? ` ${accountLabel}` : ""} input`}
          running={running}
          focusRequest={focusRequest + localFocus}
          visible={visible}
          theme={theme}
          throttled={throttled}
        />
        {showOverlay && request ? (
          <section
            ref={overlayRef}
            className={styles.overlay}
            aria-label="KalCode approval for this pane"
            tabIndex={-1}
          >
            <div className={styles.overlayBar}>
              <ShieldAlert aria-hidden="true" />
              <span className={styles.overlayBarText}>KalCode is holding this tool call until you answer.</span>
              <Button size="sm" variant="ghost" onClick={() => setOverlayDismissed(request.id)}>
                Answer later
              </Button>
            </div>
            <div className={styles.overlayBody}>
              <ApprovalPrompt request={request} onDecide={decideHere} headingLevel={3} />
            </div>
          </section>
        ) : null}
        {showInfo ? (
          <PaneInfoPanel
            info={info}
            providerId={thread.providerId}
            providerName={identity.name}
            returnFocus={moreRef}
            onClose={() => setShowInfo(false)}
          />
        ) : null}
      </div>
      {/* New approvals are announced once, wherever focus is. */}
      <div className="visually-hidden" aria-live="assertive" aria-atomic="true">
        {showOverlay ? approvalAnnouncement(identity.name, thread.name) : ""}
      </div>
      {providerAsking ? (
        <div className={styles.banner} role="status">
          <MessageCircleQuestion aria-hidden="true" />
          {identity.name} is asking in the pane. Answer there.
        </div>
      ) : null}
      {resumable ? (
        <div className={styles.endedBar} data-pane-ended data-tone={thread.status === "failed" ? "failed" : "muted"}>
          <span className={styles.endedDot} aria-hidden="true" />
          <span className={styles.endedCopy}>
            <span
              className={styles.endedText}
              role="status"
              title={endedSummary(thread.status, identity.name, info?.exitCode ?? null, thread.error?.message ?? null)}
            >
              {endedSummary(thread.status, identity.name, info?.exitCode ?? null, thread.error?.message ?? null)}
            </span>
            {resumeError ? (
              <span className={styles.endedError} role="alert">
                Couldn't resume: {resumeError}
              </span>
            ) : null}
          </span>
          <span className={styles.endedActions}>
            <Button size="sm" variant="primary" icon={<Play />} busy={resuming} onClick={() => void resume()}>
              {resumeError ? "Try again" : "Resume"}
            </Button>
            {onClose ? (
              <Button size="sm" variant="ghost" onClick={onClose}>
                Close
              </Button>
            ) : null}
          </span>
        </div>
      ) : null}
    </section>
  );
}, sameProviderPaneProps);

/** The host resolves the account per render; compare it by value so the pane stays memoized. */
function sameProviderPaneProps(a: ProviderPaneProps, b: ProviderPaneProps): boolean {
  for (const key of Object.keys(b) as (keyof ProviderPaneProps)[]) {
    if (key === "account") continue;
    if (!Object.is(a[key], b[key])) return false;
  }
  return Object.keys(a).length === Object.keys(b).length && samePaneAccount(a.account, b.account);
}

interface PaneHeaderProps {
  thread: ThreadSummary;
  providerName: string;
  account: PaneAccountIdentity | null;
  note: ReturnType<typeof channelNote>;
  moreRef: RefObject<HTMLButtonElement | null>;
  onRename: (thread: ThreadSummary) => void;
  onStop: () => void;
  onInfo: () => void;
  /** Set when the agent ended and can be started again. */
  onResume?: () => void;
  canStop: boolean;
  onClose?: () => void;
  onMaximize?: () => void;
  onSplit?: () => void;
  onHandOff?: () => void;
  onContinue?: PaneAccountPickerProps["onContinue"];
}

function PaneHeader({
  thread,
  providerName,
  account,
  note,
  moreRef,
  onRename,
  onStop,
  onInfo,
  onResume,
  canStop,
  onClose,
  onMaximize,
  onSplit,
  onHandOff,
  onContinue,
}: PaneHeaderProps) {
  const { client } = useRuntime();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.name);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const titleRef = useRef<HTMLButtonElement>(null);
  // A menu item that moves focus elsewhere (rename field, info panel, stop bar) keeps it there.
  const keepMenuFocus = useRef(false);
  const bypass = thread.permissionMode === "bypass";
  const model = paneModel(thread);
  const effort = paneEffort(thread);

  useEffect(() => {
    if (!editing) setDraft(thread.name);
  }, [thread.name, editing]);

  const save = async () => {
    const name = draft.trim();
    if (!name || name === thread.name) {
      setError(null);
      setEditing(false);
      return;
    }
    try {
      onRename(await client.renameThread(thread.id, name));
      setError(null);
      setEditing(false);
      requestAnimationFrame(() => titleRef.current?.focus());
    } catch (cause) {
      setError(toKalCodeError(cause).message);
    }
  };

  const select = (action: () => void) => () => {
    keepMenuFocus.current = true;
    action();
  };

  const identityTitle = [
    `${providerName}${account ? ` · ${paneAccountLabel(account)}` : ""}`,
    model ? `Model ${model}` : "Provider default model",
    effort ? `${effort} effort` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <header className={styles.header}>
        <div className={styles.lead}>
          {editing ? (
            <>
              <label className="visually-hidden" htmlFor={inputId}>
                Agent name
              </label>
              <input
                id={inputId}
                className={styles.titleInput}
                value={draft}
                maxLength={80}
                // biome-ignore lint/a11y/noAutofocus: the person just chose to rename.
                autoFocus
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${inputId}-error` : undefined}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void save()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void save();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setDraft(thread.name);
                    setError(null);
                    setEditing(false);
                    requestAnimationFrame(() => titleRef.current?.focus());
                  }
                }}
              />
            </>
          ) : (
            <button
              ref={titleRef}
              type="button"
              className={styles.titleButton}
              title={`${thread.name} (click to rename)`}
              aria-label={`${thread.name}. Rename agent`}
              onClick={() => setEditing(true)}
            >
              <span className={styles.title}>{thread.name}</span>
            </button>
          )}
          <span className={styles.identity} title={identityTitle} data-pane-identity>
            <span className="visually-hidden">{providerName}</span>
            {onContinue ? (
              <PaneAccountPicker thread={thread} account={account} onContinue={onContinue} />
            ) : account ? (
              <PaneAccountChip account={account} />
            ) : null}
            {model && thread.providerId !== "cursor" ? (
              <span className={`${styles.seg} ${styles.model}`} data-pane-model>
                {model}
              </span>
            ) : null}
            {effort ? (
              <span className={`${styles.seg} ${styles.effort}`} data-pane-effort>
                {effort}
              </span>
            ) : null}
          </span>
          {account?.usageAccount ? (
            <span className={styles.usage} data-pane-usage>
              <AccountUsageBadge account={account.usageAccount} size="xs" interactive />
            </span>
          ) : null}
        </div>
        <div className={styles.meta}>
          {note ? (
            <span className={styles.note} data-tone={note.tone} data-pane-channel={note.tone} title={note.text}>
              {note.tone === "limited" ? <Unplug aria-hidden="true" /> : null}
              <span className={styles.noteText}>{note.text}</span>
            </span>
          ) : null}
          <span
            className={styles.mode}
            data-risky={bypass ? "true" : undefined}
            data-pane-mode={thread.permissionMode}
            title={`Permission mode: ${MODE_LABELS[thread.permissionMode]}`}
          >
            {bypass ? <ShieldAlert aria-hidden="true" /> : null}
            <span className="visually-hidden">Permission mode </span>
            <span>{MODE_LABELS[thread.permissionMode]}</span>
          </span>
          <PaneToolChip status={thread.status} activity={thread.currentActivity} />
          <PaneStatusChip status={thread.status} />
          {onHandOff ? (
            <Button
              size="sm"
              variant="ghost"
              className={styles.headerButton}
              icon={<Handshake />}
              aria-label={`Hand off work from ${thread.name}`}
              title="Hand Off"
              onClick={onHandOff}
            >
              <span className={styles.handoffLabel}>Hand Off</span>
            </Button>
          ) : null}
          {onSplit ? (
            <Button size="sm" variant="ghost" className={styles.headerButton} onClick={onSplit}>
              Split
            </Button>
          ) : null}
          {onMaximize ? (
            <Button size="sm" variant="ghost" className={styles.headerButton} onClick={onMaximize}>
              Maximize
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                ref={moreRef}
                size="sm"
                variant="ghost"
                className={styles.headerButton}
                label={`More actions for ${thread.name}`}
                icon={<MoreHorizontal />}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                if (keepMenuFocus.current) event.preventDefault();
                keepMenuFocus.current = false;
              }}
            >
              <DropdownMenuItem icon={<PenLine />} onSelect={select(() => setEditing(true))}>
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem icon={<Info />} onSelect={select(onInfo)}>
                Pane info
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {onResume ? (
                <DropdownMenuItem icon={<RotateCcw />} onSelect={select(onResume)}>
                  Resume
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem icon={<Square />} tone="danger" onSelect={select(onStop)} disabled={!canStop}>
                Stop…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {onClose ? (
            <Button size="sm" variant="ghost" className={styles.headerButton} onClick={onClose}>
              Close pane
            </Button>
          ) : null}
        </div>
        {model && thread.providerId === "cursor" ? (
          <span className={styles.exactModel} data-pane-model title={model}>
            {model}
          </span>
        ) : null}
      </header>
      {editing && error ? (
        <div id={`${inputId}-error`} className={styles.titleError} role="alert">
          {error}
        </div>
      ) : null}
    </>
  );
}

/** What KalCode sees in a pane and what it can't intercept (PROVIDER_PANES.md §4). */
function PaneInfoPanel({
  info,
  providerId,
  providerName,
  returnFocus,
  onClose,
}: {
  info: PaneInfo | null;
  providerId: string;
  providerName: string;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const copy = paneInfoCopy(providerId, info, providerName);
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const dismiss = () => {
    onClose();
    requestAnimationFrame(() => returnFocus.current?.focus());
  };

  // A click anywhere outside the panel closes it (focus stays where the person clicked).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (!panel || panel.contains(event.target as Node)) return;
      if (returnFocus.current?.contains(event.target as Node)) return;
      closeRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [returnFocus]);

  return (
    <div
      ref={panelRef}
      className={styles.infoPanel}
      role="dialog"
      aria-label="Pane info"
      aria-describedby={headingId}
      aria-modal="false"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      <h3 id={headingId}>What KalCode sees in this pane</h3>
      <p>{copy.summary}</p>
      <p className={styles.infoLimitsTitle}>{copy.limitsTitle}</p>
      <ul>
        {copy.limits.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p>{copy.footer}</p>
      <div className={styles.infoActions}>
        <Button size="sm" onClick={dismiss} autoFocus>
          Close
        </Button>
      </div>
    </div>
  );
}
