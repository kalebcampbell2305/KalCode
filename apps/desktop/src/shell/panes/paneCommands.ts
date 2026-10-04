/**
 * The pane system's command bus: how things outside the canvas (the command palette, KalVoice,
 * the Dashboard, notifications) ask the pane canvas to do something, without importing it. The
 * canvas that is on screen listens; `dispatchPaneCommand` reports whether one did.
 *
 * Most commands only change layout. Closing a terminal or provider tab follows that content's
 * existing close behavior, which can stop its process.
 */
import type { BrowserControl, PaneContent, PaneDirection, PaneLayout, SplitAxis, UiDirective } from "@kalcode/protocol";
import {
  type BuiltinPreset,
  contentKey,
  findLeaf,
  leaves,
  movePane,
  resizePaneRelative,
  setCollapsed,
  setMaximized,
} from "./model.ts";

export type PaneControlCommand = Extract<UiDirective, { kind: "control_pane" }>["command"];

export interface PaneQueryCandidate {
  paneId: string;
  names: readonly string[];
}

export interface PaneContentName {
  title: string;
  aliases?: readonly string[];
}

export type PaneQueryResolution = { kind: "found"; paneId: string } | { kind: "ambiguous" } | { kind: "missing" };

export interface PaneTabQueryCandidate {
  paneId: string;
  tabIndex: number;
  names: readonly string[];
}

export type PaneTabQueryResolution =
  | { kind: "found"; paneId: string; tabIndex: number }
  | { kind: "ambiguous" }
  | { kind: "missing" };

/** Builds query candidates from every tab, including tabs that are not active. */
export function paneQueryCandidates(
  layout: PaneLayout,
  describe: (contentKey: string) => PaneContentName | null,
): PaneQueryCandidate[] {
  return leaves(layout.root).map((leaf) => ({
    paneId: leaf.paneId,
    names: leaf.tabs.flatMap((content) => {
      const description = describe(contentKey(content));
      return description ? [description.title, ...(description.aliases ?? [])] : [];
    }),
  }));
}

/** Resolves exact names first, then a unique partial name. Ambiguity never selects a pane. */
export function resolvePaneQuery(query: string, candidates: readonly PaneQueryCandidate[]): PaneQueryResolution {
  const needle = query.trim().toLowerCase();
  if (!needle) return { kind: "missing" };
  const matching = (exact: boolean) =>
    new Set(
      candidates
        .filter((candidate) =>
          candidate.names.some((name) => {
            const normalized = name.trim().toLowerCase();
            return exact ? normalized === needle : normalized.includes(needle);
          }),
        )
        .map((candidate) => candidate.paneId),
    );
  const exact = matching(true);
  if (exact.size === 1) return { kind: "found", paneId: [...exact][0] as string };
  if (exact.size > 1) return { kind: "ambiguous" };
  const partial = matching(false);
  if (partial.size === 1) return { kind: "found", paneId: [...partial][0] as string };
  return partial.size > 1 ? { kind: "ambiguous" } : { kind: "missing" };
}

/** Resolves a specific tab rather than collapsing every matching tab into its containing pane. */
export function resolvePaneTabQuery(
  query: string,
  candidates: readonly PaneTabQueryCandidate[],
): PaneTabQueryResolution {
  const needle = query.trim().toLowerCase();
  if (!needle) return { kind: "missing" };
  const matching = (exact: boolean) =>
    candidates.filter((candidate) =>
      candidate.names.some((name) => {
        const normalized = name.trim().toLowerCase();
        return exact ? normalized === needle : normalized.includes(needle);
      }),
    );
  const exact = matching(true);
  if (exact.length === 1) {
    const target = exact[0] as PaneTabQueryCandidate;
    return { kind: "found", paneId: target.paneId, tabIndex: target.tabIndex };
  }
  if (exact.length > 1) return { kind: "ambiguous" };
  const partial = matching(false);
  if (partial.length === 1) {
    const target = partial[0] as PaneTabQueryCandidate;
    return { kind: "found", paneId: target.paneId, tabIndex: target.tabIndex };
  }
  return partial.length > 1 ? { kind: "ambiguous" } : { kind: "missing" };
}

/** Names provider panes by stable one-based creation order within each provider. */
export function providerPaneAliases(
  threadsOldestFirst: readonly { threadId: string; providerId: string }[],
  providerName: (providerId: string) => { full: string; short: string },
): Map<string, string[]> {
  const ordinalByProvider = new Map<string, number>();
  const aliases = new Map<string, string[]>();
  for (const thread of threadsOldestFirst) {
    const ordinal = (ordinalByProvider.get(thread.providerId) ?? 0) + 1;
    ordinalByProvider.set(thread.providerId, ordinal);
    const name = providerName(thread.providerId);
    aliases.set(`thread:${thread.threadId}`, [...new Set([`${name.full} ${ordinal}`, `${name.short} ${ordinal}`])]);
  }
  return aliases;
}

