/**
 * In-memory thread runtime for unit tests and the `ui-test` Playwright build ONLY (see
 * memoryTransport.ts). Never bundled into development or production builds.
 *
 * It mirrors the native runtime's validation, status rules and events, with fixture providers
 * and workspaces and a scripted fake provider session:
 *   - every prompt streams a short reply, runs one tool ("Run npm test") and finishes the turn;
 *   - a prompt containing "slow" streams slowly (to exercise interrupt and stop);
 *   - a prompt containing "install" asks for approval (the thread waits for permission);
 *   - a prompt containing "crash" makes the provider exit unexpectedly.
 */
import type {
  AgentEvent,
  Correlation,
  EventPayload,
  EventSource,
  IpcError,
  PermissionMode,
  ProviderAccount,
  ProviderOption,
  ThreadMessage,
  ThreadOptions,
  ThreadStatus,
  ThreadSummary,
  ThreadWorktreeState,
  ToolCallRecord,
  WorkspaceOption,
} from "@kalcode/protocol";
import type { PromptReview, PromptWarning } from "../context.ts";
import { providerCatalog } from "../memoryProviders.ts";
import type { CommandName } from "../transport.ts";
import { cursorModelFixture } from "./providerAccounts.ts";

export type ThreadsScenario = "default" | "threads" | "no-providers";

export type EmitFn = (event: EventPayload, correlation?: Partial<Correlation>, source?: EventSource) => void;

// `thread_set_permission_mode` belongs to the permission engine (Z4; see ./permissions.ts).
type ThreadCommand = Exclude<Extract<CommandName, `thread_${string}`>, "thread_set_permission_mode">;
type Handler = (args: Record<string, unknown>) => unknown;

/** The permission gate as the memory runtime uses it (Z4, see ./permissions.ts). */
export interface ThreadsGate {
  /** Opens an approval request for `thread`; returns the request id. */
  open(thread: ThreadSummary): string;
  expireForThread(threadId: string): void;
}

export interface ThreadsMemory {
  handlers: Record<ThreadCommand, Handler>;
  /** Test-runtime parity with native: context reaches the provider but only userText is durable. */
  sendWithContext(
    threadId: string,
    userText: string,
    providerPayload: string,
    promptReviewId?: string | null,
  ): ThreadSummary;
  /** The user answered request `requestId` (forwarded from `approval.*`, like native). */
  resolveApproval(requestId: string, approved: boolean): void;
  stream(threadId: string, onEvent: (event: AgentEvent) => void): () => void;
  /** Test hook: live stream subscribers for a thread. */
  streamCount(threadId: string): number;
  /**
   * Provider panes (Z7-W4, ./panes.ts): creates an idle interactive thread like native
   * `create_idle`, validated like `thread_create` without a prompt. `onStop` runs when the
   * thread is stopped (`thread_stop`), so the pane's process ends with it.
   */
  createPaneThread(args: Record<string, unknown>, onStop: () => void): ThreadSummary;
  /** Test-only mirror of native title ownership; production generates task names in Rust. */
  autoNamePane(threadId: string, prompt: string): ThreadSummary;
  /** A pane's hook or process signal changed the thread's status (the one status machine). */
  setPaneStatus(threadId: string, status: ThreadStatus, activity: string | null, pendingApprovals?: number): void;
  /** Records how many files a pane agent changed (ui-test fixtures for outcomes). */
  setPaneFiles(threadId: string, filesChanged: number): void;
  /**
   * Fixture history for other surfaces' ui-test scenarios (Z7-W2 rail and home): adds a thread
   * with no live session, as if it had run earlier. Returns its summary.
   */
  seedFixture(summary: ThreadSummary, conversation?: [ThreadMessage["role"], string][]): ThreadSummary;
}

/** Mapping notes as the native registry reports them (see ../memoryProviders.ts). */
const mappingsOf = (id: string) =>
  providerCatalog().find((status) => status.id === id)?.capabilities.permissionMappings ?? [];
const modelsOf = (id: string) => providerCatalog().find((status) => status.id === id)?.capabilities.models ?? [];

const PROVIDERS: ProviderOption[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    accountLabel: "Personal",
    models: [
      { id: "sonnet", displayName: "Sonnet", isDefault: true },
      { id: "opus", displayName: "Opus", isDefault: false },
    ],
    supportsResume: true,
    supportsInterrupt: true,
    hostApprovals: true,
    permissionMappings: [],
  },
  {
    // Codex lists no models up front: New thread offers "Provider default" only.
    id: "codex",
    displayName: "Codex",
    accountLabel: null,
    models: [],
    supportsResume: true,
    supportsInterrupt: true,
    hostApprovals: false,
    permissionMappings: mappingsOf("codex"),
  },
  {
    // Documented `--model` aliases (auto, pro, flash, flash-lite).
    id: "gemini-cli",
    displayName: "Gemini CLI",
    accountLabel: null,
    models: modelsOf("gemini-cli"),
    supportsResume: true,
    supportsInterrupt: true,
    hostApprovals: false,
    permissionMappings: mappingsOf("gemini-cli"),
  },
  {
    id: "cursor",
    displayName: "Cursor",
    accountLabel: null,
    models: cursorModelFixture,
    supportsResume: true,
    supportsInterrupt: true,
    hostApprovals: false,
    permissionMappings: [],
  },
];

const WORKSPACES: WorkspaceOption[] = [
  { id: "0192f3c4-0000-7000-8000-00000000a001", name: "kalcode" },
  { id: "0192f3c4-0000-7000-8000-00000000a002", name: "kalcoded.com" },
];

const CREATE_MODES: PermissionMode[] = ["plan", "approve", "auto", "bypass"];
const MAX_PROMPT = 100_000;
const MAX_NAME = 80;
const MAX_PROMPT_REVIEWS = 64;
const PROMPT_REVIEW_TTL_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROMPT_CREDENTIAL = /\b(password|passwd|pwd|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*([^\s,;]+)/gi;

const LIVE: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "active",
  "thinking",
  "running_tool",
  "running_command",
  "editing",
  "testing",
  "reviewing",
  "recovering",
]);
const TERMINAL: ReadonlySet<ThreadStatus> = new Set(["completed", "failed", "interrupted"]);

interface MemThread {
  summary: ThreadSummary;
  messages: ThreadMessage[];
  tools: ToolCallRecord[];
  /** A provider session is attached. */
  live: boolean;
  timers: ReturnType<typeof setTimeout>[];
  buffers: Map<string, string>;
  providerSessionId: string | null;
  readThrough: number;
  archived: boolean;
  resumeStatus: ThreadStatus | null;
  /** The approval request the session is waiting on, if any. */
  pendingRequest: string | null;
  /** Set for interactive provider-pane threads (./panes.ts): ends the pane's process. */
  paneStop?: () => void;
}

