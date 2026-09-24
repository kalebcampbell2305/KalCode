import type { AgentEvent, EventEnvelope } from "@kalcode/protocol";

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
  | "thread_stream";

export type Unsubscribe = () => Promise<void>;

export type NativeTheme = "light" | "dark" | null;

/** How the UI reaches the native runtime. Production always uses the Tauri transport. */
export interface Transport {
  readonly kind: "tauri" | "memory";
  invoke<T>(command: CommandName, args?: Record<string, unknown>): Promise<T>;
  subscribe(onEvent: (event: EventEnvelope) => void): Promise<Unsubscribe>;
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
    const { createMemoryTransport } = await import("./memoryTransport.ts");
    return createMemoryTransport();
  }
  return null;
}
