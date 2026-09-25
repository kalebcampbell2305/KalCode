import type { ThreadSummary } from "@kalcode/protocol";
import { Button, ProviderMark } from "@kalcode/ui/components";
import { FileDiff, Folder, GitBranch, MessageCircle, ShieldAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import { useNavigation } from "../../shell/navigation.tsx";
import { ACTION_LABELS, availableActions, type ThreadAction } from "./data/actions.ts";
import { formatElapsed, PERMISSION_MODE_HINTS, PERMISSION_MODE_LABELS, runDurationMs } from "./data/format.ts";
import { StatusLabel } from "./StatusLabel.tsx";
import styles from "./ThreadRow.module.css";

interface ThreadRowProps {
  thread: ThreadSummary;
  now: number;
  pending: ThreadAction | undefined;
  onAction: (action: Exclude<ThreadAction, "open">) => void;
  /** "open" rows show live detail; "outcome" rows summarize a finished thread. */
  variant?: "open" | "outcome";
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** One thread as a dense, scannable row: status, what it is doing, who runs it, where, and how long. */
export function ThreadRow({ thread, now, pending, onAction, variant = "open" }: ThreadRowProps) {
  const id = useId();
  const { navigate } = useNavigation();
  const [confirmingStop, setConfirmingStop] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const actions = availableActions(thread.status);
  const duration = runDurationMs(thread, now);
  const failed = thread.error !== null;

  useEffect(() => {
    if (confirmingStop) confirmRef.current?.focus();
  }, [confirmingStop]);

  // A status change can make Stop invalid; drop a stale confirmation.
  const canStop = actions.includes("stop");
  useEffect(() => {
    if (!canStop) setConfirmingStop(false);
  }, [canStop]);

  const cancelStop = () => {
    setConfirmingStop(false);
    requestAnimationFrame(() => stopRef.current?.focus());
  };

  const escapeCancels = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    cancelStop();
  };

  return (
    <li className={styles.row} data-variant={variant} data-status={thread.status}>
      <div className={styles.status}>
        <StatusLabel status={thread.status} />
      </div>

      <div className={styles.main}>
        <p className={styles.nameLine}>
          <span id={`${id}-name`} className={styles.name}>
            {thread.name}
          </span>
          {thread.pendingApprovals > 0 ? (
            <span className={styles.flag} data-tone="waiting">
              <ShieldAlert aria-hidden="true" />
              {plural(thread.pendingApprovals, "approval", "approvals")}
            </span>
          ) : null}
          {thread.unreadMessages > 0 ? (
            <span className={styles.flag}>
              <MessageCircle aria-hidden="true" />
              {plural(thread.unreadMessages, "unread", "unread")}
            </span>
          ) : null}
        </p>
        {failed && thread.error ? (
          <p className={styles.error}>{thread.error.message}</p>
        ) : (
          <p className={styles.activity}>{thread.currentActivity ?? "No current activity"}</p>
        )}
        <dl className={styles.meta}>
          <div>
            <dt className="visually-hidden">Provider</dt>
            <dd className={styles.provider}>
              <ProviderMark provider={thread.providerId} name={thread.providerName} size="xs" />
              {thread.model ? <span className={styles.model}>{thread.model}</span> : null}
              {thread.accountLabel ? <span className={styles.model}>{thread.accountLabel} account</span> : null}
            </dd>
          </div>
          <div>
            <dt className="visually-hidden">Workspace</dt>
            <dd>
              <Folder aria-hidden="true" />
              {thread.workspaceName}
            </dd>
          </div>
          {thread.branch ? (
            <div>
              <dt className="visually-hidden">Branch</dt>
              <dd>
                <GitBranch aria-hidden="true" />
                {thread.branch}
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="visually-hidden">Files changed</dt>
            <dd>
              <FileDiff aria-hidden="true" />
              {thread.filesChanged === null
                ? "Changes unknown"
                : thread.filesChanged === 0
                  ? "No changes"
                  : plural(thread.filesChanged, "file changed", "files changed")}
            </dd>
          </div>
          <div>
            <dt className="visually-hidden">Permission mode</dt>
            <dd title={PERMISSION_MODE_HINTS[thread.permissionMode]}>
              {PERMISSION_MODE_LABELS[thread.permissionMode]} mode
            </dd>
          </div>
        </dl>
      </div>

      <div className={styles.side}>
        <p className={styles.when}>
          <span className={styles.duration}>
            <span className="visually-hidden">{variant === "outcome" ? "Ran for " : "Running for "}</span>
            {duration === null ? "Unknown" : formatElapsed(duration)}
          </span>
          <time
            className={styles.relative}
            dateTime={thread.lastActivityAt}
            title={formatAbsolute(thread.lastActivityAt)}
          >
            <span className="visually-hidden">{variant === "outcome" ? "Ended " : "Last activity "}</span>
            {formatRelative(thread.lastActivityAt, now)}
          </time>
        </p>

        <div className={styles.actions}>
          {confirmingStop ? (
            <div className={styles.confirm}>
              <span className={styles.confirmText}>Stop this thread?</span>
              <Button variant="ghost" size="sm" onClick={cancelStop} onKeyDown={escapeCancels}>
                Cancel
              </Button>
              <Button
                ref={confirmRef}
                variant="danger"
                size="sm"
                busy={pending === "stop"}
                onKeyDown={escapeCancels}
                onClick={() => {
                  setConfirmingStop(false);
                  onAction("stop");
                }}
              >
                Stop thread
              </Button>
            </div>
          ) : (
            actions.map((action) =>
              action === "open" ? (
                <Button key={action} variant="ghost" size="sm" onClick={() => navigate("threads")}>
                  {ACTION_LABELS.open}
                  <span className="visually-hidden"> {thread.name}</span>
                </Button>
              ) : (
                <Button
                  key={action}
                  ref={action === "stop" ? stopRef : undefined}
                  variant={action === "retry" || action === "resume" ? "secondary" : "ghost"}
                  size="sm"
                  busy={pending === action}
                  disabled={pending !== undefined && pending !== action}
                  onClick={() => (action === "stop" ? setConfirmingStop(true) : onAction(action))}
                >
                  {ACTION_LABELS[action]}
                  <span className="visually-hidden"> {thread.name}</span>
                </Button>
              ),
            )
          )}
        </div>
      </div>
    </li>
  );
}
