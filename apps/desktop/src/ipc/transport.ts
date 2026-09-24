import type { EventEnvelope } from "@kalcode/protocol";

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
  | "terminals_running";

export type Unsubscribe = () => Promise<void>;

export type NativeTheme = "light" | "dark" | null;

/** How the UI reaches the native runtime. Production always uses the Tauri transport. */
export interface Transport {
  readonly kind: "tauri" | "memory";
  invoke<T>(command: CommandName, args?: Record<string, unknown>): Promise<T>;
  subscribe(onEvent: (event: EventEnvelope) => void): Promise<Unsubscribe>;
  /**
   * Streams a terminal's output bytes to `onOutput`: the first call is the scrollback replay
   * (possibly empty), then live output. Resolves to false when the terminal has no session
   * (it ended before this launch). Resolves to the attachment id (null when the terminal has
   * no session); acknowledge rendered bytes with `terminal_ack` and detach with `terminal_detach`.
   */
  attachTerminal(terminalId: string, onOutput: (bytes: Uint8Array) => void): Promise<number | null>;
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
    async attachTerminal(terminalId, onOutput) {
      // Raw channel messages arrive as ArrayBuffers (InvokeResponseBody::Raw).
      const channel = new Channel<ArrayBuffer>();
      channel.onmessage = (buffer) => onOutput(new Uint8Array(buffer));
      return invoke<number | null>("terminal_attach", { terminalId, onOutput: channel });
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
    const { sharedMemoryTransport } = await import("./memoryTransport.ts");
    return sharedMemoryTransport();
  }
  return null;
}
