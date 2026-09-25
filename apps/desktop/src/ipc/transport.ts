import type { AgentEvent, EventEnvelope, KalVoiceSignal } from "@kalcode/protocol";

/** Every command the native runtime exposes (mirrors src-tauri/build.rs). */
export type CommandName =
  | "boot"
  | "window_ready"
  | "settings_get"
  | "settings_update"
  | "events_recent"
  | "events_query"
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
  // Threads (Z3)
  | "thread_list"
  | "thread_get"
  | "thread_messages"
  | "thread_tool_calls"
  | "thread_options"
  | "thread_create"
  | "thread_send"
  | "thread_interrupt"
  | "thread_resume"
  | "thread_stop"
  | "thread_rename"
  | "thread_archive"
  | "thread_stream"
  // Permissions (Z4)
  | "approval_list"
  | "approval_decide"
  | "permission_profiles_list"
  | "thread_set_permission_mode"
  | "permission_settings_get"
  | "permission_settings_update"
  // Workspaces and terminals (Z1)
  | "workspace_list"
  | "workspace_active"
  | "workspace_open_dialog"
  | "workspace_activate"
  | "workspace_remove"
  | "shells_list"
  | "terminal_list"
  | "terminal_create"
  | "terminal_restart"
  | "terminal_close"
  | "terminal_write"
  | "terminal_resize"
  | "terminal_attach"
  | "terminal_detach"
  | "terminal_ack"
  | "terminal_set_active"
  | "terminals_running"
  // Provider panes (Z7-W4; attach goes through surfaces/code/panes/paneChannel.ts)
  | "provider_pane_create"
  | "provider_pane_ack"
  | "provider_pane_detach"
  | "provider_pane_write"
  | "provider_pane_resize"
  | "provider_pane_info";

export type Unsubscribe = () => Promise<void>;

export type NativeTheme = "light" | "dark" | null;

/** How the UI reaches the native runtime. Production always uses the Tauri transport. */
export interface Transport {
  readonly kind: "tauri" | "memory";
  invoke<T>(command: CommandName, args?: Record<string, unknown>): Promise<T>;
  subscribe(onEvent: (event: EventEnvelope) => void): Promise<Unsubscribe>;
  /** Live KalVoice signals for this window (listening, level, transcripts, downloads). */
  subscribeKalVoice(onSignal: (signal: KalVoiceSignal) => void): Promise<void>;
  /**
   * Streams a terminal's output bytes to `onOutput`: the first call is the scrollback replay
   * (possibly empty), then live output. Resolves to false when the terminal has no session
   * (it ended before this launch). Resolves to the attachment id (null when the terminal has
   * no session); acknowledge rendered bytes with `terminal_ack` and detach with `terminal_detach`.
   */
  attachTerminal(terminalId: string, onOutput: (bytes: Uint8Array) => void): Promise<number | null>;
  /**
   * Live stream of one thread's message deltas (`thread_stream`). The native side keeps one
   * stream per window: opening another thread's stream replaces this one.
   */
  streamThread(threadId: string, onEvent: (event: AgentEvent) => void): Promise<Unsubscribe>;
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
    async attachTerminal(terminalId, onOutput) {
      // Raw channel messages arrive as ArrayBuffers (InvokeResponseBody::Raw).
      const channel = new Channel<ArrayBuffer>();
      channel.onmessage = (buffer) => onOutput(new Uint8Array(buffer));
      return invoke<number | null>("terminal_attach", { terminalId, onOutput: channel });
    },
    async streamThread(threadId, onEvent) {
      const channel = new Channel<AgentEvent>();
      let open = true;
      channel.onmessage = (event) => {
        if (open) onEvent(event);
      };
      await invoke<number>("thread_stream", { threadId, onEvent: channel });
      // Native replaces a window's stream when another is opened and drops it on reload.
      return async () => {
        open = false;
      };
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
    // One in-memory runtime per page, even when React StrictMode boots the UI twice. Its test
    // hooks are on `window.__kalcodeMemory` (see memoryTransport.ts).
    const { sharedMemoryTransport } = await import("./memoryTransport.ts");
    return sharedMemoryTransport();
  }
  return null;
}
