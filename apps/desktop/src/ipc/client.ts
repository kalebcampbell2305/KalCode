import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalView,
  BootState,
  CommandRequest,
  CorrelationFilter,
  Diagnostics,
  EventEnvelope,
  EventPage,
  EventQuery,
  HealthRollup,
  KalVoiceMode,
  KalVoicePreferencesPatch,
  KalVoiceResponse,
  KalVoiceSignal,
  KalVoiceStatus,
  LatencySnapshot,
  PaneLayout,
  NotificationMark,
  NotificationPage,
  PermissionMode,
  PermissionProfile,
  PermissionSettings,
  ProviderHealth,
  ProviderStatus,
  SavedLayoutPreset,
  SecureStoreCheck,
  Settings,
  SettingsPatch,
  ShellOption,
  SpeechModelInfo,
  TalkRequest,
  TalkResponse,
  TerminalInfo,
  ThreadMessage,
  ThreadOptions,
  ThreadSummary,
  ToolCallRecord,
  Workspace,
  WorkspaceLayout,
} from "@kalcode/protocol";
import type {
  Branch,
  BranchState,
  Commit,
  FileEntry,
  FileHandle,
  GitStatusSummary,
  HomeSummary,
  LocatorEntityKind,
  LocatorOpenTarget,
  LocatorQuery,
  LocatorResponse,
  LocatorVia,
  Page,
  RailSection,
  RailState,
  RailUpdate,
  RecentWorkItem,
  RecentWorkWhen,
  StatusFile,
  WorkspaceGroup,
  WorkspaceRailEntry,
} from "@kalcode/protocol";
import { toKalCodeError } from "./errors.ts";
import type { CommandName, NativeTheme, Transport, Unsubscribe } from "./transport.ts";

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
  workspaceId: string;
  model: string | null;
  permissionMode: PermissionMode;
  prompt: string;
  name: string | null;
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

/** The only module that talks to the native runtime. Every failure becomes a KalCodeError. */
export class KalCodeClient {
  constructor(readonly transport: Transport) {}

  private async call<T>(command: CommandName, args?: Record<string, unknown>): Promise<T> {
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

  getSettings(): Promise<Settings> {
    return this.call("settings_get");
  }

  updateSettings(patch: SettingsPatch): Promise<Settings> {
    return this.call("settings_update", { patch });
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
      return await this.transport.subscribe(onEvent);
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

  async subscribeKalVoice(onSignal: (signal: KalVoiceSignal) => void): Promise<void> {
    try {
      await this.transport.subscribeKalVoice(onSignal);
    } catch (error) {
      throw toKalCodeError(error);
    }
  }

  kalvoiceStatus(): Promise<KalVoiceStatus> {
    return this.call("kalvoice_status");
  }

  kalvoiceRequest(request: CommandRequest): Promise<KalVoiceResponse> {
    return this.call("kalvoice_request", { request });
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

  kalvoiceListenCancel(): Promise<boolean> {
    return this.call("kalvoice_listen_cancel");
  }

  /** `consent` must come from the user confirming the download dialog. */
  kalvoiceModelDownload(modelId: string, consent: boolean): Promise<void> {
    return this.call("kalvoice_model_download", { modelId, consent });
  }

  kalvoiceModelCancel(modelId: string): Promise<boolean> {
    return this.call("kalvoice_model_cancel", { modelId });
  }

  kalvoiceModelDelete(modelId: string): Promise<SpeechModelInfo[]> {
    return this.call("kalvoice_model_delete", { modelId });
  }

  /** Cached provider status; `detection` is null for providers not checked yet. */
  listProviders(): Promise<ProviderStatus[]> {
    return this.call("providers_list");
  }

  /** Runs read-only detection (version and sign-in status) for every provider. */
  detectProviders(): Promise<ProviderStatus[]> {
    return this.call("providers_detect");
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

  // Threads (Z3). `thread_list`, `thread_interrupt`, `thread_resume`, `thread_stop` and
  // `thread_archive` are also consumed by the Dashboard.

  listThreads(options: { workspaceId?: string; includeArchived?: boolean } = {}): Promise<ThreadSummary[]> {
    return this.call("thread_list", {
      workspaceId: options.workspaceId ?? null,
      includeArchived: options.includeArchived ?? false,
    });
  }

  getThread(threadId: string): Promise<ThreadSummary> {
    return this.call("thread_get", { threadId });
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

  createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    return this.call("thread_create", { ...input });
  }

  sendToThread(threadId: string, text: string): Promise<ThreadSummary> {
    return this.call("thread_send", { threadId, text });
  }

  interruptThread(threadId: string): Promise<ThreadSummary> {
    return this.call("thread_interrupt", { threadId });
  }

  resumeThread(threadId: string, text?: string): Promise<ThreadSummary> {
    return this.call("thread_resume", { threadId, text: text ?? null });
  }

  stopThread(threadId: string): Promise<ThreadSummary> {
    return this.call("thread_stop", { threadId });
  }

  renameThread(threadId: string, name: string): Promise<ThreadSummary> {
    return this.call("thread_rename", { threadId, name });
  }

  archiveThread(threadId: string): Promise<ThreadSummary> {
    return this.call("thread_archive", { threadId });
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

  createTerminal(workspaceId: string, shellId: string | null, size: TerminalSize): Promise<TerminalInfo> {
    return this.call("terminal_create", { workspaceId, shellId, ...clampTerminalSize(size) });
  }

  restartTerminal(terminalId: string, size: TerminalSize): Promise<TerminalInfo> {
    return this.call("terminal_restart", { terminalId, ...clampTerminalSize(size) });
  }

  closeTerminal(terminalId: string): Promise<void> {
    return this.call("terminal_close", { terminalId });
  }

  /** Sends input in order, split so no single write exceeds the native limit. */
  async writeTerminal(terminalId: string, data: string): Promise<void> {
    let start = 0;
    while (start < data.length) {
      let end = Math.min(data.length, start + TERMINAL_WRITE_CHUNK);
      // Never split a surrogate pair across two writes.
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      await this.call("terminal_write", { terminalId, data: data.slice(start, end) });
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
