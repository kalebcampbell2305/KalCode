import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalView,
  BootState,
  Branch,
  BranchState,
  CommandRequest,
  Commit,
  ContextPreview,
  CorrelationFilter,
  Diagnostics,
  EventEnvelope,
  EventPage,
  EventQuery,
  FileEntry,
  FileHandle,
  FileRef,
  GitStatusSummary,
  HealthRollup,
  HomeSummary,
  KalVoiceMode,
  KalVoicePreferencesPatch,
  KalVoiceResponse,
  KalVoiceSignal,
  KalVoiceStatus,
  LatencySnapshot,
  LocalReasoningDownload,
  LocatorEntityKind,
  LocatorOpenTarget,
  LocatorQuery,
  LocatorResponse,
  LocatorVia,
  MemoryInput,
  MemoryRecord,
  MemorySettings,
  ModelInfo,
  NotificationMark,
  NotificationPage,
  Page,
  PaneLayout,
  PermissionMode,
  PermissionProfile,
  PermissionSettings,
  ProviderAccount,
  ProviderAccountBinding,
  ProviderAccountBindingKind,
  ProviderAccountUsage,
  ProviderHealth,
  ProviderStatus,
  RailSection,
  RailState,
  RailUpdate,
  RecentWorkItem,
  RecentWorkWhen,
  SavedLayoutPreset,
  SecureStoreCheck,
  SessionResolution,
  Settings,
  SettingsPatch,
  ShellOption,
  SpeechModelInfo,
  StatusFile,
  TalkRequest,
  TalkResponse,
  TerminalInfo,
  ThreadMessage,
  ThreadOptions,
  ThreadSummary,
  ThreadWorktreeState,
  ToolCallRecord,
  UiCommandRequest,
  Workspace,
  WorkspaceGroup,
  WorkspaceLayout,
  WorkspaceRailEntry,
} from "@kalcode/protocol";
import type { ContextFileChoice, ContextInput, ContextSendResult, PromptReview } from "./context.ts";
import { toKalCodeError } from "./errors.ts";
import { HandoffsClient } from "./handoffs.ts";
import type { RemoteStatus } from "./remote.ts";
import type { ImportedTerminalImage, TerminalImageTarget } from "./terminalImages.ts";
import type { CommandName, NativeTheme, Transport, Unsubscribe } from "./transport.ts";
import type { UpdateChannel, UpdateStatus } from "./updater.ts";

/** Maximum page size accepted by `events_recent` (mirrors the native limit). */
export const MAX_EVENT_PAGE = 500;

/** Largest single `terminal_write` the native runtime accepts, in bytes. */
export const MAX_TERMINAL_WRITE_BYTES = 64 * 1024;
/** Input is sent in pieces of at most this many UTF-16 units (≤ 24 KB of UTF-8). */
const TERMINAL_WRITE_CHUNK = 8 * 1024;

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** Clamps a measured size to what native accepts (2..=1000). */
export function clampTerminalSize({ cols, rows }: TerminalSize): TerminalSize {
  const clamp = (n: number) => Math.max(2, Math.min(1000, Math.floor(Number.isFinite(n) ? n : 2)));
  return { cols: clamp(cols), rows: clamp(rows) };
}

/** Longest Provider Health trend window, in hours (30 days of hourly rollups). */
export const MAX_HEALTH_TREND_HOURS = 720;

/** Maximum page size accepted by `notification_list`. */
export const MAX_NOTIFICATION_PAGE = 200;

/** Maximum page size accepted by `thread_messages` / `thread_tool_calls`. */
export const MAX_THREAD_PAGE = 500;

export interface CreateThreadInput {
  providerId: string;
  providerAccountId?: string | null;
  workspaceId: string;
  model: string | null;
  permissionMode: PermissionMode;
  prompt: string;
  name: string | null;
  confirmBypass?: boolean | null;
  profileId?: string | null;
  /** Agent Fleet: run the agent in its own worktree and branch (the workspace must be a Git repository). */
  isolate?: boolean | null;
}

/** Opaque native login operation. Provider URLs and credentials remain outside the WebView. */
export interface ProviderLoginStart {
  loginHandle: string;
}

/** `git_status` (Z6a): the working tree's state; `repository: false` for a plain folder. */
export interface GitStatusResponse {
  repository: boolean;
  summary: GitStatusSummary | null;
  branch: BranchState | null;
  files: Page<StatusFile>;
  truncated: boolean;
}

/** The person's UTC offset in minutes (calendar words like "yesterday" are local). */
export function localOffsetMinutes(at: Date = new Date()): number {
  return -at.getTimezoneOffset();
}

function clampPage(limit: number): number {
  return Math.max(1, Math.min(MAX_THREAD_PAGE, Math.floor(limit)));
}

/**
 * Read-only commands whose identical concurrent calls can share one native read. Several views
 * mount together (startup, a tab switch) and ask for the same lists at the same moment.
 */
const SHARED_READS: ReadonlySet<CommandName> = new Set<CommandName>([
  "account_status",
  "approval_list",
  "diagnostics_get",
  "kalvoice_status",
  "notification_list",
  "operations_snapshot",
  "permission_profiles_list",
  "permission_settings_get",
  "provider_account_bindings_list",
  "provider_account_usage",
  "provider_accounts_list",
  "provider_health_list",
  "providers_list",
  "rail_state",
  "runtime_status",
  "settings_get",
  "shells_list",
  "terminal_list",
  "terminals_running",
  "thread_list",
  "thread_options",
  "updater_status",
  "workspace_active",
  "workspace_list",
]);

