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

interface Registration {
  handler: Listener;
  /** What the canvas arranges (the workspace id), when it says. */
  scope: string | null;
}

let current: Registration | null = null;
/** Commands waiting for a canvas (optionally for one scope). */
let queued: { command: PaneCommand; scope: string | null }[] = [];

/**
 * Registers the canvas that handles commands. One canvas is on screen at a time; the newest
 * registration wins. Commands queued for it (or for no particular scope) run now.
 */
export function listenForPaneCommands(handler: Listener, scope: string | null = null): () => void {
  const registration: Registration = { handler, scope };
  current = registration;
  const ready = queued.filter((q) => q.scope === null || q.scope === scope);
  queued = queued.filter((q) => !ready.includes(q));
  for (const { command } of ready) handler(command);
  return () => {
    if (current === registration) current = null;
  };
}

export interface DispatchOptions {
  /** Wait for a canvas when none (or not the one for `scope`) is on screen yet. */
  queue?: boolean;
  /** Only the canvas arranging this workspace may run the command. */
  scope?: string | null;
}

/**
 * Sends a command to the canvas on screen. With `queue`, a command sent while no canvas (or not
 * the right one) is mounted — the caller is about to navigate there — runs when it mounts.
 */
export function dispatchPaneCommand(
  command: PaneCommand,
  { queue = false, scope = null }: DispatchOptions = {},
): PaneCommandResult {
  if (current && (scope === null || current.scope === scope)) return current.handler(command);
  if (queue) {
    queued = [...queued.slice(-7), { command, scope }];
    return { handled: true };
  }
  return { handled: false, message: "Open Code to arrange panes." };
}

/** Whether a canvas is on screen (for `scope`, when given). */
export function paneCanvasListening(scope: string | null = null): boolean {
  return current !== null && (scope === null || current.scope === scope);
}

/** Test helper: drops queued commands. */
export function clearQueuedPaneCommands() {
  queued = [];
}
