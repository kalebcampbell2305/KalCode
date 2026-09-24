import type {
  ApprovalDecision,
  ApprovalRequest,
  BootState,
  CommandRequest,
  Diagnostics,
  EventEnvelope,
  KalVoiceMode,
  KalVoicePreferencesPatch,
  KalVoiceResponse,
  KalVoiceSignal,
  KalVoiceStatus,
  ProviderStatus,
  SecureStoreCheck,
  Settings,
  SettingsPatch,
  SpeechModelInfo,
  ThreadSummary,
} from "@kalcode/protocol";
import { toKalCodeError } from "./errors.ts";
import type { TerminalInfo } from "./pendingContracts.ts";
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

  // ---- Contract commands consumed by the Dashboard (docs/CONTRACTS.md) ----
  // Implemented natively by Z3 (threads), Z4 (approvals) and Z1 (terminals). Until then they
  // reject with `command_unavailable` (see `isCommandUnavailable`). Arguments are the top-level
  // camelCase keys listed in the contract table.

  listThreads(input: { workspaceId?: string; includeArchived?: boolean } = {}): Promise<ThreadSummary[]> {
    return this.call("thread_list", {
      workspaceId: input.workspaceId ?? null,
      includeArchived: input.includeArchived ?? false,
    });
  }

  interruptThread(threadId: string): Promise<ThreadSummary> {
    return this.call("thread_interrupt", { threadId });
  }

  resumeThread(threadId: string): Promise<ThreadSummary> {
    return this.call("thread_resume", { threadId });
  }

  stopThread(threadId: string): Promise<ThreadSummary> {
    return this.call("thread_stop", { threadId });
  }

  archiveThread(threadId: string): Promise<ThreadSummary> {
    return this.call("thread_archive", { threadId });
  }

  listApprovals(status: "pending" | null = "pending"): Promise<ApprovalRequest[]> {
    return this.call("approval_list", { status });
  }

  decideApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalRequest> {
    return this.call("approval_decide", { requestId, decision });
  }

  runningTerminals(): Promise<TerminalInfo[]> {
    return this.call("terminals_running");
  }

  async setNativeTheme(theme: NativeTheme): Promise<void> {
    try {
      await this.transport.setNativeTheme(theme);
    } catch {
      // Title-bar theming is cosmetic; never surface it as an error.
    }
  }
}
