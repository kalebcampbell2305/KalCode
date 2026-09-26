import type { ApprovalDecision, PaneInfo, ThreadSummary } from "@kalcode/protocol";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from "@kalcode/ui/components";
import { Info, MessageCircleQuestion, MoreHorizontal, PenLine, Square, Unplug } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { ApprovalPrompt } from "../../permissions/ApprovalPrompt.tsx";
import { MODE_LABELS } from "../../permissions/labels.ts";
import { usePermissions } from "../../permissions/PermissionsProvider.tsx";
import {
  PaneAccountChip,
  type PaneAccountIdentity,
  PaneStatusChip,
  ProviderGlyph,
  paneAccountLabel,
} from "./PaneParts.tsx";
import styles from "./Panes.module.css";
import { PaneTerminal } from "./PaneTerminal.tsx";
import type { PaneChannel } from "./paneChannel.ts";
import {
  channelNote,
  isAnswerInProvider,
  modelLabel,
  paneInfoCopy,
  paneLabel,
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
  /** The thread changed (rename, stop); the host refreshes its list. */
  onChanged?: (thread: ThreadSummary) => void;
  /** The pane isn't focused (Z7-W1): terminal output renders in batches. */
  throttled?: boolean;
  /** Pane-system controls (Z7-W1). Rendered only when provided. */
  onClose?: () => void;
  onMaximize?: () => void;
  onSplit?: () => void;
}

/**
 * One provider pane: the provider's real TUI in a terminal view, under a KalCode header
 * (Z7-15). Closing or hiding the pane never stops the provider; only Stop does (Z7-14).
 */
export function ProviderPane({
  thread,
  info,
  channel,
  account,
  theme,
  focusRequest,
  onChanged,
  onClose,
  onMaximize,
  onSplit,
  throttled = false,
}: ProviderPaneProps) {
  const { client } = useRuntime();
  const { pending, decide } = usePermissions();
  const [showInfo, setShowInfo] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [overlayDismissed, setOverlayDismissed] = useState<string | null>(null);
  const [localFocus, setLocalFocus] = useState(0);
  const overlayRef = useRef<HTMLElement>(null);
  const identity = providerIdentity(thread.providerId, thread.providerName);
  const status = paneStatus(thread.status);
  const note = channelNote(info);
  const running = info?.running ?? false;
  // Only Claude Code panes route tool calls to KalCode; Codex and Gemini CLI are always answered
  // in their own prompt, so they never show a KalCode approval (or an Approve button) here.
  const kalcodeDecides = thread.providerId === "claude-code";
  const request = [...pending]
    .filter((r) => kalcodeDecides && r.action.threadId === thread.id && r.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const showOverlay = request !== undefined && overlayDismissed !== request.id;
  const providerAsking =
    !request && (thread.status === "waiting_for_permission" || isAnswerInProvider(thread.currentActivity));
  const accountLabel = account ? paneAccountLabel(account) : null;

  const stop = async () => {
    setStopping(true);
    try {
      onChanged?.(await client.stopThread(thread.id));
    } catch (error) {
      if (import.meta.env.DEV) console.warn("stop failed", toKalCodeError(error));
    } finally {
      setStopping(false);
      setConfirmStop(false);
    }
  };

  // Ctrl+Shift+E moves focus between the terminal and the approval (or the header); the Code
  // surface's tab shortcuts don't act on terminal tabs while a pane has focus.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const ctrlShift = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
    if (ctrlShift && event.key.toLowerCase() === "e") {
      event.preventDefault();
      if (showOverlay && !overlayRef.current?.contains(document.activeElement)) overlayRef.current?.focus();
      else setLocalFocus((n) => n + 1);
    } else if ((ctrlShift && event.key.toLowerCase() === "w") || (event.ctrlKey && event.key === "Tab")) {
      event.preventDefault();
    }
  };

  const decideHere = (requestId: string, decision: ApprovalDecision) =>
    decide(requestId, decision).then((result) => {
      setLocalFocus((n) => n + 1);
      return result;
    });

  return (
    <section
      className={styles.pane}
      aria-label={`${paneLabel(thread)}${accountLabel ? `, account ${accountLabel}` : ""}`}
      data-provider-pane={thread.id}
      data-tone={status.tone}
      onKeyDown={onKeyDown}
    >
      <PaneHeader
        thread={thread}
        identityName={identity.name}
        account={account}
        note={note}
        onRename={(renamed) => onChanged?.(renamed)}
        onStop={() => setConfirmStop(true)}
        onInfo={() => setShowInfo((v) => !v)}
        canStop={running || thread.status !== "interrupted"}
        onClose={onClose}
        onMaximize={onMaximize}
        onSplit={onSplit}
      />
      {confirmStop ? (
        <div className={styles.confirm} role="alertdialog" aria-label="Stop this provider">
          <span className={styles.confirmText}>
            Stop {identity.name} in this pane? Its process ends; the conversation can be resumed later.
          </span>
          <Button size="sm" variant="ghost" onClick={() => setConfirmStop(false)} autoFocus>
            Keep running
          </Button>
          <Button size="sm" variant="danger" busy={stopping} onClick={() => void stop()}>
            Stop
          </Button>
        </div>
      ) : null}
      <div className={styles.body}>
        <PaneTerminal
          channel={channel}
          threadId={thread.id}
          providerId={thread.providerId}
          providerAccountId={thread.providerAccountId}
          status={thread.status}
          providerPromptActive={providerAsking}
          label={`${thread.name} ${identity.name}${accountLabel ? ` ${accountLabel}` : ""} input`}
          running={running}
          focusRequest={focusRequest + localFocus}
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
              <span>KalCode is holding this tool call until you answer.</span>
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
            onClose={() => setShowInfo(false)}
          />
        ) : null}
      </div>
      {providerAsking ? (
        <div className={styles.banner} role="status">
          <MessageCircleQuestion aria-hidden="true" />
          {identity.name} is asking in the pane. Answer there.
        </div>
      ) : null}
    </section>
  );
}

