import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** How a newer build applies: `ui` live in this window, `core` through a quick handoff. */
export type UpdateClass = "ui" | "core";

export type LivePhase =
  | "IDLE"
  | "CHECKING"
  | "DOWNLOADING"
  | "VERIFYING"
  | "STAGED"
  | "LIVE_APPLYING"
  | "HANDOFF_PREPARING"
  | "HANDOFF"
  | "UPDATED"
  | "ROLLED_BACK"
  | "FAILED"
  | "SUPERSEDED";

export interface LiveUpdated {
  version: string;
  class: UpdateClass;
  /** Unix milliseconds. */
  at: number;
}

export interface LiveTimings {
  detectMs: number | null;
  downloadMs: number | null;
  verifyMs: number | null;
  activateMs: number | null;
  rendererRefreshMs: number | null;
  coreHandoffMs: number | null;
  stateRestoreMs: number | null;
}

/** Mirrors `live_update::LiveStatus`. */
export interface LiveStatus {
  phase: LivePhase;
  shellVersion: string;
  uiVersion: string;
  pendingVersion: string | null;
  pendingClass: UpdateClass | null;
  waitingFor: string | null;
  lastUpdated: LiveUpdated | null;
  timings: LiveTimings;
  lastError: string | null;
}

export interface UiReady {
  reload: boolean;
  updated: LiveUpdated | null;
}

export const STAGED_EVENT = "live-update://ui-staged";
export const HANDOFF_EVENT = "live-update://handoff";
export const STATUS_EVENT = "live-update://status";

const available = () => {
  try {
    return isTauri();
  } catch {
    return false;
  }
};

export async function liveUpdateStatus(): Promise<LiveStatus | null> {
  if (!available()) return null;
  return invoke<LiveStatus | null>("live_update_status");
}

/** Tells the shell this UI loaded. A live UI that never says so is rolled back. */
export async function reportUiReady(): Promise<UiReady> {
  if (!available()) return { reload: false, updated: null };
  return invoke<UiReady>("live_update_ui_ready");
}

/** The UI saved its state and reloads into the staged UI now. */
export async function beginLiveReload(): Promise<void> {
  if (!available()) return;
  await invoke("live_update_begin_reload");
}

/** The UI saved its state for a core handoff. */
export async function reportHandoffReady(): Promise<void> {
  if (!available()) return;
  await invoke("live_update_handoff_ready");
}

const noop: UnlistenFn = () => undefined;

/** A newer UI is verified and staged; `version` is its build. */
export async function onUiStaged(handler: (version: string) => void): Promise<UnlistenFn> {
  if (!available()) return noop;
  return listen<string>(STAGED_EVENT, (event) => handler(event.payload));
}

/** A core handoff starts (`version`) or was called off (`null`). */
export async function onHandoff(handler: (version: string | null) => void): Promise<UnlistenFn> {
  if (!available()) return noop;
  return listen<string | null>(HANDOFF_EVENT, (event) => handler(event.payload));
}

export async function onLiveStatus(handler: (status: LiveStatus) => void): Promise<UnlistenFn> {
  if (!available()) return noop;
  return listen<LiveStatus>(STATUS_EVENT, (event) => handler(event.payload));
}
