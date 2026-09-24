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
  ProviderOption,
  ThreadMessage,
  ThreadOptions,
  ThreadStatus,
  ThreadSummary,
  ToolCallRecord,
  WorkspaceOption,
} from "@kalcode/protocol";
import type { CommandName } from "../transport.ts";

export type ThreadsScenario = "default" | "threads" | "no-providers";

export type EmitFn = (event: EventPayload, correlation?: Partial<Correlation>, source?: EventSource) => void;

type ThreadCommand = Extract<CommandName, `thread_${string}`>;
type Handler = (args: Record<string, unknown>) => unknown;

export interface ThreadsMemory {
  handlers: Record<ThreadCommand, Handler>;
  stream(threadId: string, onEvent: (event: AgentEvent) => void): () => void;
  /** Test hook: live stream subscribers for a thread. */
  streamCount(threadId: string): number;
}

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
    id: "codex",
    displayName: "Codex",
    accountLabel: null,
    models: [{ id: "codex-default", displayName: "Default", isDefault: true }],
    supportsResume: false,
    supportsInterrupt: true,
    hostApprovals: true,
    permissionMappings: [],
  },
];

const WORKSPACES: WorkspaceOption[] = [
  { id: "0192f3c4-0000-7000-8000-00000000a001", name: "kalcode" },
  { id: "0192f3c4-0000-7000-8000-00000000a002", name: "kalcoded.com" },
];

const CREATE_MODES: PermissionMode[] = ["plan", "approve", "auto"];
const MAX_PROMPT = 100_000;
const MAX_NAME = 80;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
): ThreadsMemory {
  const threads = new Map<string, MemThread>();
  const streams = new Map<string, Set<(event: AgentEvent) => void>>();
  const providers = scenario === "no-providers" ? [] : PROVIDERS;

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
    if (firstInput) send(t, firstInput);
    else setStatus(t, "idle");
  };

  const send = (t: MemThread, text: string) => {
    addMessage(t, "user", text, "ui");
    setStatus(t, "active");
    runTurn(t, text);
  };

  const summary = (t: MemThread): ThreadSummary => t.summary;

  const endSession = (t: MemThread, activity: string) => {
    cancelTimers(t);
    t.live = false;
    flush(t);
    cancelTools(t);
    t.summary = { ...t.summary, pendingApprovals: 0 };
    setStatus(t, "interrupted", activity);
  };

  const handlers: Record<ThreadCommand, Handler> = {
    thread_options: (): ThreadOptions => {
      requireCore();
      return { providers, workspaces: WORKSPACES, permissionModes: CREATE_MODES, defaultPermissionMode: "approve" };
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
    thread_create: (args) => {
      requireCore();
      const providerId = args.providerId;
      if (typeof providerId !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(providerId))
        invalid("invalid_provider", "That provider reference isn't valid.");
      if (typeof args.workspaceId !== "string" || !UUID.test(args.workspaceId))
        invalid("invalid_workspace_id", "That workspace reference isn't valid.");
      const mode = args.permissionMode as PermissionMode;
      if (mode === "bypass")
        invalid(
          "bypass_not_allowed_at_create",
          "Bypass can't be chosen when creating a thread. Create it in Approve or Auto, then change the mode on the thread.",
        );
      if (!CREATE_MODES.includes(mode)) error("internal", "ipc_rejected", "KalCode couldn't complete that request.");
      const prompt = validPrompt(args.prompt);
      const name = args.name == null || String(args.name).trim() === "" ? nameFromPrompt(prompt) : validName(args.name);
      const provider = providers.find((p) => p.id === providerId);
      if (!provider)
        return error(
          "provider",
          "provider_unavailable",
          `${providerId} isn't connected to KalCode. Connect it in Providers, then try again.`,
        );
      const model = args.model == null || args.model === "" ? null : String(args.model);
      if (model && !provider.models.some((m) => m.id === model))
        invalid("invalid_model", `That model isn't available for ${provider.displayName}.`);
      const workspace = WORKSPACES.find((w) => w.id === args.workspaceId);
      if (!workspace)
        return error(
          "filesystem",
          "workspace_not_found",
          "That workspace isn't available. It may have been removed from KalCode.",
        );
      const created = now();
      const t: MemThread = {
        summary: {
          id: uuid(),
          name,
          providerId: provider.id,
          providerName: provider.displayName,
          model,
          accountLabel: provider.accountLabel,
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
          branch: null,
          error: null,
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
      };
      threads.set(t.summary.id, t);
      emit(
        {
          type: "thread.created",
          payload: { threadId: t.summary.id, name, providerId: provider.id, workspaceId: workspace.id },
        },
        corr(t),
      );
      startSession(t, null, prompt);
      return summary(t);
    },
    thread_send: (args) => {
      const t = get(args);
      const text = validPrompt(args.text);
      if (t.archived) invalid("thread_archived", "This thread is archived.");
      if (!t.live) invalid("thread_not_running", "This thread isn't running. Resume it to continue.");
      if (t.summary.pendingApprovals > 0)
        invalid(
          "thread_waiting_for_permission",
          "This thread is waiting for a permission decision. Answer it or interrupt the turn first.",
        );
      send(t, text);
      return summary(t);
    },
    thread_interrupt: (args) => {
      const t = get(args);
      if (!t.live) invalid("thread_not_running", "This thread isn't running. Resume it to continue.");
      if (!LIVE.has(t.summary.status) && t.summary.status !== "waiting_for_permission")
        invalid("thread_not_working", "This thread isn't working on anything right now.");
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
        setStatus(t, "interrupted", "Stopped by you");
        return summary(t);
      }
      endSession(t, "Stopped by you");
      return summary(t);
    },
    thread_resume: (args) => {
      const t = get(args);
      if (t.archived) invalid("thread_archived", "This thread is archived.");
      const text = args.text == null || String(args.text).trim() === "" ? null : validPrompt(args.text);
      if (t.live) {
        if (t.summary.status !== "paused") invalid("thread_already_running", "This thread is already running.");
        setStatus(t, "idle");
        if (text) send(t, text);
        return summary(t);
      }
      const provider = providers.find((p) => p.id === t.summary.providerId);
      if (!provider)
        return error(
          "provider",
          "provider_unavailable",
          `${t.summary.providerName} isn't connected to KalCode. Connect it in Providers, then try again.`,
        );
      setStatus(t, "starting", "Resuming");
      startSession(t, provider.supportsResume ? t.providerSessionId : null, text);
      return summary(t);
    },
    thread_rename: (args) => {
      const t = get(args);
      const name = validName(args.name);
      if (name !== t.summary.name) {
        t.summary = { ...t.summary, name };
        emit({ type: "thread.renamed", payload: { threadId: t.summary.id, name } }, corr(t), "ui");
      }
      return summary(t);
    },
    thread_archive: (args) => {
      const t = get(args);
      if (t.archived) return summary(t);
      if (t.live) invalid("thread_running", "Stop the thread before archiving it.");
      t.archived = true;
      emit({ type: "thread.archived", payload: { threadId: t.summary.id } }, corr(t), "ui");
      return summary(t);
    },
    thread_stream: () => error("internal", "use_stream_thread", "Use streamThread()."),
  };

  if (scenario === "threads") seed(threads);

  return {
    handlers,
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
        error: null,
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
      providerSessionId: live ? `session-${id.slice(0, 8)}` : null,
      readThrough: 0,
      archived,
      resumeStatus: null,
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