interface PaneHeaderProps {
  thread: ThreadSummary;
  identityName: string;
  account: PaneAccountIdentity | null;
  note: ReturnType<typeof channelNote>;
  onRename: (thread: ThreadSummary) => void;
  onStop: () => void;
  onInfo: () => void;
  canStop: boolean;
  onClose?: () => void;
  onMaximize?: () => void;
  onSplit?: () => void;
}

function PaneHeader({
  thread,
  identityName,
  account,
  note,
  onRename,
  onStop,
  onInfo,
  canStop,
  onClose,
  onMaximize,
  onSplit,
}: PaneHeaderProps) {
  const { client } = useRuntime();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.name);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const titleRef = useRef<HTMLButtonElement>(null);
  const bypass = thread.permissionMode === "bypass";

  useEffect(() => {
    if (!editing) setDraft(thread.name);
  }, [thread.name, editing]);

  const save = async () => {
    const name = draft.trim();
    if (!name || name === thread.name) {
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

  return (
    <header className={styles.header}>
      <span className={styles.identity}>
        <ProviderGlyph providerId={thread.providerId} providerName={thread.providerName} />
        <span className={styles.providerName}>{identityName}</span>
      </span>
      <div className={styles.titleBlock}>
        {editing ? (
          <>
            <label className="visually-hidden" htmlFor={inputId}>
              Thread name
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
                  setEditing(false);
                  requestAnimationFrame(() => titleRef.current?.focus());
                }
              }}
            />
            {error ? (
              <span id={`${inputId}-error`} className={styles.note} role="alert">
                {error}
              </span>
            ) : null}
          </>
        ) : (
          <button
            ref={titleRef}
            type="button"
            className={styles.titleButton}
            title="Rename"
            aria-label={`${thread.name}. Rename thread`}
            onClick={() => setEditing(true)}
          >
            <span className={styles.title}>{thread.name}</span>
          </button>
        )}
        <span className={styles.model}>{modelLabel(thread)}</span>
      </div>
      <div className={styles.meta}>
        {account ? <PaneAccountChip account={account} /> : null}
        {note ? (
          <span className={styles.note} data-tone={note.tone} data-pane-channel={note.tone}>
            {note.tone === "limited" ? <Unplug aria-hidden="true" /> : null}
            {note.text}
          </span>
        ) : null}
        <Badge tone={bypass ? "danger" : "outline"} title="Permission mode">
          {MODE_LABELS[thread.permissionMode]}
        </Badge>
        <PaneStatusChip status={thread.status} />
        {onSplit ? (
          <Button size="sm" variant="ghost" onClick={onSplit}>
            Split
          </Button>
        ) : null}
        {onMaximize ? (
          <Button size="sm" variant="ghost" onClick={onMaximize}>
            Maximize
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" variant="ghost" label={`More actions for ${thread.name}`} icon={<MoreHorizontal />} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem icon={<PenLine />} onSelect={() => setEditing(true)}>
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Info />} onSelect={onInfo}>
              Pane info
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Square />} tone="danger" onSelect={onStop} disabled={!canStop}>
              Stop…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {onClose ? (
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close pane
          </Button>
        ) : null}
      </div>
    </header>
  );
}

/** What KalCode sees in a pane and what it can't intercept (PROVIDER_PANES.md §4). */
function PaneInfoPanel({
  info,
  providerId,
  providerName,
  onClose,
}: {
  info: PaneInfo | null;
  providerId: string;
  providerName: string;
  onClose: () => void;
}) {
  const copy = paneInfoCopy(providerId, info, providerName);
  return (
    <div className={styles.infoPanel} role="dialog" aria-label="Pane info" aria-modal="false">
      <h3>What KalCode sees in this pane</h3>
      <p>{copy.summary}</p>
      <p>{copy.limitsTitle}</p>
      <ul>
        {copy.limits.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p>{copy.footer}</p>
      <div className={styles.infoActions}>
        <Button size="sm" onClick={onClose} autoFocus>
          Close
        </Button>
      </div>
    </div>
  );
}
