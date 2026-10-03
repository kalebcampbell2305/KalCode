import type { AgentEvent, EventEnvelope, KalVoiceSignal } from "@kalcode/protocol";
import type { DoctorInvoke } from "./doctor";
import type { HandoffsCommandName } from "./handoffs";
import type { OperationsCommandName } from "./operations";
import type { UtilityCommandName } from "./utilities";

/** Every command the native runtime exposes (mirrors src-tauri/build.rs). */
export type CommandName =
  | HandoffsCommandName
  | OperationsCommandName
  | "boot"
  | "window_ready"
  | "settings_get"
  | "settings_update"
  | "runtime_status"
  | "runtime_retry"
  | "account_bootstrap"
  | "account_status"
  | "account_email_start"
  | "account_social_start"
  | "account_email_poll"
  | "account_auth_cancel"
  | "account_activate_free"
  | "account_checkout"
  | "account_portal"
  | "account_refresh"
  | "account_logout"
  | "account_usage"
  | "updater_status"
  | "updater_set_channel"
  | "updater_check"
  | "updater_cancel"
  | "updater_install"
  | "updater_restore_previous"
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
  // Managed provider accounts. Auth URLs, credentials and profile paths never cross IPC.
  | "provider_accounts_list"
  | "provider_account_create"
  | "provider_account_rename"
  | "provider_account_set_default"
  | "provider_account_archive"
  | "provider_account_bind"
  | "provider_account_unbind"
  | "provider_account_bindings_list"
  | "provider_account_usage"
  | "provider_codex_account_refresh"
  | "provider_codex_login_start"
  | "provider_codex_login_wait"
  | "provider_codex_login_cancel"
  | "provider_codex_logout"
  | "provider_claude_account_refresh"
  | "provider_claude_login_start"
  | "provider_claude_login_wait"
  | "provider_claude_login_cancel"
  | "provider_claude_logout"
  | "provider_gemini_account_refresh"
  | "provider_gemini_login_start"
  | "provider_gemini_login_wait"
  | "provider_gemini_login_cancel"
  | "provider_gemini_logout"
  // Provider Health (PROVIDERS-2): in-memory snapshots, never a provider process
  | "provider_health_list"
  | "provider_health_get"
  | "provider_health_trend"
  | "kalvoice_subscribe"
  | "kalvoice_status"
  | "kalvoice_request"
  | "kalvoice_meter_ui_command"
  | "kalvoice_preferences_update"
  | "kalvoice_listen_start"
  | "kalvoice_listen_stop"
  | "kalvoice_listen_cancel"
  | "kalvoice_fn_input"
  | "kalvoice_model_download"
  | "kalvoice_reasoning_prepare"
  | "kalvoice_reasoning_retry"
  | "kalvoice_model_cancel"
  | "kalvoice_model_delete"
  | "kalvoice_open_microphone_settings"
  | "kalvoice_talk"
  | "kalvoice_type_instead"
  | "kalvoice_latency"
  | "kalvoice_latency_record"
  // Threads (Z3)
  | "thread_list"
  | "thread_get"
  | "thread_worktree_states"
  | "thread_worktree_commit"
  | "thread_messages"
  | "thread_tool_calls"
  | "thread_options"
  | "thread_review_create_prompt"
  | "thread_review_prompt"
  | "thread_cancel_prompt_review"
  | "thread_create"
  | "thread_send"
  | "thread_interrupt"
  | "thread_resume"
  | "thread_stop"
  | "thread_rebind_account"
  | "session_resolve"
  | "thread_rename"
  | "thread_archive"
  | "thread_unarchive"
  | "thread_stream"
  // Universal Context Drop. Native resolves file handles; no file path crosses IPC.
  | "context_file_pick"
  | "context_preview_create"
  | "context_item_set"
  | "context_item_confirm"
  | "context_discard"
  | "context_send"
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
  | "provider_pane_info"
  // Session Locator, rail, home, recent work, workspace actions (Z7-W2)
  | "locator_search"
  | "locator_open"
  | "rail_state"
  | "rail_update"
  | "rail_section_set"
  | "rail_group_create"
  | "rail_group_update"
  | "rail_group_delete"
  | "rail_group_reorder"
  | "home_summary"
  | "recent_work"
  | "workspace_reveal"
  | "workspace_create"
  // Z6a read-only (the folder surface, Z7-W2)
  | "files_list"
  | "git_status"
  | "git_log"
  | "git_branches"
  // Pane layouts (Z7-W1)
  | "layout_get"
  | "layout_save"
  | "layout_presets"
  | "layout_preset_save"
  | "layout_preset_delete"
  // Notification center (Z7-W3)
  | "notification_list"
  | "notification_mark"
  | Parameters<DoctorInvoke>[0]
  | UtilityCommandName;

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