/** A pane content's provider ordinal names. Agent panes are keyed by their thread id. */
export function providerPaneAliasesOf(aliases: ReadonlyMap<string, string[]>, content: PaneContent): string[] {
  return aliases.get(content.kind === "agent" ? `thread:${content.agentId}` : contentKey(content)) ?? [];
}

export type PaneMutationResult =
  | { handled: true; layout: PaneLayout; paneId?: string }
  | { handled: false; message: string };

/** Selects newest distinct threads for the legacy provider-name arrangement command. */
export function selectDistinctProviderThreads(
  providerIds: readonly string[],
  threadsOldestFirst: readonly { threadId: string; providerId: string }[],
): { threadIds: string[]; missing: string[] } {
  const available = [...threadsOldestFirst].reverse();
  const used = new Set<string>();
  const threadIds: string[] = [];
  const missing: string[] = [];
  for (const providerId of providerIds) {
    const match = available.find((thread) => thread.providerId === providerId && !used.has(thread.threadId));
    if (!match) {
      missing.push(providerId);
      continue;
    }
    used.add(match.threadId);
    threadIds.push(match.threadId);
  }
  return { threadIds, missing };
}

function targetPane(
  query: string | null,
  candidates: readonly PaneQueryCandidate[],
  focusedPaneId: string | null,
): { paneId: string } | { message: string } {
  if (!query?.trim()) {
    return focusedPaneId ? { paneId: focusedPaneId } : { message: "There's no focused pane." };
  }
  const resolution = resolvePaneQuery(query, candidates);
  if (resolution.kind === "found") return { paneId: resolution.paneId };
  return {
    message: resolution.kind === "ambiguous" ? `More than one pane matches “${query}”.` : `No pane matches “${query}”.`,
  };
}

/** Applies one shared pane-control command without guessing when a name is missing or ambiguous. */
export function applyPaneControl(
  layout: PaneLayout,
  command: PaneControlCommand,
  candidates: readonly PaneQueryCandidate[],
  focusedPaneId: string | null,
  size: { width: number; height: number },
): PaneMutationResult {
  if (command.kind === "restore") return { handled: true, layout: setMaximized(layout, null) };
  const source = targetPane(command.query, candidates, focusedPaneId);
  if ("message" in source) return { handled: false, message: source.message };
  const paneId = source.paneId;

  if (command.kind === "resize") {
    const next = resizePaneRelative(layout, paneId, command.grow, 32, size.width, size.height);
    return next === layout
      ? { handled: false, message: "That pane can't be resized here." }
      : { handled: true, layout: next, paneId };
  }
  if (command.kind === "move") {
    const target = targetPane(command.beside, candidates, focusedPaneId);
    if ("message" in target) return { handled: false, message: target.message };
    if (target.paneId === paneId) return { handled: false, message: "A pane can't be moved beside itself." };
    const next = movePane(layout, paneId, target.paneId, "right");
    return next === layout
      ? { handled: false, message: "That pane couldn't be moved." }
      : { handled: true, layout: next, paneId };
  }
  if (command.kind === "maximize") {
    return { handled: true, layout: setMaximized(layout, paneId), paneId };
  }
  const leaf = findLeaf(layout, paneId);
  if (!leaf) return { handled: false, message: "That pane is no longer open." };
  const collapsed = command.kind === "collapse";
  if (leaf.collapsed === collapsed) return { handled: true, layout, paneId };
  const next = setCollapsed(layout, paneId, collapsed);
  return next === layout
    ? { handled: false, message: "At least one pane must stay open." }
    : { handled: true, layout: next, paneId };
}