/** The only module that talks to the native runtime. Every failure becomes a KalCodeError. */
export class KalCodeClient {
  readonly handoffs: HandoffsClient;
  /**
   * Shared reads in flight, by command and arguments. A call joins one only if no other command
   * was sent and no event arrived since it started, so a joined read never predates a change.
   */
  private readonly reads = new Map<string, Promise<unknown>>();

  constructor(readonly transport: Transport) {
    this.handoffs = new HandoffsClient((command, args) => this.call(command, args));
  }

  private async call<T>(command: CommandName, args?: Record<string, unknown>): Promise<T> {
    if (!SHARED_READS.has(command)) {
      this.reads.clear();
      return this.invoke<T>(command, args);
    }
    const key = `${command} ${JSON.stringify(args ?? null)}`;
    const shared = this.reads.get(key) as Promise<T> | undefined;
    // Each caller gets its own copy: a caller may sort or edit what it receives.
    if (shared) return shared.then((value) => structuredClone(value));
    const read = this.invoke<T>(command, args);
    this.reads.set(key, read);
    const done = () => {
      if (this.reads.get(key) === read) this.reads.delete(key);
    };
    read.then(done, done);
    return read;
  }

  private async invoke<T>(command: CommandName, args?: Record<string, unknown>): Promise<T> {
    try {
      return await this.transport.invoke<T>(command, args);
    } catch (error) {
      throw toKalCodeError(error, command);
    }
  }

  boot(): Promise<BootState> {
    return this.call("boot");
  }

  windowReady(): Promise<void> {
    return this.call("window_ready");
  }

  listUnifiedMemory(workspaceId: string, query = ""): Promise<MemoryRecord[]> {
    return this.call("unified_memory_list", { workspaceId, query });
  }

  saveUnifiedMemory(workspaceId: string, id: string | null, input: MemoryInput): Promise<MemoryRecord> {
    return this.call("unified_memory_save", { workspaceId, id, input });
  }

  deleteUnifiedMemory(workspaceId: string, id: string): Promise<void> {
    return this.call("unified_memory_delete", { workspaceId, id });
  }

  reviewUnifiedMemory(workspaceId: string, id: string): Promise<MemoryRecord> {
    return this.call("unified_memory_review", { workspaceId, id });
  }

  unifiedMemoryPreferences(workspaceId: string): Promise<MemorySettings> {
    return this.call("unified_memory_preferences", { workspaceId });
  }

  retrieveUnifiedMemory(workspaceId: string, query: string): Promise<string> {
    return this.call("unified_memory_retrieve", { workspaceId, query });
  }

  setUnifiedMemoryPreferences(workspaceId: string, settings: MemorySettings): Promise<MemorySettings> {
    return this.call("unified_memory_set_preferences", { workspaceId, settings });
  }

  getSettings(): Promise<Settings> {
    return this.call("settings_get");
  }

  updateSettings(patch: SettingsPatch): Promise<Settings> {
    return this.call("settings_update", { patch });
  }

  updaterStatus(): Promise<UpdateStatus> {
    return this.call("updater_status");
  }

  remoteStatus(): Promise<RemoteStatus> {
    return this.call("remote_status");
  }

  remoteSetEnabled(enabled: boolean): Promise<RemoteStatus> {
    return this.call("remote_set_enabled", { enabled });
  }

  remotePairStart(): Promise<RemoteStatus> {
    return this.call("remote_pair_start");
  }

  remotePairCancel(): Promise<RemoteStatus> {
    return this.call("remote_pair_cancel");
  }

  remoteDeviceRevoke(deviceId: string): Promise<RemoteStatus> {
    return this.call("remote_device_revoke", { deviceId });
  }

  updaterSetChannel(channel: UpdateChannel): Promise<UpdateStatus> {
    return this.call("updater_set_channel", { channel });
  }

  updaterCheck(): Promise<UpdateStatus> {
    return this.call("updater_check");
  }

  updaterCancel(): Promise<UpdateStatus> {
    return this.call("updater_cancel");
  }

  updaterInstall(): Promise<void> {
    return this.call("updater_install");
  }

  updaterRestorePrevious(): Promise<void> {
    return this.call("updater_restore_previous");
  }

  recentEvents(limit: number, beforeSeq?: number): Promise<EventEnvelope[]> {
    const safeLimit = Math.max(1, Math.min(MAX_EVENT_PAGE, Math.floor(limit)));
    return this.call("events_recent", { limit: safeLimit, beforeSeq: beforeSeq ?? null });
  }

