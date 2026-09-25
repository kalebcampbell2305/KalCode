import type { EventEnvelope, KalVoiceSignal } from "@kalcode/protocol";

/** Every command the native runtime exposes (mirrors src-tauri/build.rs). */
export type CommandName =
  | "boot"
  | "window_ready"
  | "settings_get"
  | "settings_update"
  | "events_recent"
  | "events_subscribe"
  | "events_unsubscribe"
  | "diagnostics_get"
  | "diagnostics_open_log_dir"
  | "diagnostics_open_data_dir"
  | "secure_store_check"
  | "providers_list"
  | "providers_detect"
  | "kalvoice_subscribe"
  | "kalvoice_status"
  | "kalvoice_request"
  | "kalvoice_preferences_update"
  | "kalvoice_listen_start"
  | "kalvoice_listen_stop"
  | "kalvoice_listen_cancel"
  | "kalvoice_model_download"
  | "kalvoice_model_cancel"
  | "kalvoice_model_delete"
  | "kalvoice_talk"
  | "kalvoice_type_instead"
  | "kalvoice_latency"
  | "kalvoice_latency_record"
  // Contract commands the Dashboard consumes (docs/CONTRACTS.md). They are implemented natively
  // by Z1 (terminals), Z3 (threads) and Z4 (approvals); until those land, the native runtime
  // rejects them and the client reports `command_unavailable`.
  | "thread_list"
  | "thread_interrupt"
  | "thread_resume"
  | "thread_stop"
  | "thread_archive"
  | "approval_list"
  | "approval_decide"
  | "terminals_running";

export type Unsubscribe = () => Promise<void>;

export type NativeTheme = "light" | "dark" | null;

/** How the UI reaches the native runtime. Production always uses the Tauri transport. */
export interface Transport {
  readonly kind: "tauri" | "memory";
  invoke<T>(command: CommandName, args?: Record<string, unknown>): Promise<T>;
  subscribe(onEvent: (event: EventEnvelope) => void): Promise<Unsubscribe>;
  /** Live KalVoice signals for this window (listening, level, transcripts, downloads). */
  subscribeKalVoice(onSignal: (signal: KalVoiceSignal) => void): Promise<void>;
  /** Syncs the OS window chrome (title bar) with the app theme. */
  setNativeTheme(theme: NativeTheme): Promise<void>;
}

export async function createTauriTransport(): Promise<Transport> {
  const [{ invoke, Channel }, { getCurrentWindow }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/window"),
  ]);
  return {
    kind: "tauri",
    invoke: (command, args) => invoke(command, args),
    async subscribe(onEvent) {
      const channel = new Channel<EventEnvelope>();
      channel.onmessage = onEvent;
      const id = await invoke<number>("events_subscribe", { onEvent: channel });
      return async () => {
        await invoke<boolean>("events_unsubscribe", { id });
      };
    },
    async subscribeKalVoice(onSignal) {
      const channel = new Channel<KalVoiceSignal>();
      channel.onmessage = onSignal;
      await invoke("kalvoice_subscribe", { onSignal: channel });
    },
    async setNativeTheme(theme) {
      await getCurrentWindow().setTheme(theme);
    },
  };
}

/** Resolves the transport for this runtime, or null when no native runtime is present. */
export async function resolveTransport(): Promise<Transport | null> {
  const { isTauri } = await import("@tauri-apps/api/core");
  if (isTauri()) return createTauriTransport();
  // The in-memory transport is compiled only into the `ui-test` build (see vite.config.ts).
  if (__KALCODE_MEMORY_TRANSPORT__) {
    const { createMemoryTransport } = await import("./memoryTransport.ts");
    return createMemoryTransport();
  }
  return null;
}
