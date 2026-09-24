import type {
  AgentEvent,
  BootState,
  Diagnostics,
  EventEnvelope,
  PermissionMode,
  SecureStoreCheck,
  Settings,
  SettingsPatch,
  ThreadMessage,
  ThreadOptions,
  ThreadSummary,
  ToolCallRecord,
} from "@kalcode/protocol";
import { toKalCodeError } from "./errors.ts";
import type { CommandName, NativeTheme, Transport, Unsubscribe } from "./transport.ts";

/** Maximum page size accepted by `events_recent` (mirrors the native limit). */
export const MAX_EVENT_PAGE = 500;

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
      throw toKalCodeError(error);
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

  async streamThread(threadId: string, onEvent: (event: AgentEvent) => void): Promise<Unsubscribe> {
    try {
      return await this.transport.streamThread(threadId, onEvent);
    } catch (error) {
      throw toKalCodeError(error);
    }
  }

  async setNativeTheme(theme: NativeTheme): Promise<void> {
    try {
      await this.transport.setNativeTheme(theme);
    } catch {
      // Title-bar theming is cosmetic; never surface it as an error.
    }
  }
}