  /**
   * A filtered page of the event log (`events_query`): exact types or `domain.*` prefixes,
   * correlation ids, seq and time windows, ascending or descending. Omitted fields take the native
   * defaults (all types, newest first, 100 per page); the page size is clamped to 1..=500.
   */
  queryEvents(
    query: Omit<Partial<EventQuery>, "correlation"> & { correlation?: Partial<CorrelationFilter> } = {},
  ): Promise<EventPage> {
    const full: EventQuery = {
      types: query.types ?? [],
      correlation: {
        workspaceId: null,
        threadId: null,
        missionId: null,
        providerId: null,
        requestId: null,
        agentId: null,
        taskId: null,
        automationId: null,
        causationId: null,
        ...query.correlation,
      },
      afterSeq: query.afterSeq ?? null,
      beforeSeq: query.beforeSeq ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      order: query.order ?? "desc",
      limit: Math.max(1, Math.min(MAX_EVENT_PAGE, Math.floor(query.limit ?? 100))),
    };
    return this.call("events_query", { query: full });
  }

  async subscribeEvents(onEvent: (event: EventEnvelope) => void): Promise<Unsubscribe> {
    try {
      // Something changed: reads started before this event are not shared with later callers.
      return await this.transport.subscribe((event) => {
        this.reads.clear();
        onEvent(event);
      });
    } catch (error) {
      throw toKalCodeError(error);
    }
  }

  getDiagnostics(): Promise<Diagnostics> {
    return this.call("diagnostics_get");
  }

  openLogFolder(): Promise<void> {
    return this.call("diagnostics_open_log_dir");
  }

  openDataFolder(): Promise<void> {
    return this.call("diagnostics_open_data_dir");
  }

  checkSecureStore(): Promise<SecureStoreCheck> {
    return this.call("secure_store_check");
  }

  // ---- KalVoice ----

  private readonly kalvoiceListeners = new Set<(signal: KalVoiceSignal) => void>();
  private kalvoiceChannel: Promise<void> | null = null;

  /**
   * Listens to this window's KalVoice signals. Native keeps exactly one channel per window and
   * replaces it on every `kalvoice_subscribe`, so the client opens one channel and fans it out:
   * listeners come and go (React remounts, StrictMode) without ever replacing or dropping the
   * live channel. Resolves to a function that removes this listener.
   */
  async subscribeKalVoice(onSignal: (signal: KalVoiceSignal) => void): Promise<() => void> {
    this.kalvoiceListeners.add(onSignal);
    const remove = () => {
      this.kalvoiceListeners.delete(onSignal);
    };
    try {
      this.kalvoiceChannel ??= this.openKalVoiceChannel();
      await this.kalvoiceChannel;
    } catch (error) {
      remove();
      throw toKalCodeError(error);
    }
    return remove;
  }

  /**
   * Registers this window's channel again (native replaces it; signals are never duplicated).
   * Heals a channel the native side dropped after a failed send.
   */
  async renewKalVoiceSubscription(): Promise<void> {
    if (this.kalvoiceListeners.size === 0) return;
    // The current channel stays the client's channel until native accepts the new one: a refused
    // renewal leaves native's existing channel (and this client's record of it) in place.
    const opening = this.openKalVoiceChannel();
    try {
      await opening;
    } catch (error) {
      throw toKalCodeError(error);
    }
    this.kalvoiceChannel = opening;
  }

  private openKalVoiceChannel(): Promise<void> {
    const opening = this.transport
      .subscribeKalVoice((signal) => {
        for (const listener of [...this.kalvoiceListeners]) listener(signal);
      })
      .catch((error: unknown) => {
        // The next listener (or renewal) tries again instead of trusting a channel that never opened.
        if (this.kalvoiceChannel === opening) this.kalvoiceChannel = null;
        throw error;
      });
    return opening;
  }

  kalvoiceStatus(): Promise<KalVoiceStatus> {
    return this.call("kalvoice_status");
  }

  kalvoiceRequest(request: CommandRequest): Promise<KalVoiceResponse> {
    return this.call("kalvoice_request", { request });
  }

  /** Claims one KalVoice Request for a command the UI runs itself; run it only on `completed`. */
  kalvoiceMeterUiCommand(request: UiCommandRequest): Promise<KalVoiceResponse> {
    return this.call("kalvoice_meter_ui_command", { request });
  }

  /** One push-to-talk utterance: routed natively to a command, dictation or a request. */
  kalvoiceTalk(request: TalkRequest): Promise<TalkResponse> {
    return this.call("kalvoice_talk", { request });
  }

  /** "Type it instead": un-counts a spoken command the UI undid. */
  kalvoiceTypeInstead(requestId: string): Promise<boolean> {
    return this.call("kalvoice_type_instead", { requestId });
  }

  kalvoiceLatency(): Promise<LatencySnapshot> {
    return this.call("kalvoice_latency");
  }

  kalvoiceLatencyRecord(actionMs: number): Promise<void> {
    return this.call("kalvoice_latency_record", { actionMs });
  }

  kalvoiceUpdatePreferences(patch: KalVoicePreferencesPatch): Promise<KalVoiceStatus> {
    return this.call("kalvoice_preferences_update", { patch });
  }

  kalvoiceListenStart(mode: KalVoiceMode): Promise<string> {
    return this.call("kalvoice_listen_start", { mode });
  }

  kalvoiceListenStop(sessionId: string): Promise<void> {
    return this.call("kalvoice_listen_stop", { sessionId });
  }

