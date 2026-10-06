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
  ArchiveRestore,
  BrushCleaning,
  CirclePause,
  CircleX,
  Hourglass,
  Info,
  Pencil,
  Play,
  Rocket,
  ShieldAlert,
  Square,
  UserRound,
  Wrench,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAccount } from "../../account/AccountProvider.tsx";
import { ContextTray } from "../../context/ContextTray.tsx";
import { PromptWarningDialog } from "../../context/PromptWarningDialog.tsx";
import { useContextDrop } from "../../context/useContextDrop.ts";
import { usePromptConfirmation } from "../../context/usePromptConfirmation.ts";
import {
  type ComposerSubmitOutcome,
  registerComposer,
  useComposerListening,
  voiceTargetLabel,
} from "../../kalvoice/composerRegistry.ts";
import { forgetVoiceText } from "../../kalvoice/voiceSpans.ts";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { ContentContextMenu } from "../../shell/context/ContentContextMenu.tsx";
import { MOD_LABEL } from "../../shell/shortcuts.ts";
import { useKalTidy } from "../code/kaltidy/kalTidyContext.ts";
import { ApprovalPrompt, usePermissions } from "../permissions/index.ts";
import { AccountSwitcher } from "./AccountSwitcher.tsx";
import {
  buildTimeline,
  isWaitingForResources,
  PERMISSION_MODES,
  presentProblem,
  presentThread,
  TOOL_STATUS,
  threadActions,
} from "./model.ts";
import styles from "./ThreadDetail.module.css";
import { describeSendError, useThreadAccountChanges } from "./useThreadAccount.ts";
import { type LiveMessage, useThreadDetail } from "./useThreads.ts";

interface ThreadDetailProps {
  threadId: string;
  archived: boolean;
  onArchived: () => void;
  /** The thread was restored to the open list (`thread_unarchive`). */
  onUnarchived: () => void;
  /** Newer messages were loaded, which marks them read without a thread event. */
  onRead?: () => void;
}

/** Prefix of the runtime's structured activity while a thread waits for approval. */
const APPROVAL_PREFIX = "Waiting for approval: ";

type Action = "interrupt" | "stop" | "resume" | "start_anyway" | "archive" | "unarchive" | "send" | "rename";

const FAILURE_TITLES: Record<Action, string> = {
  interrupt: "Couldn't interrupt the thread",
  stop: "Couldn't stop the thread",
  resume: "Couldn't resume the thread",
  start_anyway: "Couldn't start the thread",
  archive: "Couldn't archive the thread",
  unarchive: "Couldn't unarchive the thread",
  send: "Message not sent",
  rename: "Couldn't rename the thread",
};

