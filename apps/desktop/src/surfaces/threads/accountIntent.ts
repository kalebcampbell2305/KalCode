import { useSyncExternalStore } from "react";

/**
 * Account-switch requests from outside the thread view (command palette, KalVoice) and the
 * thread the Threads surface is showing. A tiny store rather than a route, like
 * `providersTab.ts`: a request never rebinds anything by itself. The Threads surface reads it,
 * opens the Rebind dialog, and only the person's confirmation calls `thread_rebind_account`.
 */

/** The thread the Threads surface currently shows (null when none is selected). */
export interface SelectedThread {
  threadId: string;
  providerId: string;
  /** The thread's current account (null for legacy threads without one). */
  providerAccountId: string | null;
}

/** Ask the Threads surface to confirm switching `threadId` to `accountId`. */
export interface RebindRequest {
  threadId: string;
  accountId: string;
  /** Distinguishes repeated requests for the same pair. */
  nonce: number;
}

interface AccountIntentState {
  selected: SelectedThread | null;
  rebind: RebindRequest | null;
}

let state: AccountIntentState = { selected: null, rebind: null };
let nextNonce = 1;
const listeners = new Set<() => void>();

function update(next: AccountIntentState): void {
  state = next;
  for (const listener of listeners) listener();
}

function sameSelection(a: SelectedThread | null, b: SelectedThread | null): boolean {
  if (a === null || b === null) return a === b;
  return a.threadId === b.threadId && a.providerId === b.providerId && a.providerAccountId === b.providerAccountId;
}

/** Called by the Threads surface whenever the shown thread (or its account) changes. */
export function setSelectedThread(selected: SelectedThread | null): void {
  if (sameSelection(state.selected, selected)) return;
  update({ ...state, selected: selected === null ? null : { ...selected } });
}

/** The thread the Threads surface shows right now, for non-React callers (palette, KalVoice). */
export function getSelectedThread(): SelectedThread | null {
  return state.selected;
}

/** Opens the Rebind dialog for `threadId` → `accountId` once the Threads surface shows it. */
export function requestRebind(threadId: string, accountId: string): RebindRequest {
  const request = { threadId, accountId, nonce: nextNonce++ };
  update({ ...state, rebind: request });
  return request;
}

/** Marks a request handled (confirmed or cancelled) so it doesn't reopen the dialog. */
export function consumeRebindRequest(nonce: number): void {
  if (state.rebind?.nonce !== nonce) return;
  update({ ...state, rebind: null });
}

/** The latest pending request, for non-React callers and tests. */
export function getRebindRequest(): RebindRequest | null {
  return state.rebind;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The latest pending rebind request (null when none is waiting). */
export function useRebindRequest(): RebindRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => state.rebind,
    () => state.rebind,
  );
}

/** The thread the Threads surface shows. */
export function useSelectedThread(): SelectedThread | null {
  return useSyncExternalStore(
    subscribe,
    () => state.selected,
    () => state.selected,
  );
}

/** Test-only: forget every selection and request. */
export function resetAccountIntentForTests(): void {
  update({ selected: null, rebind: null });
}