  /** `keepSpeech`: a background Escape that stops a spoken reply only if it cancelled a capture. */
  kalvoiceListenCancel(sessionId?: string, options?: { keepSpeech?: boolean }): Promise<boolean> {
    const args = { ...(sessionId ? { sessionId } : {}), ...(options?.keepSpeech ? { keepSpeech: true } : {}) };
    return this.call("kalvoice_listen_cancel", Object.keys(args).length > 0 ? args : undefined);
  }

  kalvoiceFnInput(input: "down" | "up" | "other"): Promise<boolean> {
    return this.call("kalvoice_fn_input", { input });
  }

  /** `consent` must come from the user confirming the download dialog. */
  kalvoiceReasoningPrepare(): Promise<LocalReasoningDownload> {
    return this.call("kalvoice_reasoning_prepare");
  }

  kalvoiceReasoningRetry(): Promise<void> {
    return this.call("kalvoice_reasoning_retry");
  }

  kalvoiceModelDownload(modelId: string, consent: boolean, catalogIdentity?: string): Promise<void> {
    return this.call("kalvoice_model_download", { modelId, consent, ...(catalogIdentity ? { catalogIdentity } : {}) });
  }

  kalvoiceModelCancel(modelId: string): Promise<boolean> {
    return this.call("kalvoice_model_cancel", { modelId });
  }

  kalvoiceModelDelete(modelId: string): Promise<SpeechModelInfo[]> {
    return this.call("kalvoice_model_delete", { modelId });
  }

  /** Opens the operating system's microphone privacy page (native allows only that page). */
  kalvoiceOpenMicrophoneSettings(): Promise<void> {
    return this.call("kalvoice_open_microphone_settings");
  }

  /** Cached provider status; `detection` is null for providers not checked yet. */
  listProviders(): Promise<ProviderStatus[]> {
    return this.call("providers_list");
  }

  /** Runs read-only detection (version and sign-in status) for every provider. */
  detectProviders(): Promise<ProviderStatus[]> {
    return this.call("providers_detect");
  }

  // ---- Managed provider accounts ----

  listProviderAccounts(providerId?: string): Promise<ProviderAccount[]> {
    return this.call("provider_accounts_list", { providerId: providerId ?? null });
  }

  createProviderAccount(providerId: string, displayName: string): Promise<ProviderAccount> {
    return this.call("provider_account_create", { providerId, displayName });
  }

  renameProviderAccount(accountId: string, displayName: string): Promise<ProviderAccount> {
    return this.call("provider_account_rename", { accountId, displayName });
  }

  setDefaultProviderAccount(accountId: string): Promise<ProviderAccount> {
    return this.call("provider_account_set_default", { accountId });
  }

  archiveProviderAccount(accountId: string): Promise<ProviderAccount> {
    return this.call("provider_account_archive", { accountId });
  }

  bindProviderAccount(
    providerId: string,
    kind: ProviderAccountBindingKind,
    scopeId: string,
    accountId: string,
  ): Promise<ProviderAccountBinding> {
    return this.call("provider_account_bind", { providerId, kind, scopeId, accountId });
  }

  unbindProviderAccount(providerId: string, kind: ProviderAccountBindingKind, scopeId: string): Promise<boolean> {
    return this.call("provider_account_unbind", { providerId, kind, scopeId });
  }

  /**
   * Scoped account bindings (for example each workspace's default account). Every filter is
   * optional; bindings of archived accounts are never listed.
   */
  listProviderAccountBindings(
    filter: { providerId?: string; kind?: ProviderAccountBindingKind; scopeId?: string } = {},
  ): Promise<ProviderAccountBinding[]> {
    return this.call("provider_account_bindings_list", {
      providerId: filter.providerId ?? null,
      kind: filter.kind ?? null,
      scopeId: filter.scopeId ?? null,
    });
  }

  /**
   * Real provider quota usage per active account (all, or only `accountIds`), read passively
   * from what the provider CLI recorded. Never runs a provider command or touches credentials.
   */
  providerAccountUsage(accountIds?: readonly string[]): Promise<ProviderAccountUsage[]> {
    return this.call("provider_account_usage", { accountIds: accountIds ? [...accountIds] : null });
  }

  refreshCursorAccount(accountId: string): Promise<CursorAccountState> {
    return this.call("provider_cursor_account_refresh", { accountId });
  }

  loginCursorAccount(accountId: string): Promise<CursorAccountState> {
    return this.call("provider_cursor_login", { accountId });
  }

  refreshCodexAccount(accountId: string): Promise<ProviderAccount> {
    return this.call("provider_codex_account_refresh", { accountId });
  }

  startCodexLogin(accountId: string): Promise<ProviderLoginStart> {
    return this.call("provider_codex_login_start", { accountId });
  }

  waitForCodexLogin(loginHandle: string): Promise<ProviderAccount> {
    return this.call("provider_codex_login_wait", { loginHandle });
  }

  cancelCodexLogin(loginHandle: string): Promise<void> {
    return this.call("provider_codex_login_cancel", { loginHandle });
  }

  logoutCodexAccount(accountId: string): Promise<ProviderAccount> {
    return this.call("provider_codex_logout", { accountId });
  }

  refreshClaudeAccount(accountId: string): Promise<ProviderAccount> {
    return this.call("provider_claude_account_refresh", { accountId });
  }

  startClaudeLogin(accountId: string): Promise<ProviderLoginStart> {
    return this.call("provider_claude_login_start", { accountId });
  }

