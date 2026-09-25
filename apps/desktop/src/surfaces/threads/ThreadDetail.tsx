import type { ThreadSummary } from "@kalcode/protocol";
import {
  Badge,
  Button,
  ErrorState,
  IconButton,
  ProviderGlyph,
  Skeleton,
  StatusChip,
  StatusIndicator,
  TextArea,
  TextInput,
  Tooltip,
  useToast,
} from "@kalcode/ui/components";
import {
  Archive,
  CirclePause,
  CircleX,
  Info,
  Pencil,
  Play,
  ShieldAlert,
  Square,
  UserRound,
  Wrench,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { MOD_LABEL } from "../../shell/shortcuts.ts";
import { ApprovalPrompt, usePermissions } from "../permissions/index.ts";
import { buildTimeline, PERMISSION_MODES, presentStatus, TOOL_STATUS, threadActions } from "./model.ts";
import styles from "./ThreadDetail.module.css";
import { type LiveMessage, useThreadDetail } from "./useThreads.ts";

interface ThreadDetailProps {
  threadId: string;
  archived: boolean;
  onArchived: () => void;
}

/** Prefix of the runtime's structured activity while a thread waits for approval. */
const APPROVAL_PREFIX = "Waiting for approval: ";

type Action = "interrupt" | "stop" | "resume" | "archive" | "send" | "rename";

const FAILURE_TITLES: Record<Action, string> = {
  interrupt: "Couldn't interrupt the thread",
  stop: "Couldn't stop the thread",
  resume: "Couldn't resume the thread",
  archive: "Couldn't archive the thread",
  send: "Message not sent",
  rename: "Couldn't rename the thread",
};

export function ThreadDetail({ threadId, archived, onArchived }: ThreadDetailProps) {
  const { client } = useRuntime();
  const { pending, decide } = usePermissions();
  const toast = useToast();
  const detail = useThreadDetail(threadId);
  const [busy, setBusy] = useState<Action | null>(null);

  const run = async (action: Action, call: () => Promise<ThreadSummary>): Promise<boolean> => {
    setBusy(action);
    try {
      detail.setThread(await call());
      void detail.reload();
      return true;
    } catch (error) {
      toast.show({ tone: "danger", title: FAILURE_TITLES[action], description: toKalCodeError(error).message });
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (detail.state === "loading" || (!detail.thread && detail.state !== "error")) {
    return (
      <div className={styles.loading} role="status" aria-busy="true">
        <span className="visually-hidden">Loading thread</span>
        <Skeleton width="40%" height="1.25rem" />
        <Skeleton width="25%" />
        <Skeleton width="70%" />
      </div>
    );
  }
  if (!detail.thread) {
    return (
      <div className={styles.loading}>
        <ErrorState
          headingLevel={2}
          title="This thread couldn't load"
          code={detail.error ? `${detail.error.category}/${detail.error.code}` : undefined}
          actions={<Button onClick={detail.retry}>Try again</Button>}
        >
          <p>{detail.error?.message ?? "KalCode couldn't read this thread."} Your data is unchanged.</p>
        </ErrorState>
      </div>
    );
  }

  const thread = detail.thread;
  const actions = threadActions(thread, archived);
  const requests = pending.filter((request) => request.action.threadId === thread.id);
  const status = presentStatus(thread.status);

  return (
    <article className={styles.detail} aria-labelledby="thread-title">
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <ThreadTitle
            thread={thread}
            busy={busy === "rename"}
            onRename={(name) => run("rename", () => client.renameThread(thread.id, name))}
          />
          <div className={styles.actions}>
            {actions.interrupt ? (
              <Button
                size="sm"
                icon={<CirclePause />}
                busy={busy === "interrupt"}
                onClick={() => void run("interrupt", () => client.interruptThread(thread.id))}
              >
                Interrupt
              </Button>
            ) : null}
            {actions.resume ? (
              <Button
                size="sm"
                icon={<Play />}
                busy={busy === "resume"}
                onClick={() => void run("resume", () => client.resumeThread(thread.id))}
              >
                Resume
              </Button>
            ) : null}
            {actions.stop ? (
              <Button
                size="sm"
                variant="danger"
                icon={<Square />}
                busy={busy === "stop"}
                onClick={() => void run("stop", () => client.stopThread(thread.id))}
              >
                Stop
              </Button>
            ) : null}
            {actions.archive ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Archive />}
                busy={busy === "archive"}
                onClick={async () => {
                  if (await run("archive", () => client.archiveThread(thread.id))) {
                    toast.show({
                      tone: "success",
                      title: "Thread archived",
                      description: "Turn on Show archived to find it.",
                    });
                    onArchived();
                  }
                }}
              >
                Archive
              </Button>
            ) : null}
          </div>
        </div>
        <p className={styles.status} aria-live="polite">
          <StatusChip status={status.display} tone={status.tone} label={status.label} />
          {thread.currentActivity ? <span className={styles.activity}>{thread.currentActivity}</span> : null}
          {archived ? <Badge tone="outline">Archived</Badge> : null}
        </p>
        <dl className={styles.meta}>
          <div>
            <dt>Provider</dt>
            <dd>
              <ProviderGlyph provider={thread.providerId} size="xs" />
              {thread.providerName}
              {thread.model ? ` · ${thread.model}` : ""}
              {thread.accountLabel ? ` · ${thread.accountLabel}` : ""}
            </dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd>{thread.workspaceName}</dd>
          </div>
          <div>
            <dt>Permissions</dt>
            <dd>{PERMISSION_MODES[thread.permissionMode].label}</dd>
          </div>
          <div>
            <dt>Files changed</dt>
            <dd>{thread.filesChanged ?? 0}</dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>
              <time dateTime={thread.createdAt} title={formatAbsolute(thread.createdAt)}>
                {formatRelative(thread.createdAt)}
              </time>
            </dd>
          </div>
        </dl>
      </header>

      {thread.error ? (
        <div className={styles.notice} data-tone="danger" role="alert">
          <CircleX className={styles.noticeIcon} aria-hidden="true" />
          <p className={styles.noticeTitle}>
            {thread.status === "failed" ? "This thread failed" : "The provider reported a problem"}
          </p>
          <p>{thread.error.message}</p>
          <p className={styles.noticeCode}>Error code: {thread.error.code}</p>
        </div>
      ) : null}
      {thread.status === "waiting_for_permission" ? (
        <div className={styles.notice} data-tone="waiting">
          <ShieldAlert className={styles.noticeIcon} aria-hidden="true" />
          <p className={styles.noticeTitle}>
            {thread.pendingApprovals === 1
              ? "Waiting for 1 permission decision"
              : `Waiting for ${thread.pendingApprovals} permission decisions`}
          </p>
          {requests.length === 0 && thread.currentActivity?.startsWith(APPROVAL_PREFIX) ? (
            <p>Requested: {thread.currentActivity.slice(APPROVAL_PREFIX.length)}</p>
          ) : null}
          <p>Answer below, or interrupt the turn to deny it and keep the thread.</p>
        </div>
      ) : null}
      {requests.length > 0 ? (
        <ol className={styles.approvals} aria-label="Waiting for your approval">
          {requests.map((request) => (
            <li key={request.id}>
              <ApprovalPrompt request={request} onDecide={decide} headingLevel={3} />
            </li>
          ))}
        </ol>
      ) : null}

      <Timeline detail={detail} providerName={thread.providerName} providerId={thread.providerId} />

      <Composer
        thread={thread}
        mode={actions.compose}
        busy={busy === "send" || busy === "resume"}
        onSubmit={(text) =>
          run(actions.compose === "resume" ? "resume" : "send", () =>
            actions.compose === "resume" ? client.resumeThread(thread.id, text) : client.sendToThread(thread.id, text),
          )
        }
      />
    </article>
  );
}

function ThreadTitle({
  thread,
  busy,
  onRename,
}: {
  thread: ThreadSummary;
  busy: boolean;
  onRename: (name: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(thread.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const close = () => {
    setEditing(false);
    requestAnimationFrame(() => editRef.current?.focus());
  };

  if (!editing) {
    return (
      <div className={styles.title}>
        <h2 id="thread-title" className={styles.name}>
          {thread.name}
        </h2>
        <Tooltip content="Rename thread">
          <IconButton
            ref={editRef}
            size="sm"
            label="Rename thread"
            icon={<Pencil />}
            onClick={() => {
              setName(thread.name);
              setEditing(true);
            }}
          />
        </Tooltip>
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await onRename(name)) close();
  };

  return (
    <form className={styles.renameForm} onSubmit={submit}>
      <h2 id="thread-title" className="visually-hidden">
        {thread.name}
      </h2>
      <TextInput
        ref={inputRef}
        value={name}
        maxLength={80}
        aria-label="Thread name"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      />
      <Button size="sm" variant="primary" type="submit" busy={busy} disabled={!name.trim()}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={close}>
        Cancel
      </Button>
    </form>
  );
}

function AuthorMark({ author, providerId }: { author: string; providerId: string }) {
  return (
    <span className={styles.authorMark} aria-hidden="true">
      {author === "user" ? (
        <UserRound />
      ) : author === "assistant" ? (
        <ProviderGlyph provider={providerId} size="xs" />
      ) : (
        <Info />
      )}
    </span>
  );
}

function Timeline({
  detail,
  providerName,
  providerId,
}: {
  detail: ReturnType<typeof useThreadDetail>;
  providerName: string;
  providerId: string;
}) {
  const items = buildTimeline(detail.messages, detail.tools);
  const streaming = detail.live.filter((m) => m.text.trim());
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const size = items.length + streaming.reduce((n, m) => n + m.text.length, 0);

  // Follow new output while the reader is at the bottom; leave them alone if they scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `size` changes whenever content grows.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [size]);

  return (
    <div
      ref={scroller}
      className={styles.timeline}
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      {items.length === 0 && streaming.length === 0 ? (
        <p className={styles.empty}>No messages yet.</p>
      ) : (
        <ol className={styles.items} aria-label="Conversation">
          {items.map((item) =>
            item.kind === "message" ? (
              <li key={item.key} className={styles.message} data-role={item.message.role}>
                <p className={styles.author}>
                  <AuthorMark author={item.message.role} providerId={providerId} />
                  <span>
                    {item.message.role === "user"
                      ? "You"
                      : item.message.role === "assistant"
                        ? providerName
                        : "KalCode"}
                  </span>
                  <time dateTime={item.message.createdAt} title={formatAbsolute(item.message.createdAt)}>
                    {formatRelative(item.message.createdAt)}
                  </time>
                </p>
                <div className={styles.content} data-selectable>
                  {item.message.content}
                </div>
              </li>
            ) : (
              <li key={item.key} className={styles.tool}>
                <Wrench className={styles.toolIcon} aria-hidden="true" />
                <span className={styles.toolName}>{item.tool.tool}</span>
                <span className={styles.toolSummary}>{item.tool.summary}</span>
                <StatusIndicator tone={TOOL_STATUS[item.tool.status].tone} pulse={item.tool.status === "running"}>
                  {TOOL_STATUS[item.tool.status].label}
                </StatusIndicator>
                {item.tool.resultSummary ? <span className={styles.toolResult}>{item.tool.resultSummary}</span> : null}
              </li>
            ),
          )}
          {streaming.map((message: LiveMessage) => (
            <li key={message.messageId} className={styles.message} data-role="assistant" aria-busy={!message.done}>
              <p className={styles.author}>
                <AuthorMark author="assistant" providerId={providerId} />
                <span>{providerName}</span>
                {message.done ? null : (
                  <StatusIndicator tone="working" pulse>
                    Writing
                  </StatusIndicator>
                )}
              </p>
              <div className={styles.content} data-selectable>
                {message.text}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Composer({
  thread,
  mode,
  busy,
  onSubmit,
}: {
  thread: ThreadSummary;
  mode: "send" | "resume" | "blocked";
  busy: boolean;
  onSubmit: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const blocked = mode === "blocked";

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (blocked || busy || !text.trim()) return;
    if (await onSubmit(text)) setText("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const hint =
    mode === "resume"
      ? `This thread isn't running. Sending resumes it with your message.`
      : blocked
        ? thread.status === "waiting_for_permission"
          ? "Messages can be sent once the permission decision is made."
          : "Archived threads are read-only."
        : `${MOD_LABEL} Enter to send`;

  return (
    <form className={styles.composer} onSubmit={submit}>
      <label htmlFor="thread-composer" className="visually-hidden">
        Message
      </label>
      <div className={styles.well} data-disabled={blocked || undefined}>
        <TextArea
          id="thread-composer"
          rows={3}
          value={text}
          disabled={blocked}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={blocked ? "" : `Message ${thread.providerName}`}
          aria-describedby="thread-composer-hint"
        />
        <div className={styles.composerFooter}>
          <p id="thread-composer-hint" className={styles.composerHint}>
            {hint}
          </p>
          <Button type="submit" variant="primary" size="sm" busy={busy} disabled={blocked || !text.trim()}>
            {mode === "resume" ? "Resume and send" : "Send"}
          </Button>
        </div>
      </div>
    </form>
  );
}
