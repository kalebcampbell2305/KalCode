import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalView,
  BootState,
  Diagnostics,
  EventEnvelope,
  PermissionMode,
  PermissionProfile,
  PermissionSettings,
  ProviderStatus,
  SecureStoreCheck,
  Settings,
  SettingsPatch,
  ShellOption,
  TerminalInfo,
  ThreadMessage,
  ThreadOptions,
  ThreadSummary,
  ToolCallRecord,
  Workspace,
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

  /** Cached provider status; `detection` is null for providers not checked yet. */
  listProviders(): Promise<ProviderStatus[]> {
    return this.call("providers_list");
  }

  /** Runs read-only detection (version and sign-in status) for every provider. */
  detectProviders(): Promise<ProviderStatus[]> {
    return this.call("providers_detect");
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

  async setNativeTheme(theme: NativeTheme): Promise<void> {
    try {
      await this.transport.setNativeTheme(theme);
    } catch {
      // Title-bar theming is cosmetic; never surface it as an error.
    }
  }
}