  waitForClaudeLogin(loginHandle: string): Promise<ProviderAccount> {
    return this.call("provider_claude_login_wait", { loginHandle });
  }

  cancelClaudeLogin(loginHandle: string): Promise<void> {
    return this.call("provider_claude_login_cancel", { loginHandle });
  }

  logoutClaudeAccount(accountId: string): Promise<ProviderAccount> {
    return this.call("provider_claude_logout", { accountId });
  }

  refreshGeminiAccount(accountId: string): Promise<ProviderAccount> {
    return this.call("provider_gemini_account_refresh", { accountId });
  }

  startGeminiLogin(accountId: string): Promise<ProviderLoginStart> {
    return this.call("provider_gemini_login_start", { accountId });
  }

  waitForGeminiLogin(loginHandle: string): Promise<ProviderAccount> {
    return this.call("provider_gemini_login_wait", { loginHandle });
  }

  cancelGeminiLogin(loginHandle: string): Promise<void> {
    return this.call("provider_gemini_login_cancel", { loginHandle });
  }

  logoutGeminiAccount(accountId: string): Promise<ProviderAccount> {
    return this.call("provider_gemini_logout", { accountId });
  }

  // ---- Provider Health (PROVIDERS-2) ----
  // Cheap in-memory snapshots: reading health never starts a provider process or a detection.

  /** Every provider's health, catalog order. */
  listProviderHealth(): Promise<ProviderHealth[]> {
    return this.call("provider_health_list");
  }

  getProviderHealth(providerId: string): Promise<ProviderHealth> {
    return this.call("provider_health_get", { providerId });
  }

  /** Hourly rollups for the last `hours` hours (clamped to 1..=720), oldest first. */
  providerHealthTrend(providerId: string, hours: number): Promise<HealthRollup[]> {
    const safeHours = Math.max(1, Math.min(MAX_HEALTH_TREND_HOURS, Math.floor(Number.isFinite(hours) ? hours : 1)));
    return this.call("provider_health_trend", { providerId, hours: safeHours });
  }

  // Threads (Z3). `thread_list`, `thread_interrupt`, `thread_resume`, `thread_stop`,
  // `thread_archive` and `thread_unarchive` are also consumed by the Dashboard.

  listThreads(options: { workspaceId?: string; includeArchived?: boolean } = {}): Promise<ThreadSummary[]> {
    return this.call("thread_list", {
      workspaceId: options.workspaceId ?? null,
      includeArchived: options.includeArchived ?? false,
    });
  }

  getThread(threadId: string): Promise<ThreadSummary> {
    return this.call("thread_get", { threadId });
  }

  /** Git facts for the agents that run in their own worktree (Agent Fleet); others are left out. */
  threadWorktreeStates(threadIds: readonly string[]): Promise<ThreadWorktreeState[]> {
    return this.call("thread_worktree_states", { threadIds });
  }

  /**
   * Commits everything an isolated agent changed in its own worktree, on its branch, when the
   * person asks (agents may not be able to commit from their sandbox). Refused while it works.
   */
  commitThreadWorktree(threadId: string, message: string): Promise<ThreadWorktreeState> {
    return this.call("thread_worktree_commit", { threadId, message });
  }

  /**
   * Resolves a session name the way KalVoice does (explicit id, exact name in the current
   * workspace, exact name anywhere, provider/account + name, "this/it", provider only, then
   * fuzzy only when exactly one fits). Never guesses: more than one fit is `ambiguous` with at
   * most four labelled choices. Reads only open threads; changes nothing.
   */
  resolveSession(
    query: string,
    context: { workspaceId?: string | null; focusedThreadId?: string | null; lastTargetId?: string | null } = {},
  ): Promise<SessionResolution> {
    return this.call("session_resolve", {
      query,
      workspaceId: context.workspaceId ?? null,
      focusedThreadId: context.focusedThreadId ?? null,
      lastTargetId: context.lastTargetId ?? null,
    });
  }

  threadMessages(threadId: string, limit: number, before?: string): Promise<ThreadMessage[]> {
    return this.call("thread_messages", { threadId, limit: clampPage(limit), before: before ?? null });
  }

  threadToolCalls(threadId: string, limit: number): Promise<ToolCallRecord[]> {
    return this.call("thread_tool_calls", { threadId, limit: clampPage(limit) });
  }

  threadOptions(): Promise<ThreadOptions> {
    return this.call("thread_options");
  }

  reviewCreateThreadPrompt(input: CreateThreadInput): Promise<PromptReview> {
    return this.call("thread_review_create_prompt", {
      ...input,
      providerAccountId: input.providerAccountId ?? null,
      confirmBypass: input.confirmBypass ?? null,
      profileId: input.profileId ?? null,
    });
  }

  reviewThreadPrompt(threadId: string, text: string): Promise<PromptReview> {
    return this.call("thread_review_prompt", { threadId, text });
  }

  cancelPromptReview(reviewId: string): Promise<boolean> {
    return this.call("thread_cancel_prompt_review", { reviewId });
  }

  createThread(input: CreateThreadInput, promptReviewId?: string | null): Promise<ThreadSummary> {
    return this.call("thread_create", {
      ...input,
      providerAccountId: input.providerAccountId ?? null,
      confirmBypass: input.confirmBypass ?? null,
      profileId: input.profileId ?? null,
      isolate: input.isolate ?? null,
      promptReviewId: promptReviewId ?? null,
    });
  }

