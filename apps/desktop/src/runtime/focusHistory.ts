import { useSyncExternalStore } from "react";

/**
 * The threads and terminals the person used most recently, newest first ("go back to the
 * terminal I was just using"). Bounded and in memory only: it holds ids, never names or text,
 * and starts empty on every launch. Recorded by `UiIntentsProvider` (thread focus, the thread the
 * Threads surface shows) and `WorkspaceProvider.selectTerminal`; read by `UiIntents.focusPrevious`.
 */
export type FocusEntry =
  | { kind: "agent"; agentId: string; workspaceId: string }
  | { kind: "thread"; threadId: string; workspaceId: string | null }
  | { kind: "terminal"; terminalId: string; workspaceId: string };

/** How many recent targets are remembered. */
export const MAX_FOCUS_HISTORY = 5;

let entries: readonly FocusEntry[] = [];
const listeners = new Set<() => void>();

const keyOf = (entry: FocusEntry) =>
  entry.kind === "agent"
    ? `agent:${entry.agentId}`
    : entry.kind === "thread"
      ? `thread:${entry.threadId}`
      : `terminal:${entry.terminalId}`;

function publish(next: readonly FocusEntry[]): void {
  entries = next;
  for (const listener of listeners) listener();
}

/** Records that `entry` is now in front. Re-recording the current target changes nothing. */
export function recordFocus(entry: FocusEntry): void {
  const key = keyOf(entry);
  const current = entries[0];
  if (current && keyOf(current) === key) {
    // Same target: keep it, but learn a workspace we didn't know yet.
    if (entry.kind === "thread" && current.kind === "thread" && !current.workspaceId && entry.workspaceId) {
      publish([{ ...entry }, ...entries.slice(1)]);
    }
    return;
  }
  const previous = entries.find((e) => keyOf(e) === key);
  const merged =
    previous?.kind === "thread" && entry.kind === "thread" && !entry.workspaceId
      ? { ...entry, workspaceId: previous.workspaceId }
      : { ...entry };
  publish([merged, ...entries.filter((e) => keyOf(e) !== key)].slice(0, MAX_FOCUS_HISTORY));
}

/** The target used before the current one (what "go back" focuses), or null. */
export function previousFocus(): FocusEntry | null {
  return entries[1] ?? null;
}

/** Newest first. */
export function focusHistory(): readonly FocusEntry[] {
  return entries;
}

/** Drops a thread or terminal that no longer exists (archived, closed). */
export function forgetFocus(kind: FocusEntry["kind"], id: string): void {
  const next = entries.filter((e) => keyOf(e) !== `${kind}:${id}`);
  if (next.length !== entries.length) publish(next);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The recent targets, newest first. */
export function useFocusHistory(): readonly FocusEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => entries,
    () => entries,
  );
}

/** Test-only: forget everything. */
export function resetFocusHistoryForTests(): void {
  publish([]);
}
