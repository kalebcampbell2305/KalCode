import type {
  ApprovalDecision,
  ApprovalView,
  BootState,
  Diagnostics,
  EventEnvelope,
  PermissionMode,
  PermissionProfile,
  PermissionSettings,
  SecureStoreCheck,
  Settings,
  SettingsPatch,
  ThreadSummary,
} from "@kalcode/protocol";
import { toKalCodeError } from "./errors.ts";
import type { CommandName, NativeTheme, Transport, Unsubscribe } from "./transport.ts";

/** Maximum page size accepted by `events_recent` (mirrors the native limit). */
export const MAX_EVENT_PAGE = 500;

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

  async setNativeTheme(theme: NativeTheme): Promise<void> {
    try {
      await this.transport.setNativeTheme(theme);
    } catch {
      // Title-bar theming is cosmetic; never surface it as an error.
    }
  }
}