  sendToThread(threadId: string, text: string, promptReviewId?: string | null): Promise<ThreadSummary> {
    return this.call("thread_send", { threadId, text, promptReviewId: promptReviewId ?? null });
  }

  pickContextFiles(threadId: string): Promise<ContextFileChoice[]> {
    return this.call("context_file_pick", { threadId });
  }

  createContextPreview(threadId: string, inputs: ContextInput[]): Promise<ContextPreview> {
    return this.call("context_preview_create", { threadId, inputs });
  }

  setContextItem(packageId: string, position: number, included: boolean): Promise<ContextPreview> {
    return this.call("context_item_set", { packageId, position, included });
  }

  confirmContextItem(packageId: string, position: number): Promise<ContextPreview> {
    return this.call("context_item_confirm", { packageId, position });
  }

  discardContext(packageId: string): Promise<void> {
    return this.call("context_discard", { packageId });
  }

  sendWithContext(
    packageId: string,
    threadId: string,
    previewedSha256: string,
    text: string,
    promptReviewId?: string | null,
  ): Promise<ContextSendResult> {
    return this.call("context_send", {
      packageId,
      threadId,
      previewedSha256,
      text,
      promptReviewId: promptReviewId ?? null,
    });
  }

  interruptThread(threadId: string): Promise<ThreadSummary> {
    return this.call("thread_interrupt", { threadId });
  }

  resumeThread(threadId: string, text?: string, promptReviewId?: string | null): Promise<ThreadSummary> {
    return this.call("thread_resume", { threadId, text: text ?? null, promptReviewId: promptReviewId ?? null });
  }

  stopThread(threadId: string): Promise<ThreadSummary> {
    return this.call("thread_stop", { threadId });
  }

  /**
   * Start Anyway: the person's override for a coding agent held by genuine hard pressure (low
   * memory, a full disk) or their own Custom limit. Starts it now.
   */
  startThreadAnyway(threadId: string): Promise<ThreadSummary> {
    return this.call("thread_start_anyway", { threadId });
  }

  /**
   * Explicitly rebinds a thread to another account of the same provider (the person confirmed
   * the Rebind dialog). Future provider requests use the new account; past history is unchanged.
   */
  rebindThreadAccount(threadId: string, providerAccountId: string): Promise<ThreadSummary> {
    return this.call("thread_rebind_account", { threadId, providerAccountId });
  }

  duplicateThread(threadId: string): Promise<ThreadSummary> {
    return this.call("thread_duplicate", { threadId });
  }

  moveThread(threadId: string, workspaceId: string): Promise<ThreadSummary> {
    return this.call("thread_move", { threadId, workspaceId });
  }

  renameThread(threadId: string, name: string): Promise<ThreadSummary> {
    return this.call("thread_rename", { threadId, name });
  }

  archiveThread(threadId: string): Promise<ThreadSummary> {
    return this.call("thread_archive", { threadId });
  }

  /** Restores an archived thread to the open list. Idempotent; status and history are unchanged. */
  unarchiveThread(threadId: string): Promise<ThreadSummary> {
    return this.call("thread_unarchive", { threadId });
  }

  // ---- Permissions (Z4) ----

  /** Approval requests, newest first; `"pending"` lists only those awaiting an answer. */
  listApprovals(status?: "pending"): Promise<ApprovalView[]> {
    return this.call("approval_list", { status: status ?? null });
  }

  decideApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalView> {
    return this.call("approval_decide", { requestId, decision });
  }

  listPermissionProfiles(): Promise<PermissionProfile[]> {
    return this.call("permission_profiles_list");
  }

  /** Bypass requires `confirmBypass: true`, sent only after the user confirms in the UI. */
  setThreadPermissionMode(
    threadId: string,
    mode: PermissionMode,
    options: { confirmBypass?: boolean; profileId?: string } = {},
  ): Promise<ThreadSummary> {
    return this.call("thread_set_permission_mode", {
      threadId,
      mode,
      confirmBypass: options.confirmBypass ?? null,
      profileId: options.profileId ?? null,
    });
  }

  getPermissionSettings(): Promise<PermissionSettings> {
    return this.call("permission_settings_get");
  }

  updatePermissionSettings(
    defaultMode: PermissionMode,
    options: { confirmBypass?: boolean; profileId?: string | null } = {},
  ): Promise<PermissionSettings> {
    return this.call("permission_settings_update", {
      defaultMode,
      profileId: options.profileId ?? null,
      confirmBypass: options.confirmBypass ?? null,
    });
  }

  // ---------- Workspaces and terminals ----------

  listWorkspaces(): Promise<Workspace[]> {
    return this.call("workspace_list");
  }

  activeWorkspace(): Promise<Workspace | null> {
    return this.call("workspace_active");
  }

  /** Shows the native folder picker; resolves to null when the user cancels. */
  openWorkspaceDialog(): Promise<Workspace | null> {
    return this.call("workspace_open_dialog");
  }

  activateWorkspace(workspaceId: string): Promise<Workspace> {
    return this.call("workspace_activate", { workspaceId });
  }