function error(category: IpcError["category"], code: string, message: string): never {
  throw { category, code, message, retryable: false } satisfies IpcError;
}

const invalid = (code: string, message: string): never => error("validation", code, message);

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

// ---------------------------------------------------------------- naming (mirrors naming.rs)

const LEADING_FILLER = new Set(
  "please pls plz hey hi hello ok okay so can could would will you i i'd i'm we we'd want wanna need like to let's lets help me us kindly just go ahead and now also claude quickly try".split(
    " ",
  ),
);
const DROPPED = new Set("a an the my our your their its this that these those some any please".split(" "));
const BOUNDARIES = new Set(
  "in on at for with from into onto so because when while and but or which where by via using after before if then to of about without since until as".split(
    " ",
  ),
);
const CANONICAL: Record<string, string> = {
  oauth: "OAuth",
  api: "API",
  ui: "UI",
  css: "CSS",
  html: "HTML",
  json: "JSON",
  sql: "SQL",
  url: "URL",
  id: "ID",
  ci: "CI",
  pr: "PR",
  cli: "CLI",
  readme: "README",
  github: "GitHub",
  typescript: "TypeScript",
};

export function nameFromPrompt(prompt: string): string {
  const line = prompt.split(/\r?\n/).find((l) => /[\p{L}\p{N}]/u.test(l)) ?? "";
  const sentence = line.trim().split(/[.?!;](?:\s|$)/)[0] ?? "";
  const words = sentence
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}_#@]+|[^\p{L}\p{N}_#@]+$/gu, ""))
    .filter((w) => w && !w.includes("://"));
  let index = 0;
  while (index < words.length && LEADING_FILLER.has((words[index] ?? "").toLowerCase())) index += 1;
  const parts: { word: string; connector: boolean }[] = [];
  let content = 0;
  let length = 0;
  for (const word of words.slice(index)) {
    const lower = word.toLowerCase();
    if (DROPPED.has(lower)) continue;
    const boundary = BOUNDARIES.has(lower);
    if (boundary && (content >= 4 || content === 0)) {
      if (content === 0) continue;
      break;
    }
    const rendered = boundary ? lower : style(word);
    const added = [...rendered].length + (parts.length ? 1 : 0);
    if (length + added > 48) {
      if (!parts.length) parts.push({ word: `${[...rendered].slice(0, 47).join("")}…`, connector: false });
      break;
    }
    length += added;
    parts.push({ word: rendered, connector: boundary });
    if (!boundary && ++content >= 6) break;
  }
  while (parts.at(-1)?.connector) parts.pop();
  return parts.length ? parts.map((p) => p.word).join(" ") : "New thread";
}