export type PaneCommand =
  /** Split the focused pane (the new pane opens `content`, or the "add" chooser). */
  | { kind: "split"; axis: SplitAxis; content?: PaneContent }
  /** Put panes showing these providers' threads side by side (KalVoice "split Claude and Codex"). */
  | { kind: "arrange-providers"; axis: SplitAxis; providerIds: string[] }
  /** Shows the exact provider pane threads created by the native executor. */
  | { kind: "open-provider-panes"; threadIds: string[] }
  /** Opens Code's + launcher using the last selection unless a provider is named. */
  | { kind: "open-agent-launcher"; providerId?: string }
  /** Open Browser beside this exact coding agent, regardless of the active tab. */
  | { kind: "agent-browser-beside"; threadId: string }
  /** Applies a named, deterministic layout operation. */
  | { kind: "control-pane"; command: PaneControlCommand }
  /** Applies one bounded action to an embedded browser pane. */
  | { kind: "browser-control"; command: BrowserControl }
  /** Opens a Live Browser beside a pane, agent or terminal (far right when none is named). */
  | {
      kind: "open-live-browser";
      url: string | null;
      beside: { paneId: string } | { agentId: string } | { terminalId: string } | null;
    }
  /** Grow the focused pane toward `direction` by `steps` steps. */
  | { kind: "resize"; direction: PaneDirection; steps: number }
  /** Move keyboard focus to a neighbouring pane. */
  | { kind: "focus-direction"; direction: PaneDirection }
  /** Show `content` (opening it in the focused pane when it isn't shown) and focus it. */
  | { kind: "open"; content: PaneContent; placement?: "tab" | "split" }
  /** Close the exact content/query tab, or close the focused pane when no target is named. */
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
let queued: {
  command: PaneCommand;
  scope: string | null;
  onResult?: (result: PaneCommandResult) => void;
  signal?: AbortSignal;
}[] = [];

/**
 * Registers the canvas that handles commands. One canvas is on screen at a time; the newest
 * registration wins. Commands queued for it (or for no particular scope) run now.
 */
export function listenForPaneCommands(handler: Listener, scope: string | null = null): () => void {
  const registration: Registration = { handler, scope };
  current = registration;
  queued = queued.filter((q) => !q.signal?.aborted);
  const ready = queued.filter((q) => q.scope === null || q.scope === scope);
  queued = queued.filter((q) => !ready.includes(q));
  for (const { command, onResult, signal } of ready) {
    if (signal?.aborted) continue;
    const result = handler(command);
    if (!signal?.aborted) onResult?.(result);
  }
  return () => {
    if (current === registration) current = null;
  };
}

export interface DispatchOptions {
  /** Wait for a canvas when none (or not the one for `scope`) is on screen yet. */
  queue?: boolean;
  /** Only the canvas arranging this workspace may run the command. */
  scope?: string | null;
  /** Receives the command result even when delivery waits for the scoped canvas to mount. */
  onResult?: (result: PaneCommandResult) => void;
  /** Cancel delivery while activation or canvas mounting is pending. */
  signal?: AbortSignal;
}

/**
 * Sends a command to the canvas on screen. With `queue`, a command sent while no canvas (or not
 * the right one) is mounted — the caller is about to navigate there — runs when it mounts.
 */
export function dispatchPaneCommand(
  command: PaneCommand,
  { queue = false, scope = null, onResult, signal }: DispatchOptions = {},
): PaneCommandResult {
  if (signal?.aborted) return { handled: false, message: "Cancelled." };
  if (current && (scope === null || current.scope === scope)) {
    const result = current.handler(command);
    if (!signal?.aborted) onResult?.(result);
    return result;
  }
  if (queue) {
    queued = queued.filter((entry) => !entry.signal?.aborted);
    if (queued.length >= 8) {
      queued[0]?.onResult?.({ handled: false, message: "That pane command expired before Code was ready." });
    }
    queued = [...queued.slice(-7), { command, scope, onResult, signal }];
    return { handled: true };
  }
  return { handled: false, message: "Open Code to arrange panes." };
}

/** Activates the authoritative workspace before delivering one scoped, queueable layout command. */
export async function activateAndDispatchPaneCommand(
  workspaceId: string,
  command: PaneCommand,
  activate: (workspaceId: string) => Promise<boolean>,
  navigateToCode: () => void,
  onResult?: (result: PaneCommandResult) => void,
  signal?: AbortSignal,
): Promise<PaneCommandResult> {
  if (signal?.aborted) return { handled: false, message: "Cancelled." };
  const activated = await activate(workspaceId);
  if (signal?.aborted) return { handled: false, message: "Cancelled." };
  if (!activated) {
    const result: PaneCommandResult = { handled: false, message: "Couldn't switch to that workspace." };
    onResult?.(result);
    return result;
  }
  navigateToCode();
  return dispatchPaneCommand(command, { scope: workspaceId, queue: true, onResult, signal });
}

/** Whether a canvas is on screen (for `scope`, when given). */
export function paneCanvasListening(scope: string | null = null): boolean {
  return current !== null && (scope === null || current.scope === scope);
}

/** Test helper: drops queued commands. */
export function clearQueuedPaneCommands() {
  queued = [];
}