  removeWorkspace(workspaceId: string): Promise<void> {
    return this.call("workspace_remove", { workspaceId });
  }

  listShells(): Promise<ShellOption[]> {
    return this.call("shells_list");
  }

  listTerminals(workspaceId: string): Promise<TerminalInfo[]> {
    return this.call("terminal_list", { workspaceId });
  }

  runningTerminals(): Promise<TerminalInfo[]> {
    return this.call("terminals_running");
  }

  duplicateTerminal(terminalId: string, size: TerminalSize): Promise<TerminalInfo> {
    return this.call("terminal_duplicate", { terminalId, ...clampTerminalSize(size) });
  }

  createTerminal(workspaceId: string, shellId: string | null, size: TerminalSize): Promise<TerminalInfo> {
    return this.call("terminal_create", { workspaceId, shellId, ...clampTerminalSize(size) });
  }

  restartTerminal(terminalId: string, size: TerminalSize): Promise<TerminalInfo> {
    return this.call("terminal_restart", { terminalId, ...clampTerminalSize(size) });
  }

  renameTerminal(terminalId: string, title: string): Promise<TerminalInfo> {
    return this.call("terminal_rename", { terminalId, title });
  }

  stopTerminal(terminalId: string): Promise<TerminalInfo> {
    return this.call("terminal_stop", { terminalId });
  }

  readWorkspaceFile(
    workspaceId: string,
    handle: FileHandle,
  ): Promise<{ file: FileRef; text: string; bytes: number; truncated: boolean }> {
    return this.call("utility_file_read", { workspaceId, handle });
  }

  closeTerminal(terminalId: string, onlyIfEnded = false): Promise<void> {
    return this.call("terminal_close", { terminalId, ...(onlyIfEnded ? { onlyIfEnded: true } : {}) });
  }

  /** Stages the selected pixels locally; the terminal performs a separate, non-submitting paste. */
  importTerminalImage(target: TerminalImageTarget, pngBase64: string): Promise<ImportedTerminalImage> {
    return this.call("terminal_image_import", { target, pngBase64 });
  }

  /** Releases a staged image when its target closed or rejected the paste. */
  async discardTerminalImage(target: TerminalImageTarget, imageId: string): Promise<void> {
    await this.call("terminal_image_discard", { target, imageId });
  }

  /** Sends input in order, split so no single write exceeds the native limit. */
  async writeTerminal(terminalId: string, data: string, expectedGeneration?: number): Promise<void> {
    let start = 0;
    while (start < data.length) {
      let end = Math.min(data.length, start + TERMINAL_WRITE_CHUNK);
      // Never split a surrogate pair across two writes.
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      await this.call("terminal_write", {
        terminalId,
        data: data.slice(start, end),
        ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
      });
      start = end;
    }
  }

  resizeTerminal(terminalId: string, size: TerminalSize): Promise<void> {
    return this.call("terminal_resize", { terminalId, ...clampTerminalSize(size) });
  }

  /** Streams output (replay first); resolves to the attachment id, or null if nothing to show. */
  async attachTerminal(terminalId: string, onOutput: (bytes: Uint8Array) => void): Promise<number | null> {
    try {
      return await this.transport.attachTerminal(terminalId, onOutput);
    } catch (error) {
      throw toKalCodeError(error);
    }
  }

  async streamThread(threadId: string, onEvent: (event: AgentEvent) => void): Promise<Unsubscribe> {
    try {
      return await this.transport.streamThread(threadId, onEvent);
    } catch (error) {
      throw toKalCodeError(error);
    }
  }

  detachTerminal(attachmentId: number): Promise<boolean> {
    return this.call("terminal_detach", { attachmentId });
  }

  /** Acknowledges rendered output; false means the view fell behind and must re-attach. */
  ackTerminal(attachmentId: number, bytes: number): Promise<boolean> {
    return this.call("terminal_ack", { attachmentId, bytes: Math.max(0, Math.min(0xffffffff, Math.floor(bytes))) });
  }

  setActiveTerminal(workspaceId: string, terminalId: string): Promise<void> {
    return this.call("terminal_set_active", { workspaceId, terminalId });
  }

  // ---------- Session Locator, rail, home (Z7-W2) ----------

  /** Local search. The text is never stored or logged. */
  locatorSearch(query: Partial<LocatorQuery> & { text: string }): Promise<LocatorResponse> {
    const full: LocatorQuery = {
      text: query.text.slice(0, 256),
      kinds: query.kinds ?? [],
      statuses: query.statuses ?? [],
      providerId: query.providerId ?? null,
      workspaceId: query.workspaceId ?? null,
      recency: query.recency ?? null,
      since: query.since ?? null,
      activeOnly: query.activeOnly ?? false,
      sort: query.sort ?? "relevance",
      page: query.page ?? { limit: 20, cursor: null },
      tzOffsetMinutes: query.tzOffsetMinutes ?? localOffsetMinutes(),
    };
    return this.call("locator_search", { query: full });
  }

  /** Resolves a result to open (records that it was opened, never the query). */
  locatorOpen(kind: LocatorEntityKind, entityId: string, via: LocatorVia): Promise<LocatorOpenTarget> {
    return this.call("locator_open", { args: { kind, entityId, via } });
  }

  railState(): Promise<RailState> {
    return this.call("rail_state");
  }