export function ThreadDetail({ threadId, archived, onArchived, onUnarchived, onRead }: ThreadDetailProps) {
  const { client } = useRuntime();
  const { pending, pendingState, decide, refreshPending, setPanelOpen } = usePermissions();
  const toast = useToast();
  const detail = useThreadDetail(threadId);
  const [busy, setBusy] = useState<Action | null>(null);
  const kalTidy = useKalTidy();
  // A rebind from anywhere (this header, the palette, KalVoice, another window) shows at once.
  useThreadAccountChanges(threadId, (change) =>
    detail.setThread((current) =>
      current && current.id === change.threadId
        ? { ...current, providerAccountId: change.providerAccountId, accountLabel: change.accountLabel }
        : current,
    ),
  );
  // Reading the newest page clears the unread count natively; let the list catch up.
  const newestId = detail.state === "ready" ? (detail.messages.at(-1)?.id ?? null) : null;
  const readThrough = useRef<string | null>(null);
  useEffect(() => {
    if (newestId === null || newestId === readThrough.current) return;
    readThrough.current = newestId;
    onRead?.();
  }, [newestId, onRead]);

  const run = async (action: Action, call: () => Promise<ThreadSummary>): Promise<boolean> => {
    setBusy(action);
    try {
      detail.setThread(await call());
      void detail.reload();
      return true;
    } catch (error) {
      toast.show({ tone: "danger", title: FAILURE_TITLES[action], description: describeSendError(error) });
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
  const status = presentThread(thread);
  const problem = presentProblem(thread);

  return (
    <article className={styles.detail} aria-labelledby="thread-title" data-thread-detail={thread.id}>
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
            {actions.startAnyway ? (
              <Button
                size="sm"
                variant="primary"
                icon={<Rocket />}
                busy={busy === "start_anyway"}
                onClick={() => void run("start_anyway", () => client.startThreadAnyway(thread.id))}
              >
                Start Anyway
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
            {archived ? (
              <Button
                size="sm"
                icon={<ArchiveRestore />}
                busy={busy === "unarchive"}
                onClick={async () => {
                  if (await run("unarchive", () => client.unarchiveThread(thread.id))) {
                    toast.show({
                      tone: "success",
                      title: "Thread restored",
                      description: "It's back in your threads and on the Dashboard.",
                    });
                    onUnarchived();
                  }
                }}
              >
                Unarchive
              </Button>
            ) : null}
          </div>
        </div>
        <p className={styles.status} aria-live="polite">
          <StatusChip status={status.display} tone={status.tone} label={status.label} />
          {thread.currentActivity && thread.currentActivity !== status.label ? (
            <span className={styles.activity}>{thread.currentActivity}</span>
          ) : null}
          {archived ? <Badge tone="outline">Archived</Badge> : null}
        </p>
        <dl className={styles.meta}>
          <div>
            <dt>Provider</dt>
            <dd>
              <ProviderGlyph provider={thread.providerId} size="xs" />
              {thread.providerName}
              {thread.model ? ` · ${thread.model}` : ""}
              {" · "}
              <AccountSwitcher
                thread={thread}
                archived={archived}
                onRebound={(next) => {
                  detail.setThread(next);
                  void detail.reload();
                }}
              />
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

      {thread.error && problem ? (
        <ContentContextMenu
          workspaceId={thread.workspaceId}
          context={{ kind: "error", label: problem.title, text: `${thread.error.code}: ${thread.error.message}` }}
        >
          <div className={styles.notice} data-tone={problem.tone} role={problem.tone === "danger" ? "alert" : "status"}>
            {/* The tone rail on an inert element, not ::before (see ThreadDetail.module.css). */}
            <span className={styles.noticeRail} aria-hidden="true" />
            {problem.tone === "danger" ? (
              <CircleX className={styles.noticeIcon} aria-hidden="true" />
            ) : (
              <Hourglass className={styles.noticeIcon} aria-hidden="true" />
            )}
            <p className={styles.noticeTitle}>{problem.title}</p>
            <p>{thread.error.message}</p>
            <p className={styles.noticeCode}>
              {problem.tone === "danger" ? "Error code" : "Code"}: {thread.error.code}
            </p>
            {actions.startAnyway && kalTidy ? (
              <div className={styles.noticeActions}>
                <Button size="sm" variant="secondary" icon={<BrushCleaning />} onClick={() => kalTidy.openReview()}>
                  Run KalTidy
                </Button>
              </div>
            ) : null}
          </div>
        </ContentContextMenu>
      ) : null}
      {thread.status === "waiting_for_permission" ? (
        <div className={styles.notice} data-tone="waiting">
          <span className={styles.noticeRail} aria-hidden="true" />
          <ShieldAlert className={styles.noticeIcon} aria-hidden="true" />
          <p className={styles.noticeTitle}>
            {thread.pendingApprovals === 1
              ? "Waiting for 1 permission decision"
              : `Waiting for ${thread.pendingApprovals} permission decisions`}
          </p>
          {requests.length === 0 && thread.currentActivity?.startsWith(APPROVAL_PREFIX) ? (
            <p>Requested: {thread.currentActivity.slice(APPROVAL_PREFIX.length)}</p>
          ) : null}
          {requests.length > 0 ? (
            <p>Answer below, or interrupt the turn to deny it and keep the thread.</p>
          ) : pendingState === "loading" ? (
            <p>Loading the request…</p>
          ) : (
            // No request for this thread is loaded here (it failed to load, or hasn't arrived yet):
            // never point at controls that aren't on screen.
            <>
              <p>
                {pendingState === "error" ? "The request couldn't load here." : "The request isn't showing here yet."}{" "}
                Check Approvals, or interrupt the turn to deny it and keep the thread.
              </p>
              <p>
                <Button
                  size="sm"
                  onClick={() => {
                    setPanelOpen(true);
                    void refreshPending();
                  }}
                >
                  Open Approvals
                </Button>
              </p>
            </>
          )}
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
        onSubmit={(text, promptReviewId) =>
          run(actions.compose === "resume" ? "resume" : "send", () =>
            actions.compose === "resume"
              ? client.resumeThread(thread.id, text, promptReviewId)
              : client.sendToThread(thread.id, text, promptReviewId),
          )
        }
        onContextSent={(next) => {
          detail.setThread(next);
          void detail.reload();
        }}
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
        <h2 id="thread-title" className={styles.name} title={thread.name}>
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
  const toast = useToast();
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  /** Distance from the bottom before earlier messages were prepended, so the view stays put. */
  const anchor = useRef<number | null>(null);

  // Follow new output while the reader is at the bottom; leave them alone if they scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `size` changes whenever content grows.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current !== null) {
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = null;
    } else if (pinned.current) el.scrollTop = el.scrollHeight;
  }, [size]);

  const loadEarlier = async () => {
    const el = scroller.current;
    setLoadingEarlier(true);
    if (el) anchor.current = el.scrollHeight - el.scrollTop;
    const loaded = await detail.loadEarlier();
    setLoadingEarlier(false);
    requestAnimationFrame(() => {
      // Nothing was prepended: don't let a later update jump the view.
      anchor.current = null;
      // The button goes away once the first message is loaded; keep focus in the transcript.
      if (document.activeElement === document.body) scroller.current?.focus();
    });
    if (!loaded)
      toast.show({ tone: "danger", title: "Couldn't load earlier messages", description: "Try again in a moment." });
  };

  return (
    <section
      ref={scroller}
      className={styles.timeline}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: this overflow region must take focus so keyboard users can scroll the transcript.
      tabIndex={0}
      aria-label="Conversation transcript"
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      {detail.hasEarlier ? (
        <div className={styles.earlier}>
          <Button size="sm" variant="ghost" busy={loadingEarlier} onClick={() => void loadEarlier()}>
            Load earlier messages
          </Button>
        </div>
      ) : null}
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
                <ContentContextMenu
                  workspaceId={detail.thread?.workspaceId}
                  context={{
                    kind: "output",
                    label: `${item.message.role === "user" ? "Your" : providerName} message`,
                    text: item.message.content,
                  }}
                >
                  <div className={styles.content} data-selectable>
                    {item.message.content}
                  </div>
                </ContentContextMenu>
              </li>
            ) : (
              <li key={item.key} className={styles.tool}>
                <Wrench className={styles.toolIcon} aria-hidden="true" />
                <span className={styles.toolName}>{item.tool.tool}</span>
                <span className={styles.toolSummary}>{item.tool.summary}</span>
                <StatusIndicator tone={TOOL_STATUS[item.tool.status].tone} pulse={item.tool.status === "running"}>
                  {TOOL_STATUS[item.tool.status].label}
                </StatusIndicator>
                {item.tool.resultSummary ? (
                  <ContentContextMenu
                    workspaceId={detail.thread?.workspaceId}
                    context={{
                      kind: item.tool.status === "failed" ? "error" : "output",
                      label: item.tool.tool,
                      text: item.tool.resultSummary,
                    }}
                  >
                    <span className={styles.toolResult}>{item.tool.resultSummary}</span>
                  </ContentContextMenu>
                ) : null}
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
    </section>
  );
}

function Composer({
  thread,
  mode,
  busy,
  onSubmit,
  onContextSent,
}: {
  thread: ThreadSummary;
  mode: "send" | "resume" | "blocked";
  busy: boolean;
  onSubmit: (text: string, promptReviewId: string | null) => Promise<boolean>;
  onContextSent: (thread: ThreadSummary) => void;
}) {
  const { client } = useRuntime();
  const account = useAccount();
  const toast = useToast();
  const [text, setTextState] = useState("");
  // The latest text, readable synchronously by a voice send right after a dictated insert.
  const draft = useRef("");
  const setText = (next: string) => {
    draft.current = next;
    // Sent or emptied: nothing KalVoice typed is left for "clear that" to remove.
    if (next === "") forgetVoiceText(thread.id);
    setTextState(next);
  };
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const blocked = mode === "blocked";
  const promptScope = [
    account.generation,
    account.snapshot.account?.id ?? "signed-out",
    account.runtime.phase,
    thread.id,
    thread.workspaceId,
    thread.providerId,
    thread.providerAccountId ?? "default-account",
  ].join(":");
  const confirmation = usePromptConfirmation(promptScope, client);
  const context = useContextDrop(thread, confirmation.cancel);
  const sending = busy || context.busy || confirmation.busy;

  /** The composer's own Send (form, Ctrl+Enter and KalVoice all use it). */
  const send = async (): Promise<ComposerSubmitOutcome> => {
    const submittedText = draft.current;
    if (blocked) return "blocked";
    if (sending) return "busy";
    if (!submittedText.trim()) return "empty";
    const hasContext = context.preview !== null;
    // Settled by the callbacks below; still "confirm" afterwards means the warning dialog is open.
    let outcome: ComposerSubmitOutcome = "confirm";
    await confirmation.request({
      review: () => client.reviewThreadPrompt(thread.id, submittedText),
      effect: async (promptReviewId) => {
        if (!hasContext) return { kind: "plain" as const, sent: await onSubmit(submittedText, promptReviewId) };
        return { kind: "context" as const, result: await context.send(submittedText, promptReviewId) };
      },
      onComplete: (result) => {
        if (result.kind === "plain") {
          outcome = result.sent ? "sent" : "not_sent";
          if (result.sent) setText("");
          return;
        }
        if (result.result?.kind === "sent") {
          outcome = "sent";
          onContextSent(result.result.thread);
          setText("");
        } else {
          outcome = "not_sent";
          if (result.result?.kind === "stale") {
            toast.show({
              tone: "info",
              title: "Context changed",
              description: "Review the refreshed preview before sending.",
            });
          }
        }
      },
      onError: (error) => {
        outcome = "not_sent";
        toast.show({ tone: "danger", title: "Message not sent", description: describeSendError(error) });
      },
    });
    return outcome;
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    void send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void send();
    }
  };

  const hint =
    mode === "resume"
      ? `This thread isn't running. Sending resumes it with your message.`
      : blocked
        ? thread.status === "waiting_for_permission"
          ? "Messages can be sent once the permission decision is made."
          : isWaitingForResources(thread)
            ? "Messages can be sent once this thread starts. Stop it to cancel."
            : "Archived threads are read-only."
        : `${MOD_LABEL} Enter to send`;

  // KalVoice finds this thread's message box only through this registration (TK-2): dictation,
  // "send that", "clear that" and messages to a named thread. Read fresh on every call.
  const live = useRef({ thread, mode, hint, send });
  useLayoutEffect(() => {
    live.current = { thread, mode, hint, send };
  });
  useEffect(
    () =>
      registerComposer({
        threadId: thread.id,
        identity: () => {
          const current = live.current.thread;
          return {
            threadId: current.id,
            threadName: current.name,
            providerId: current.providerId,
            providerName: current.providerName,
            accountLabel: current.accountLabel,
          };
        },
        element: () => boxRef.current,
        mode: () => live.current.mode,
        blockedReason: () => (live.current.mode === "blocked" ? live.current.hint : null),
        hasText: () => draft.current.trim() !== "",
        submit: () => live.current.send(),
      }),
    [thread.id],
  );
  const voiceTarget = useComposerListening(thread.id);

  return (
    <>
      <form className={styles.composer} onSubmit={submit}>
        <label htmlFor="thread-composer" className="visually-hidden">
          Message
        </label>
        {/* Text, not colour: which box KalVoice will type into while the talk key is held. */}
        <p
          className={styles.voiceTarget}
          aria-live="polite"
          data-kalvoice-target={voiceTarget ? "listening" : undefined}
        >
          {voiceTarget
            ? voiceTargetLabel({
                threadId: thread.id,
                threadName: thread.name,
                providerId: thread.providerId,
                providerName: thread.providerName,
                accountLabel: thread.accountLabel,
              })
            : ""}
        </p>
        <div
          className={styles.well}
          data-disabled={blocked || undefined}
          data-kalvoice-target={voiceTarget ? "listening" : undefined}
        >
          <TextArea
            ref={boxRef}
            id="thread-composer"
            rows={3}
            value={text}
            disabled={blocked}
            onChange={(event) => {
              confirmation.cancel();
              setText(event.target.value);
            }}
            onKeyDown={onKeyDown}
            placeholder={blocked ? "" : `Message ${thread.providerName}`}
            aria-describedby="thread-composer-hint"
          />
          <ContextTray
            thread={thread}
            preview={context.preview}
            busy={context.busy}
            disabled={blocked || mode !== "send"}
            onAddInput={context.addInput}
            onAddFiles={context.addFiles}
            onSetIncluded={context.setIncluded}
            onConfirm={context.confirm}
            onDiscard={context.discard}
          />
          <div className={styles.composerFooter}>
            <p id="thread-composer-hint" className={styles.composerHint}>
              {hint}
            </p>
            <Button type="submit" variant="primary" size="sm" busy={sending} disabled={blocked || !text.trim()}>
              {mode === "resume" ? "Resume and send" : "Send"}
            </Button>
          </div>
        </div>
      </form>
      <PromptWarningDialog
        warning={confirmation.warning}
        busy={confirmation.busy}
        confirmLabel={mode === "resume" ? "Resume and send anyway" : "Send anyway"}
        onConfirm={() => void confirmation.confirm()}
        onCancel={confirmation.cancel}
      />
    </>
  );
}
