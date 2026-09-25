/**
 * The pane system's command bus: how things outside the canvas (the command palette, KalVoice,
 * the Dashboard, notifications) ask the pane canvas to do something, without importing it. The
 * canvas that is on screen listens; `dispatchPaneCommand` reports whether one did.
 *
 * Every command is layout-only: none of them starts, stops or closes a process (Z7-14).
 */
import type { PaneContent, PaneDirection, SplitAxis } from "@kalcode/protocol";
import type { BuiltinPreset } from "./model.ts";

export type PaneCommand =
  /** Split the focused pane (the new pane opens `content`, or the "add" chooser). */
  | { kind: "split"; axis: SplitAxis; content?: PaneContent }
  /** Put panes showing these providers' threads side by side (KalVoice "split Claude and Codex"). */
  | { kind: "arrange-providers"; axis: SplitAxis; providerIds: string[] }
  /** Grow the focused pane toward `direction` by `steps` steps. */
  | { kind: "resize"; direction: PaneDirection; steps: number }
  /** Move keyboard focus to a neighbouring pane. */
  | { kind: "focus-direction"; direction: PaneDirection }
  /** Show `content` (opening it in the focused pane when it isn't shown) and focus it. */
  | { kind: "open"; content: PaneContent; placement?: "tab" | "split" }
  /** Close the pane showing `content`, the pane whose title matches `query`, or the focused one. */
  | { kind: "close"; content?: PaneContent; query?: string }
  | { kind: "maximize" }
  | { kind: "restore" }
  | { kind: "collapse" }
  | { kind: "reopen" }
  | { kind: "preset"; preset: BuiltinPreset }
  | { kind: "even" };

export type PaneCommandResult = { handled: true; message?: string } | { handled: false; message: string };

type Listener = (command: PaneCommand) => PaneCommandResult;

let listener: Listener | null = null;
/** Commands sent while no canvas listens (for example, just before Code mounts). */
let queued: PaneCommand[] = [];

/**
 * Registers the canvas that handles commands. One canvas is on screen at a time; the newest
 * registration wins. Commands queued before it mounted run now.
 */
export function listenForPaneCommands(handler: Listener): () => void {
  listener = handler;
  const pending = queued;
  queued = [];
  for (const command of pending) handler(command);
  return () => {
    if (listener === handler) listener = null;
  };
}

/**
 * Sends a command to the canvas on screen. With `queue`, a command sent while no canvas is
 * mounted (the caller is about to navigate to one) runs when it mounts.
 */
export function dispatchPaneCommand(command: PaneCommand, { queue = false } = {}): PaneCommandResult {
  if (listener) return listener(command);
  if (queue) {
    queued = [...queued.slice(-7), command];
    return { handled: true };
  }
  return { handled: false, message: "Open Code to arrange panes." };
}

/** Whether a canvas is on screen. */
export function paneCanvasListening(): boolean {
  return listener !== null;
}