function style(word: string): string {
  const canonical = CANONICAL[word.toLowerCase()];
  if (canonical) return canonical;
  if ((/[\d._/\\#@-]/.test(word) && word.length > 1) || /\p{Lu}/u.test(word.slice(1))) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// ---------------------------------------------------------------- runtime

export function createThreadsMemory(
  emit: EmitFn,
  requireCore: () => void,
  scenario: ThreadsScenario = "default",
  /** Open workspaces (Z1). The `threads` scenario adds its fixture workspaces. */
  openWorkspaces: () => WorkspaceOption[] = () => [],
  /** Providers detection reports usable (Z2); defaults to Claude Code. */
  usableProviders: () => readonly string[] = () => ["claude-code"],
  /** The permission gate (Z4). Without it, a waiting thread can only be interrupted or stopped. */
  gate: ThreadsGate | null = null,
  /** Public active account metadata; ui-test wiring uses the managed account fixture store. */
  accountFor:
    | ((
        accountId: string,
        providerId: string,
      ) => { displayName: string; authenticationState?: ProviderAccount["authenticationState"] })
    | null = null,
): ThreadsMemory {
  const threads = new Map<string, MemThread>();
  const untitledPanes = new Set<string>();
  const streams = new Map<string, Set<(event: AgentEvent) => void>>();
  const promptReviews = new Map<string, { target: PromptTarget; prompt: string; createdAt: number }>();
  // Like native `thread_options`: only providers with a thread adapter that detection reports
  // usable (installed at a supported version, not signed out) are offered.
  const offered = (): ProviderOption[] => {
    if (scenario === "no-providers") return [];
    const usable = usableProviders();
    return PROVIDERS.filter((p) => usable.includes(p.id));
  };
  const workspaces = (): WorkspaceOption[] =>
    scenario === "threads" ? [...WORKSPACES, ...openWorkspaces()] : openWorkspaces();

  const corr = (t: MemThread): Partial<Correlation> => ({
    threadId: t.summary.id,
    workspaceId: t.summary.workspaceId,
    providerId: t.summary.providerId,
  });

  const publish = (t: MemThread, event: AgentEvent) => {
    for (const listener of streams.get(t.summary.id) ?? []) listener(event);
  };

  const touch = (t: MemThread) => {
    t.summary = { ...t.summary, lastActivityAt: now() };
  };

  const setStatus = (t: MemThread, to: ThreadStatus, activity: string | null = null, source: EventSource = "core") => {
    const from = t.summary.status;
    t.summary = { ...t.summary, status: to, currentActivity: activity, lastActivityAt: now() };
    if (from !== to)
      emit(
        { type: "thread.status_changed", payload: { threadId: t.summary.id, from, to, detail: activity } },
        corr(t),
        source,
      );
  };

  const refreshUnread = (t: MemThread) => {
    const unread = t.messages.slice(t.readThrough).filter((m) => m.role === "assistant").length;
    t.summary = { ...t.summary, unreadMessages: unread };
  };

  const addMessage = (t: MemThread, role: ThreadMessage["role"], content: string, source: EventSource) => {
    const message: ThreadMessage = { id: uuid(), threadId: t.summary.id, role, content, createdAt: now() };
    t.messages.push(message);
    touch(t);
    refreshUnread(t);
    emit({ type: "agent.message", payload: { threadId: t.summary.id, messageId: message.id, role } }, corr(t), source);
    return message;
  };

  const flush = (t: MemThread) => {
    for (const [messageId, text] of t.buffers) {
      if (text.trim()) addMessage(t, "assistant", text, "provider");
      publish(t, { kind: "message_completed", messageId, text });
    }
    t.buffers.clear();
  };

  const cancelTimers = (t: MemThread) => {
    for (const timer of t.timers) clearTimeout(timer);
    t.timers = [];
  };

  const cancelTools = (t: MemThread) => {
    t.tools = t.tools.map((tool) =>
      tool.status === "requested" || tool.status === "running"
        ? { ...tool, status: "cancelled", completedAt: now() }
        : tool,
    );
  };

  const get = (args: Record<string, unknown>): MemThread => {
    requireCore();
    const id = args.threadId;
    if (typeof id !== "string" || !UUID.test(id)) invalid("invalid_thread_id", "That thread reference isn't valid.");
    const t = threads.get(id as string);
    if (!t) return invalid("thread_not_found", "That thread doesn't exist. It may have been removed.");
    return t;
  };

  const validPrompt = (value: unknown): string => {
    if (typeof value !== "string" || !value.trim()) invalid("invalid_prompt", "Write a message first.");
    if ((value as string).length > MAX_PROMPT)
      invalid("invalid_prompt", "That message is too long. Keep it under 100,000 characters.");
    return (value as string).trimEnd();
  };

  const validName = (value: unknown): string => {
    if (typeof value !== "string") return invalid("invalid_name", "Give the thread a name.");
    const name = value.split(/\s+/).filter(Boolean).join(" ");
    if (!name) invalid("invalid_name", "Give the thread a name.");
    if ([...name].length > MAX_NAME) invalid("invalid_name", `Thread names can be at most ${MAX_NAME} characters.`);
    return name;
  };

  interface PromptTarget {
    workspaceId: string;
    threadId: string | null;
    providerId: string;
    providerAccountId: string | null;
  }

  const promptDetectors = (prompt: string): Record<string, number> => {
    const detectors: Record<string, number> = {};
    for (const match of prompt.matchAll(PROMPT_CREDENTIAL)) {
      const detector = `${String(match[1]).toLowerCase().replaceAll("-", "_")}_assignment`;
      detectors[detector] = (detectors[detector] ?? 0) + 1;
    }
    return detectors;
  };

  const samePromptTarget = (left: PromptTarget, right: PromptTarget): boolean =>
    left.workspaceId === right.workspaceId &&
    left.threadId === right.threadId &&
    left.providerId === right.providerId &&
    left.providerAccountId === right.providerAccountId;

  const purgePromptReviews = () => {
    const cutoff = Date.now() - PROMPT_REVIEW_TTL_MS;
    for (const [id, review] of promptReviews) if (review.createdAt <= cutoff) promptReviews.delete(id);
  };

  const reviewPrompt = (target: PromptTarget, prompt: string): PromptReview => {
    const detectors = promptDetectors(prompt);
    if (Object.keys(detectors).length === 0) return { kind: "clean" };
    purgePromptReviews();
    if (promptReviews.size >= MAX_PROMPT_REVIEWS) {
      error(
        "validation",
        "context_prompt_review_capacity",
        "Too many prompt reviews are waiting. Finish or let an earlier review expire, then try again.",
      );
    }
    const warning: PromptWarning = { reviewId: uuid(), detectors };
    promptReviews.set(warning.reviewId, { target, prompt, createdAt: Date.now() });
    return { kind: "confirmation_required", warning };
  };

  const admitPrompt = (target: PromptTarget, prompt: string, reviewId: unknown): void => {
    const warned = Object.keys(promptDetectors(prompt)).length > 0;
    if (reviewId == null) {
      if (warned) {
        error(
          "permission",
          "context_prompt_confirmation_required",
          "This prompt may contain a secret. Review the warning and confirm this exact prompt before sending.",
        );
      }
      return;
    }
    if (typeof reviewId !== "string" || !UUID.test(reviewId)) {
      error(
        "permission",
        "context_prompt_confirmation_invalid",
        "That prompt confirmation is expired, already used, or belongs to different content or a different destination.",
      );
    }
    purgePromptReviews();
    const sealed = promptReviews.get(reviewId);
    promptReviews.delete(reviewId);
    if (!sealed || !warned || !samePromptTarget(sealed.target, target) || sealed.prompt !== prompt) {
      error(
        "permission",
        "context_prompt_confirmation_invalid",
        "That prompt confirmation is expired, already used, or belongs to different content or a different destination.",
      );
    }
  };

  /** Runs one scripted provider turn for `prompt`. */
  const runTurn = (t: MemThread, prompt: string) => {
    const lower = prompt.toLowerCase();
    const slow = lower.includes("slow");
    const step = slow ? 450 : 45;
    let at = 150;
    const later = (ms: number, fn: () => void) => {
      at += ms;
      t.timers.push(
        setTimeout(() => {
          if (t.live) fn();
        }, at),
      );
    };
    const streamText = (messageId: string, text: string) => {
      for (const word of text.split(/(?<= )/)) {
        later(step, () => {
          t.buffers.set(messageId, (t.buffers.get(messageId) ?? "") + word);
          publish(t, { kind: "message_delta", messageId, text: word });
        });
      }
      later(step, () => {
        const full = t.buffers.get(messageId) ?? text;
        t.buffers.delete(messageId);
        addMessage(t, "assistant", full, "provider");
        publish(t, { kind: "message_completed", messageId, text: full });
      });
    };

    later(0, () => setStatus(t, "thinking", "Reading the relevant files", "provider"));
    if (lower.includes("crash")) {
      later(200, () => {
        t.live = false;
        cancelTimers(t);
        flush(t);
        cancelTools(t);
        const message =
          "The provider stopped unexpectedly (exit code 1). The conversation is saved; resume the thread to continue.";
        setStatus(t, "failed");
        t.summary = { ...t.summary, error: { code: "provider_exited", message } };
        emit({ type: "thread.failed", payload: { threadId: t.summary.id, code: "provider_exited", message } }, corr(t));
      });
      return;
    }
    streamText(uuid(), "I'll read the relevant files first, make the change, then run the test suite to confirm it.");
    if (lower.includes("install")) {
      later(120, () => {
        t.resumeStatus = t.summary.status;
        t.summary = { ...t.summary, pendingApprovals: 1 };
        t.pendingRequest = gate?.open(t.summary) ?? null;
        setStatus(t, "waiting_for_permission", "Waiting for approval: Run npm install lodash");
      });
      return;
    }
    const toolId = uuid();
    later(120, () => {
      const tool: ToolCallRecord = {
        id: toolId,
        threadId: t.summary.id,
        tool: "Bash",
        summary: "Run npm test",
        status: "requested",
        resultSummary: null,
        requestedAt: now(),
        startedAt: null,
        completedAt: null,
      };
      t.tools.push(tool);
      emit(
        {
          type: "tool.requested",
          payload: { threadId: t.summary.id, toolCallId: toolId, tool: "Bash", summary: tool.summary },
        },
        corr(t),
        "provider",
      );
    });
    later(80, () => {
      t.tools = t.tools.map((x) => (x.id === toolId ? { ...x, status: "running", startedAt: now() } : x));
      emit({ type: "tool.started", payload: { threadId: t.summary.id, toolCallId: toolId } }, corr(t), "provider");
      setStatus(t, "running_tool", "Run npm test", "provider");
    });
    later(slow ? 2_500 : 450, () => {
      t.tools = t.tools.map((x) =>
        x.id === toolId ? { ...x, status: "completed", resultSummary: "42 tests passed", completedAt: now() } : x,
      );
      emit({ type: "tool.completed", payload: { threadId: t.summary.id, toolCallId: toolId } }, corr(t), "provider");
      setStatus(t, "active", null, "provider");
      emit(
        { type: "file.modified", payload: { threadId: t.summary.id, path: "src/auth/callback.ts" } },
        corr(t),
        "provider",
      );
      t.summary = { ...t.summary, filesChanged: (t.summary.filesChanged ?? 0) + 1 };
    });
    streamText(uuid(), "Done. The change is in place and all 42 tests pass.");
    later(60, () => {
      if (t.summary.status !== "paused") setStatus(t, "idle", null, "provider");
    });
  };

  const startSession = (t: MemThread, resumeId: string | null, firstInput: string | null) => {
    t.live = true;
    t.buffers.clear();
    t.summary = { ...t.summary, error: null };
    emit({ type: "thread.started", payload: { threadId: t.summary.id } }, corr(t));
    const provider = PROVIDERS.find((p) => p.id === t.summary.providerId);
    if (!resumeId && t.messages.length && !provider?.supportsResume) {
      addMessage(
        t,
        "system",
        "Started a new provider session. The earlier conversation couldn't be restored, so the provider won't remember the messages above.",
        "core",
      );
    }
    t.providerSessionId = t.providerSessionId ?? `session-${t.summary.id.slice(0, 8)}`;
    t.summary = { ...t.summary, resumable: provider?.supportsResume === true };
    if (firstInput) send(t, firstInput);
    else setStatus(t, "idle");
  };

  const send = (t: MemThread, userText: string, providerPayload = userText) => {
    addMessage(t, "user", userText, "ui");
    setStatus(t, "active");
    runTurn(t, providerPayload);
  };

  const sendExisting = (
    threadId: unknown,
    userText: unknown,
    providerPayload: unknown,
    promptReviewId: unknown,
  ): ThreadSummary => {
    const t = get({ threadId });
    const text = validPrompt(userText);
    const payload = validPrompt(providerPayload);
    admitPrompt(threadTarget(t), text, promptReviewId);
    if (t.archived) invalid("thread_archived", "This thread is archived.");
    if (!t.live) invalid("thread_not_running", "This thread isn't running. Resume it to continue.");
    if (t.paneStop) invalid("thread_in_pane", "This thread runs in a pane. Type in the pane instead.");
    if (t.summary.pendingApprovals > 0)
      invalid(
        "thread_waiting_for_permission",
        "This thread is waiting for a permission decision. Answer it or interrupt the turn first.",
      );
    send(t, text, payload);
    return summary(t);
  };

  const summary = (t: MemThread): ThreadSummary => ({
    ...t.summary,
    canMoveWorkspace:
      !t.archived &&
      t.summary.runtimeKind !== "interactive_pty" &&
      !t.summary.worktreeId &&
      !t.summary.pendingApprovals &&
      ["idle", "waiting_for_user", "completed", "interrupted", "failed", "offline"].includes(t.summary.status),
  });

  /** The user's answer reached the session: run the install (approved) or go on without it. */
  const continueAfterApproval = (t: MemThread, approved: boolean) => {
    t.pendingRequest = null;
    t.summary = { ...t.summary, pendingApprovals: 0 };
    setStatus(t, "active");
    let at = 0;
    const later = (ms: number, fn: () => void) => {
      at += ms;
      t.timers.push(
        setTimeout(() => {
          if (t.live) fn();
        }, at),
      );
    };
    const reply = (text: string) => {
      const messageId = uuid();
      later(120, () => {
        addMessage(t, "assistant", text, "provider");
        publish(t, { kind: "message_completed", messageId, text });
      });
    };
    if (approved) {
      const toolId = uuid();
      later(60, () => {
        t.tools.push({
          id: toolId,
          threadId: t.summary.id,
          tool: "Bash",
          summary: "Run npm install lodash",
          status: "running",
          resultSummary: null,
          requestedAt: now(),
          startedAt: now(),
          completedAt: null,
        });
        emit(
          {
            type: "tool.requested",
            payload: { threadId: t.summary.id, toolCallId: toolId, tool: "Bash", summary: "Run npm install lodash" },
          },
          corr(t),
          "provider",
        );
        emit({ type: "tool.started", payload: { threadId: t.summary.id, toolCallId: toolId } }, corr(t), "provider");
        setStatus(t, "running_command", "Run npm install lodash", "provider");
      });
      later(300, () => {
        t.tools = t.tools.map((x) =>
          x.id === toolId ? { ...x, status: "completed", resultSummary: "added 1 package", completedAt: now() } : x,
        );
        emit({ type: "tool.completed", payload: { threadId: t.summary.id, toolCallId: toolId } }, corr(t), "provider");
        setStatus(t, "active", null, "provider");
      });
      reply("Installed lodash and wired up the debounce helper.");
    } else {
      reply("Understood, I won't install lodash. I'll write a small debounce helper instead.");
    }
    later(60, () => {
      if (t.summary.status !== "paused") setStatus(t, "idle", null, "provider");
    });
  };

  const endSession = (t: MemThread, activity: string) => {
    t.paneStop?.();
    if (t.pendingRequest) gate?.expireForThread(t.summary.id);
    t.pendingRequest = null;
    cancelTimers(t);
    t.live = false;
    flush(t);
    cancelTools(t);
    t.summary = { ...t.summary, pendingApprovals: 0, restartRecoverable: false };
    setStatus(t, "interrupted", activity);
  };

  interface CreationPlan {
    provider: ProviderOption;
    workspace: WorkspaceOption;
    providerAccountId: string | null;
    accountLabel: string | null;
    model: string | null;
    mode: PermissionMode;
    prompt: string | null;
    name: string;
    /** Agent Fleet: run in the thread's own worktree and branch. */
    isolate: boolean;
  }

  /** Validates and resolves a create request without writing thread or provider state. */
  const planThread = (
    args: Record<string, unknown>,
    readPrompt: ((args: Record<string, unknown>) => string) | null,
  ): CreationPlan => {
    requireCore();
    const providerId = args.providerId;
    if (typeof providerId !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(providerId))
      invalid("invalid_provider", "That provider reference isn't valid.");
    if (typeof args.workspaceId !== "string" || !UUID.test(args.workspaceId))
      invalid("invalid_workspace_id", "That workspace reference isn't valid.");
    const mode = args.permissionMode as PermissionMode;
    if (!CREATE_MODES.includes(mode)) error("internal", "ipc_rejected", "KalCode couldn't complete that request.");
    const prompt = readPrompt ? readPrompt(args) : null;
    const provider = offered().find((p) => p.id === providerId);
    if (!provider)
      return error(
        "provider",
        "provider_unavailable",
        `${providerId} isn't connected to KalCode. Connect it in Providers, then try again.`,
      );
    const model = args.model == null || args.model === "" ? null : String(args.model);
    if (model && !provider.models.some((m) => m.id === model))
      invalid("invalid_model", `That model isn't available for ${provider.displayName}.`);
    const providerAccountId =
      args.providerAccountId == null || args.providerAccountId === "" ? null : String(args.providerAccountId);
    if (providerAccountId !== null && !UUID.test(providerAccountId))
      invalid("provider_account_id_invalid", "That provider account reference isn't valid.");
    const selectedAccount =
      providerAccountId === null || accountFor === null ? null : accountFor(providerAccountId, provider.id);
    const workspace = workspaces().find((w) => w.id === args.workspaceId);
    if (!workspace)
      return error(
        "filesystem",
        "workspace_not_found",
        "That workspace isn't available. It may have been removed from KalCode.",
      );
    const accountLabel = selectedAccount?.displayName ?? (providerAccountId === null ? provider.accountLabel : null);
    const name =
      args.name == null || String(args.name).trim() === ""
        ? prompt === null || Object.keys(promptDetectors(prompt)).length > 0
          ? "New thread"
          : nameFromPrompt(prompt)
        : validName(args.name);
    const isolate = args.isolate === true;
    // Like native: a folder outside Git can't host a worktree (memory git_status treats "notes"
    // and "scratch" workspaces as plain folders).
    if (isolate && (workspace.name.includes("notes") || workspace.name.includes("scratch")))
      error(
        "git",
        "worktree_unavailable",
        "This workspace isn't a Git repository, so the thread can't get its own worktree.",
      );
    return { provider, workspace, providerAccountId, accountLabel, model, mode, prompt, name, isolate };
  };

  const createTarget = (plan: CreationPlan): PromptTarget => ({
    workspaceId: plan.workspace.id,
    threadId: null,
    providerId: plan.provider.id,
    providerAccountId: plan.providerAccountId,
  });

  const threadTarget = (thread: MemThread): PromptTarget => ({
    workspaceId: thread.summary.workspaceId,
    threadId: thread.summary.id,
    providerId: thread.summary.providerId,
    providerAccountId: thread.summary.providerAccountId,
  });

  /** Records one previously validated creation plan and emits `thread.created`. */
  const insertThread = (
    plan: CreationPlan,
    runtimeKind: ThreadSummary["runtimeKind"] = null,
  ): { thread: MemThread; prompt: string | null } => {
    const { provider, workspace, providerAccountId, accountLabel, model, mode, prompt, name, isolate } = plan;
    const created = now();
    const id = uuid();
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "agent";
    const t: MemThread = {
      summary: {
        id,
        name,
        providerId: provider.id,
        providerName: provider.displayName,
        model,
        effort: null,
        providerAccountId,
        // Snapshot only metadata resolved by the managed-account fixture store. Direct unit
        // construction without a resolver retains its bounded legacy provider label.
        accountLabel,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        permissionMode: mode,
        status: "starting",
        currentActivity: null,
        createdAt: created,
        lastActivityAt: created,
        pendingApprovals: 0,
        unreadMessages: 0,
        filesChanged: 0,
        branch: isolate ? `kal/${slug}-${id.slice(-8)}` : null,
        worktreeId: isolate ? uuid() : null,
        error: null,
        archivedAt: null,
        resumable: false,
        permissionProfileId: null,
        runtimeKind,
        terminalId: null,
      },
      messages: [],
      tools: [],
      live: false,
      timers: [],
      buffers: new Map(),
      providerSessionId: null,
      readThrough: 0,
      archived: false,
      resumeStatus: null,
      pendingRequest: null,
    };
    threads.set(t.summary.id, t);
    emit(
      {
        type: "thread.created",
        payload: { threadId: t.summary.id, name, providerId: provider.id, workspaceId: workspace.id },
      },
      corr(t),
    );
    return { thread: t, prompt };
  };

  // Agent Fleet worktree facts: a fresh worktree is level with main and merges cleanly; the agent's
  // edits are uncommitted until the person commits them (the memory runtime's agents don't commit).
  const committed = new Map<string, { ahead: number; files: number }>();
  const worktreeFacts = (t: MemThread) => {
    const done = committed.get(t.summary.id);
    return {
      ahead: done?.ahead ?? 0,
      changed: Math.max(0, (t.summary.filesChanged ?? 0) - (done?.files ?? 0)),
    };
  };
  const worktreeState = (t: MemThread): ThreadWorktreeState | null => {
    if (!t.summary.worktreeId || !t.summary.branch) return null;
    const facts = worktreeFacts(t);
    return {
      threadId: t.summary.id,
      worktreeId: t.summary.worktreeId,
      branch: t.summary.branch,
      baseBranch: "main",
      ahead: facts.ahead,
      behind: 0,
      changed: facts.changed,
      untracked: 0,
      conflicts: false,
      changedPaths: [],
      changedPathsTruncated: false,
      observedAt: now(),
    };
  };

  const handlers: Record<ThreadCommand, Handler> = {
    thread_options: (): ThreadOptions => {
      requireCore();
      return {
        providers: offered(),
        workspaces: workspaces(),
        permissionModes: CREATE_MODES,
        defaultPermissionMode: "bypass",
      };
    },
    thread_list: (args) => {
      requireCore();
      const workspaceId = args.workspaceId;
      if (workspaceId != null && (typeof workspaceId !== "string" || !UUID.test(workspaceId)))
        invalid("invalid_workspace_id", "That workspace reference isn't valid.");
      return [...threads.values()]
        .filter((t) => (args.includeArchived ? true : !t.archived))
        .filter((t) => workspaceId == null || t.summary.workspaceId === workspaceId)
        .map(summary)
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    },
    thread_get: (args) => summary(get(args)),
    thread_messages: (args) => {
      const t = get(args);
      const limit = Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        invalid("invalid_page_size", "Page size must be between 1 and 500.");
      let end = t.messages.length;
      if (args.before != null) {
        end = t.messages.findIndex((m) => m.id === args.before);
        if (end < 0) invalid("invalid_cursor", "The message cursor is invalid.");
      } else {
        t.readThrough = t.messages.length;
        refreshUnread(t);
      }
      return t.messages.slice(Math.max(0, end - limit), end);
    },
    thread_tool_calls: (args) => {
      const t = get(args);
      const limit = Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        invalid("invalid_page_size", "Page size must be between 1 and 500.");
      return t.tools.slice(-limit);
    },
    thread_review_create_prompt: (args) => {
      const plan = planThread(args, (a) => validPrompt(a.prompt));
      return reviewPrompt(createTarget(plan), plan.prompt as string);
    },
    thread_review_prompt: (args) => {
      const t = get(args);
      return reviewPrompt(threadTarget(t), validPrompt(args.text));
    },
    thread_cancel_prompt_review: (args) => {
      purgePromptReviews();
      return typeof args.reviewId === "string" && promptReviews.delete(args.reviewId);
    },
    thread_create: (args) => {
      const plan = planThread(args, (a) => validPrompt(a.prompt));
      admitPrompt(createTarget(plan), plan.prompt as string, args.promptReviewId);
      const { thread: t, prompt } = insertThread(plan);
      startSession(t, null, prompt);
      return summary(t);
    },
    thread_send: (args) => {
      return sendExisting(args.threadId, args.text, args.text, args.promptReviewId);
    },
    // Agent Fleet: a fresh worktree is clean, level with main and merges cleanly; the agent's
    // edits show as uncommitted changes (the memory runtime doesn't commit).
    thread_worktree_states: (args) => {
      requireCore();
      const ids = Array.isArray(args.threadIds) ? (args.threadIds as unknown[]) : [];
      if (ids.length > 64 || ids.some((id) => typeof id !== "string" || !UUID.test(id)))
        invalid("invalid_thread_ids", "Those thread references aren't valid.");
      return ids.flatMap((id) => {
        const t = threads.get(id as string);
        return t ? (worktreeState(t) ?? []) : [];
      });
    },
    // Like native: KalCode commits the isolated agent's changes on its branch, never while it works.
    thread_worktree_commit: (args) => {
      requireCore();
      const t = get(args);
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (!message || message.length > 2000) invalid("invalid_commit_message", "Write a commit message first.");
      if (!worktreeState(t)) error("git", "worktree_unavailable", "This agent doesn't run in its own worktree.");
      if (t.live && LIVE.has(t.summary.status))
        invalid("thread_busy", "Stop or wait for the agent before committing its work.");
      const facts = worktreeFacts(t);
      if (facts.changed === 0) invalid("nothing_to_commit", "There are no changes to commit.");
      committed.set(t.summary.id, { ahead: facts.ahead + 1, files: t.summary.filesChanged ?? 0 });
      return worktreeState(t);
    },
    thread_interrupt: (args) => {
      const t = get(args);
      if (!t.live) invalid("thread_not_running", "This thread isn't running. Resume it to continue.");
      if (!LIVE.has(t.summary.status) && t.summary.status !== "waiting_for_permission")
        invalid("thread_not_working", "This thread isn't working on anything right now.");
      // Like native: interrupting denies what the turn was waiting on, so its requests expire.
      if (t.pendingRequest) gate?.expireForThread(t.summary.id);
      t.pendingRequest = null;
      cancelTimers(t);
      flush(t);
      cancelTools(t);
      t.summary = { ...t.summary, pendingApprovals: 0 };
      setStatus(t, "idle", "Interrupted by you");
      return summary(t);
    },
    thread_stop: (args) => {
      const t = get(args);
      if (!t.live) {
        if (TERMINAL.has(t.summary.status))
          invalid("thread_not_running", "This thread isn't running. Resume it to continue.");
        t.summary = { ...t.summary, restartRecoverable: false };
        setStatus(t, "interrupted", "Stopped by you");
        return summary(t);
      }
      endSession(t, "Stopped by you");
      return summary(t);
    },
    // Start Anyway: the memory runtime never holds a launch for resources, so a thread that isn't
    // held is returned unchanged (as native).
    thread_start_anyway: (args) => summary(get(args)),
    thread_resume: (args) => {
      const t = get(args);
      if (t.archived) invalid("thread_archived", "This thread is archived.");
      if (args.allowPendingInput !== undefined && typeof args.allowPendingInput !== "boolean") {
        error("internal", "ipc_rejected", "KalCode couldn't complete that request.");
      }
      const allowPendingInput = args.allowPendingInput !== false;
      const text = args.text == null || String(args.text).trim() === "" ? null : validPrompt(args.text);
      if (text) admitPrompt(threadTarget(t), text, args.promptReviewId);
      else if (args.promptReviewId != null) {
        error(
          "permission",
          "context_prompt_confirmation_invalid",
          "A prompt confirmation cannot be used when no prompt is being sent.",
        );
      }
      if (!allowPendingInput && t.summary.resumeHasPendingInput === true) {
        invalid(
          "thread_resume_has_pending_input",
          "This session has a queued task that was not sent. Choose Resume queued task to send it.",
        );
      }
      if (t.live) {
        if (t.summary.status !== "paused") invalid("thread_already_running", "This thread is already running.");
        t.summary = { ...t.summary, resumeHasPendingInput: false };
        setStatus(t, "idle");
        if (text) send(t, text);
        return summary(t);
      }
      const provider = offered().find((p) => p.id === t.summary.providerId);
      if (!provider)
        return error(
          "provider",
          "provider_unavailable",
          `${t.summary.providerName} isn't connected to KalCode. Connect it in Providers, then try again.`,
        );
      t.summary = { ...t.summary, resumeHasPendingInput: false };
      setStatus(t, "starting", "Resuming");
      startSession(t, provider.supportsResume ? t.providerSessionId : null, text);
      return summary(t);
    },
    thread_rename: (args) => {
      const t = get(args);
      const name = validName(args.name);
      untitledPanes.delete(t.summary.id);
      if (name !== t.summary.name) {
        t.summary = { ...t.summary, name };
        emit({ type: "thread.renamed", payload: { threadId: t.summary.id, name } }, corr(t), "ui");
      }
      return summary(t);
    },
    thread_duplicate: (args) => {
      const source = get(args);
      if (source.summary.runtimeKind === "interactive_pty")
        invalid("thread_is_coding_agent", "Duplicate coding agents from their Code pane.");
      if (!workspaces().some((w) => w.id === source.summary.workspaceId))
        invalid("workspace_not_found", "That workspace is no longer available.");
      const id = uuid();
      const createdAt = now();
      const copy: MemThread = {
        summary: {
          ...source.summary,
          id,
          name: `${[...source.summary.name].slice(0, 73).join("")} (copy)`,
          status: "idle",
          currentActivity: "Copied conversation; starts a new provider session",
          createdAt,
          lastActivityAt: createdAt,
          pendingApprovals: 0,
          unreadMessages: 0,
          filesChanged: 0,
          branch: null,
          worktreeId: null,
          error: null,
          archivedAt: null,
          resumable: false,
          runtimeKind: "headless",
          terminalId: null,
        },
        messages: source.messages.map((message) => ({ ...message, id: uuid(), threadId: id })),
        tools: [],
        live: false,
        timers: [],
        buffers: new Map(),
        providerSessionId: null,
        readThrough: source.messages.length,
        archived: false,
        resumeStatus: null,
        pendingRequest: null,
      };
      threads.set(id, copy);
      emit(
        {
          type: "thread.created",
          payload: {
            threadId: id,
            name: copy.summary.name,
            providerId: copy.summary.providerId,
            workspaceId: copy.summary.workspaceId,
          },
        },
        corr(copy),
        "ui",
      );
      return summary(copy);
    },
    thread_move: (args) => {
      const t = get(args);
      if (typeof args.workspaceId !== "string" || !UUID.test(args.workspaceId))
        invalid("invalid_workspace_id", "That workspace reference isn't valid.");
      const workspace = workspaces().find((w) => w.id === args.workspaceId);
      if (!workspace) return invalid("workspace_not_found", "That workspace is no longer available.");
      if (t.summary.runtimeKind === "interactive_pty")
        invalid("thread_is_coding_agent", "Coding agents remain in the workspace of their Code pane.");
      if (t.archived) invalid("thread_archived", "This thread is archived.");
      if (t.summary.worktreeId)
        invalid("thread_move_worktree", "Threads with their own worktree cannot move to another workspace.");
      if (
        t.summary.pendingApprovals > 0 ||
        !["idle", "waiting_for_user", "completed", "interrupted", "failed", "offline"].includes(t.summary.status)
      )
        invalid("thread_move_busy", "Stop the thread before moving it.");
      if (t.summary.workspaceId === workspace.id) return summary(t);
      const fromWorkspaceId = t.summary.workspaceId;
      if (t.live) endSession(t, "Moved to another workspace");
      t.providerSessionId = null;
      t.summary = {
        ...t.summary,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        status: "idle",
        currentActivity: "Moved to another workspace",
        error: null,
        resumable: false,
        lastActivityAt: now(),
      };
      emit(
        { type: "thread.moved", payload: { threadId: t.summary.id, fromWorkspaceId, workspaceId: workspace.id } },
        { ...corr(t), workspaceId: fromWorkspaceId },
        "ui",
      );
      return summary(t);
    },
    thread_archive: (args) => {
      const t = get(args);
      if (t.archived) return summary(t);
      // Like native: an idle session (no turn, no approval) ends with the archive.
      if (t.live) {
        if (t.summary.status !== "idle" && t.summary.status !== "waiting_for_user") {
          invalid("thread_running", "Stop the thread before archiving it.");
        }
        endSession(t, "Archived");
      }
      t.archived = true;
      t.summary = { ...t.summary, archivedAt: now() };
      emit({ type: "thread.archived", payload: { threadId: t.summary.id } }, corr(t), "ui");
      return summary(t);
    },
    // Like native `thread_unarchive`: idempotent, and only a restore records the event.
    thread_unarchive: (args) => {
      const t = get(args);
      if (!t.archived) return summary(t);
      t.archived = false;
      t.summary = { ...t.summary, archivedAt: null };
      emit({ type: "thread.unarchived", payload: { threadId: t.summary.id } }, corr(t), "ui");
      return summary(t);
    },
    // Like native `thread_rebind_account`: future provider requests use the new account, past
    // messages stay, and the account-scoped resume id is cleared so the next start is fresh. Same
    // refusal order as native: archived thread, account (id, owner, removal), current account is
    // a no-op, sign-in state, then pending approval / busy. An idle live session is ended first
    // (native releases the old profile lease), leaving the thread resumable as "completed".
    thread_rebind_account: (args) => {
      const t = get(args);
      if (t.archived) invalid("thread_archived", "This thread is archived.");
      const accountId = typeof args.providerAccountId === "string" ? args.providerAccountId : "";
      if (!UUID.test(accountId)) invalid("provider_account_id_invalid", "That account or binding id isn't valid.");
      if (accountFor === null) {
        return error(
          "internal",
          "thread_rebind_unavailable",
          "Switching a thread's provider account isn't available in this build yet.",
        );
      }
      let target: ReturnType<NonNullable<typeof accountFor>>;
      try {
        target = accountFor(accountId, t.summary.providerId);
      } catch (e) {
        // Native rebind names an id it never had `provider_account_unknown` (create keeps
        // `provider_account_not_found` for an account it can't resolve).
        if ((e as { code?: string }).code === "provider_account_not_found") {
          invalid("provider_account_unknown", "That provider account no longer exists.");
        }
        throw e;
      }
      if (t.summary.providerAccountId === accountId) return summary(t);
      if (target.authenticationState === "not_authenticated") {
        return error(
          "provider",
          "provider_account_not_authenticated",
          `${target.displayName} isn't signed in. Sign in to ${target.displayName} in Providers, then switch.`,
        );
      }
      if (t.summary.status === "waiting_for_permission" || t.summary.pendingApprovals > 0 || t.pendingRequest) {
        invalid(
          "thread_rebind_pending_approval",
          "Answer or deny the pending approval, or stop the thread, before switching accounts.",
        );
      }
      if (LIVE.has(t.summary.status)) {
        invalid("thread_rebind_busy", "Wait for the current turn to finish or stop the thread first.");
      }
      if (t.live) {
        t.paneStop?.();
        cancelTimers(t);
        t.live = false;
        flush(t);
        cancelTools(t);
        setStatus(t, "completed", "Switched provider account", "ui");
      }
      t.providerSessionId = null;
      t.summary = { ...t.summary, providerAccountId: accountId, accountLabel: target.displayName, resumable: false };
      emit(
        {
          type: "thread.account_changed",
          payload: { threadId: t.summary.id, providerAccountId: accountId, accountLabel: target.displayName },
        },
        corr(t),
        "ui",
      );
      return summary(t);
    },
    thread_stream: () => error("internal", "use_stream_thread", "Use streamThread()."),
  };

  if (scenario === "threads") seed(threads);

  return {
    handlers,
    sendWithContext: (threadId, userText, providerPayload, promptReviewId) =>
      sendExisting(threadId, userText, providerPayload, promptReviewId),
    stream(threadId, onEvent) {
      requireCore();
      const t = threads.get(threadId);
      if (!t) invalid("thread_not_found", "That thread doesn't exist. It may have been removed.");
      for (const [messageId, text] of t?.buffers ?? []) onEvent({ kind: "message_delta", messageId, text });
      const set = streams.get(threadId) ?? new Set();
      set.add(onEvent);
      streams.set(threadId, set);
      return () => {
        set.delete(onEvent);
      };
    },
    streamCount: (threadId) => streams.get(threadId)?.size ?? 0,
    createPaneThread(args, onStop) {
      // Mirror the native clean provider default; task naming remains native-authoritative.
      const plan = planThread(args, null);
      const named = args.name != null && String(args.name).trim() !== "";
      const { thread: t } = insertThread(
        named ? plan : { ...plan, name: plan.provider.displayName },
        "interactive_pty",
      );
      if (!named) untitledPanes.add(t.summary.id);
      const effort = typeof args.effort === "string" ? args.effort.trim().toLowerCase() : "";
      if (effort && effort !== "default") t.summary = { ...t.summary, effort };
      t.paneStop = onStop;
      t.live = true;
      t.providerSessionId = `session-${t.summary.id.slice(0, 8)}`;
      t.summary = { ...t.summary, resumable: plan.provider.supportsResume };
      emit({ type: "thread.started", payload: { threadId: t.summary.id } }, corr(t));
      return summary(t);
    },
    autoNamePane(threadId, prompt) {
      const t = get({ threadId });
      if (untitledPanes.delete(threadId)) {
        const name = nameFromPrompt(prompt);
        t.summary = { ...t.summary, name };
        emit({ type: "thread.renamed", payload: { threadId, name } }, corr(t), "provider");
      }
      return summary(t);
    },
    setPaneStatus(threadId, status, activity, pendingApprovals) {
      const t = threads.get(threadId);
      if (!t) return;
      if (pendingApprovals !== undefined) t.summary = { ...t.summary, pendingApprovals };
      if (TERMINAL.has(status)) t.live = false;
      setStatus(t, status, activity, "provider");
    },
    setPaneFiles(threadId, filesChanged) {
      const t = threads.get(threadId);
      if (t) t.summary = { ...t.summary, filesChanged };
    },
    resolveApproval(requestId, approved) {
      for (const t of threads.values()) {
        if (t.pendingRequest === requestId && t.live) continueAfterApproval(t, approved);
      }
    },
    seedFixture(fixture, conversation = []) {
      const id = fixture.id;
      threads.set(id, {
        summary: fixture,
        messages: conversation.map(([role, content], i) => ({
          id: uuid(),
          threadId: id,
          role,
          content,
          createdAt: new Date(new Date(fixture.createdAt).getTime() + i * 60_000).toISOString(),
        })),
        tools: [],
        live: false,
        timers: [],
        buffers: new Map(),
        providerSessionId: fixture.resumable ? `session-${id.slice(-8)}` : null,
        readThrough: conversation.length,
        archived: fixture.archivedAt !== null,
        resumeStatus: null,
        pendingRequest: null,
      });
      return fixture;
    },
  };
}

// ---------------------------------------------------------------- fixtures ("threads" scenario)

function seed(threads: Map<string, MemThread>) {
  const claude = PROVIDERS[0] as ProviderOption;
  const codex = PROVIDERS[1] as ProviderOption;
  const [kalcode, site] = WORKSPACES as [WorkspaceOption, WorkspaceOption];
  const make = (
    partial: Partial<ThreadSummary> & Pick<ThreadSummary, "name" | "status">,
    provider: ProviderOption,
    workspace: WorkspaceOption,
    minutes: number,
    live: boolean,
    conversation: [ThreadMessage["role"], string][],
    tools: Omit<ToolCallRecord, "id" | "threadId">[] = [],
    archived = false,
  ) => {
    const id = uuid();
    const created = minutesAgo(minutes + 30);
    const t: MemThread = {
      summary: {
        id,
        providerId: provider.id,
        providerName: provider.displayName,
        model: provider.models[0]?.id ?? null,
        effort: null,
        providerAccountId: null,
        accountLabel: provider.accountLabel,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        permissionMode: "approve",
        currentActivity: null,
        createdAt: created,
        lastActivityAt: minutesAgo(minutes),
        pendingApprovals: 0,
        unreadMessages: 0,
        filesChanged: 0,
        branch: null,
        worktreeId: null,
        error: null,
        archivedAt: archived ? minutesAgo(minutes) : null,
        resumable: false,
        permissionProfileId: null,
        runtimeKind: null,
        terminalId: null,
        ...partial,
      },
      messages: conversation.map(([role, content], i) => ({
        id: uuid(),
        threadId: id,
        role,
        content,
        createdAt: new Date(new Date(created).getTime() + i * 60_000).toISOString(),
      })),
      tools: tools.map((tool) => ({ ...tool, id: uuid(), threadId: id })),
      live,
      timers: [],
      buffers: new Map(),
      providerSessionId: live ? `session-${id.slice(-8)}` : null,
      readThrough: 0,
      archived,
      resumeStatus: null,
      pendingRequest: null,
    };
    t.readThrough = Math.max(0, t.messages.length - (partial.unreadMessages ?? 0));
    threads.set(id, t);
  };

  make(
    { name: "Fix OAuth Callback Race", status: "running_tool", currentActivity: "Run npm test", filesChanged: 3 },
    claude,
    kalcode,
    1,
    true,
    [
      [
        "user",
        "Fix the OAuth callback race in the login flow. Two tabs finishing sign-in at once can overwrite each other's session.",
      ],
      [
        "assistant",
        "The callback handler writes the session before checking the state parameter, so the second tab wins. I'll check the state first and make the write conditional.",
      ],
    ],
    [
      {
        tool: "Read",
        summary: "Read src/auth/callback.ts",
        status: "completed",
        resultSummary: null,
        requestedAt: minutesAgo(20),
        startedAt: minutesAgo(20),
        completedAt: minutesAgo(20),
      },
      {
        tool: "Bash",
        summary: "Run npm test",
        status: "running",
        resultSummary: null,
        requestedAt: minutesAgo(1),
        startedAt: minutesAgo(1),
        completedAt: null,
      },
    ],
  );
  make(
    {
      name: "Add Dark Mode Toggle",
      status: "waiting_for_permission",
      currentActivity: "Waiting for approval: Run npm install lodash",
      pendingApprovals: 1,
      permissionMode: "auto",
    },
    codex,
    site,
    4,
    true,
    [
      ["user", "Add a dark mode toggle to the settings page."],
      ["assistant", "I need lodash for the debounce helper, so I'm asking to install it."],
    ],
  );
  make(
    { name: "Write Unit Tests for Parser Module", status: "idle", unreadMessages: 1, filesChanged: 2 },
    claude,
    kalcode,
    12,
    true,
    [
      ["user", "Write unit tests for the parser module."],
      ["assistant", "Added 14 tests covering nested lists, escapes and malformed input. All pass."],
    ],
    [
      {
        tool: "Bash",
        summary: "Run cargo test -p parser",
        status: "completed",
        resultSummary: "14 passed",
        requestedAt: minutesAgo(13),
        startedAt: minutesAgo(13),
        completedAt: minutesAgo(12),
      },
    ],
  );
  make(
    {
      name: "Migrate API to v2",
      status: "failed",
      error: {
        code: "provider_exited",
        message:
          "The provider stopped unexpectedly (exit code 1). The conversation is saved; resume the thread to continue.",
      },
    },
    claude,
    kalcode,
    55,
    false,
    [["user", "Migrate the API client to v2."]],
  );
  make(
    { name: "Update README with Install Steps", status: "interrupted", currentActivity: "Stopped by you" },
    codex,
    site,
    180,
    false,
    [
      ["user", "Update the README with install steps."],
      ["assistant", "I've drafted the prerequisites section."],
    ],
  );
  make({ name: "Bump Deps", status: "completed" }, claude, kalcode, 60 * 26, false, [["user", "Bump deps."]], [], true);
}