  railUpdate(update: RailUpdate): Promise<WorkspaceRailEntry> {
    return this.call("rail_update", { update });
  }

  railSectionSet(section: RailSection, collapsed: boolean): Promise<RailState> {
    return this.call("rail_section_set", { section, collapsed });
  }

  railGroupCreate(name: string): Promise<WorkspaceGroup> {
    return this.call("rail_group_create", { name });
  }

  railGroupUpdate(id: string, patch: { name?: string; collapsed?: boolean }): Promise<WorkspaceGroup> {
    return this.call("rail_group_update", { id, name: patch.name ?? null, collapsed: patch.collapsed ?? null });
  }

  railGroupDelete(id: string): Promise<void> {
    return this.call("rail_group_delete", { id });
  }

  railGroupReorder(ids: string[]): Promise<WorkspaceGroup[]> {
    return this.call("rail_group_reorder", { ids });
  }

  /**
   * The returning-user home. `visit`: the person opened Home (a new greeting is chosen for
   * `localHour`); live refreshes pass false and keep the greeting on screen.
   */
  homeSummary(visit: boolean, localHour: number = new Date().getHours()): Promise<HomeSummary> {
    return this.call("home_summary", { localHour: Math.max(0, Math.min(23, Math.floor(localHour))), visit });
  }

  recentWork(when: RecentWorkWhen, limit = 50, cursor: string | null = null): Promise<Page<RecentWorkItem>> {
    return this.call("recent_work", {
      when,
      tzOffsetMinutes: localOffsetMinutes(),
      page: { limit: Math.max(1, Math.min(500, Math.floor(limit))), cursor },
    });
  }

  /** Shows the workspace's folder in the OS file manager (the path is resolved natively). */
  revealWorkspace(workspaceId: string): Promise<void> {
    return this.call("workspace_reveal", { workspaceId });
  }

  /** Creates an empty folder `name` where the person picks (native dialog) and opens it. */
  createWorkspace(name: string): Promise<Workspace | null> {
    return this.call("workspace_create", { name });
  }

  // ---------- Z6a read-only (folder surface) ----------

  /** One folder of a workspace (the root when `dir` is absent): folders first. */
  listFiles(
    workspaceId: string,
    dir: FileHandle | null = null,
    limit = 200,
    cursor: string | null = null,
  ): Promise<Page<FileEntry>> {
    return this.call("files_list", { args: { workspaceId, dir, page: { limit, cursor } } });
  }

  gitStatus(workspaceId: string, limit = 200): Promise<GitStatusResponse> {
    return this.call("git_status", { args: { workspaceId, worktreeId: null, page: { limit, cursor: null } } });
  }

  gitLog(workspaceId: string, limit = 20): Promise<Page<Commit>> {
    return this.call("git_log", { args: { workspaceId, worktreeId: null, page: { limit, cursor: null } } });
  }

  gitBranches(workspaceId: string): Promise<Branch[]> {
    return this.call("git_branches", { args: { workspaceId } });
  }

  // ---------- Pane layouts (Z7-W1) ----------

  /** The layout saved for a workspace, or null (none yet, or it no longer validates). */
  layoutGet(workspaceId: string): Promise<WorkspaceLayout | null> {
    return this.call("layout_get", { workspaceId });
  }

  /** Validates (natively) and saves a workspace's layout. Emits no events. */
  layoutSave(workspaceId: string, layout: PaneLayout): Promise<WorkspaceLayout> {
    return this.call("layout_save", { workspaceId, layout });
  }

  /** The user's saved layout presets (shapes only). */
  layoutPresets(): Promise<SavedLayoutPreset[]> {
    return this.call("layout_presets");
  }

  /** Saves a layout's shape (contents stripped natively) under a name. */
  layoutPresetSave(name: string, layout: PaneLayout): Promise<SavedLayoutPreset> {
    return this.call("layout_preset_save", { name, layout });
  }

  layoutPresetDelete(presetId: string): Promise<void> {
    return this.call("layout_preset_delete", { presetId });
  }

  // ---- Notification center (Z7-W3) ----

  /** A page of notifications, most recently raised first (dismissed ones are never listed). */
  listNotifications(
    options: { unreadOnly?: boolean; limit?: number; before?: string | null } = {},
  ): Promise<NotificationPage> {
    const limit = Math.max(1, Math.min(MAX_NOTIFICATION_PAGE, Math.floor(options.limit ?? 50)));
    return this.call("notification_list", {
      unreadOnly: options.unreadOnly ?? false,
      limit,
      before: options.before ?? null,
    });
  }

  /** Marks notifications read, unread or dismissed (`null` ids: every listed notification). */
  markNotifications(ids: readonly string[] | null, mark: NotificationMark): Promise<number> {
    return this.call("notification_mark", { ids: ids ? [...ids] : null, mark });
  }

  async setNativeTheme(theme: NativeTheme): Promise<void> {
    try {
      await this.transport.setNativeTheme(theme);
    } catch {
      // Title-bar theming is cosmetic; never surface it as an error.
    }
  }
}

/** Live public Cursor metadata; native authentication remains provider-owned. */
export interface CursorAccountState {
  account: ProviderAccount;
  models: ModelInfo[];
  modelsError: string | null;
}
