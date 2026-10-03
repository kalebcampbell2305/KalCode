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

/** The focused Code pane's identity only; account facts stay in the canonical registry. */
export interface SelectedCodeContext {
  workspaceId: string;
  content: { kind: "agent"; agentId: string } | { kind: "terminal"; terminalId: string } | null;
}

let selectedCode: SelectedCodeContext | null = null;
let codeSelectionOwner = 0;
const codeListeners = new Set<() => void>();

function sameCodeContext(left: SelectedCodeContext | null, right: SelectedCodeContext | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.workspaceId !== right.workspaceId) return false;
  const a = left.content;
  const b = right.content;
  if (a === null || b === null) return a === b;
  return a.kind === "agent"
    ? b.kind === "agent" && a.agentId === b.agentId
    : b.kind === "terminal" && a.terminalId === b.terminalId;
}

/** Publishes visible Code focus and returns cleanup that cannot clear a newer canvas. */
export function setSelectedCodeContext(context: SelectedCodeContext | null): () => void {
  const owner = ++codeSelectionOwner;
  if (!sameCodeContext(selectedCode, context)) {
    selectedCode = context === null ? null : { ...context, content: context.content && { ...context.content } };
    for (const listener of codeListeners) listener();
  }
  return () => {
    if (codeSelectionOwner === owner) setSelectedCodeContext(null);
  };
}

function subscribeCode(listener: () => void): () => void {
  codeListeners.add(listener);
  return () => {
    codeListeners.delete(listener);
  };
}

export function useSelectedCodeContext(): SelectedCodeContext | null {
  return useSyncExternalStore(
    subscribeCode,
    () => selectedCode,
    () => selectedCode,
  );
}

/** Ask the Threads surface to confirm switching `threadId` to `accountId`. */
export interface RebindRequest {
  threadId: string;
  accountId: string;
  /** Distinguishes repeated requests for the same pair. */
  nonce: number;
  /** After this (epoch ms) the request is dropped unanswered: a stale ask never opens the dialog. */
  expiresAt: number;
}

/** How long a rebind request waits for the Threads surface to show its dialog. */
export const REBIND_REQUEST_TTL_MS = 30_000;

interface AccountIntentState {
  selected: SelectedThread | null;
  rebind: RebindRequest | null;
}

let state: AccountIntentState = { selected: null, rebind: null };
let nextNonce = 1;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function update(next: AccountIntentState): void {
  if (next.rebind !== state.rebind && expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  state = next;
  if (next.rebind !== null && expiryTimer === null) {
    const nonce = next.rebind.nonce;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null;
        if (state.rebind?.nonce === nonce) update({ ...state, rebind: null });
      },
      Math.max(0, next.rebind.expiresAt - Date.now()),
    );
  }
  for (const listener of listeners) listener();
}

/** The pending request, unless it has expired. */
function liveRebind(): RebindRequest | null {
  return state.rebind !== null && Date.now() < state.rebind.expiresAt ? state.rebind : null;
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

/**
 * Opens the Rebind dialog for `threadId` → `accountId` once the Threads surface shows it. The
 * caller navigates to Threads; the request expires after 30 s or when the person leaves Threads.
 */
export function requestRebind(threadId: string, accountId: string): RebindRequest {
  const request = { threadId, accountId, nonce: nextNonce++, expiresAt: Date.now() + REBIND_REQUEST_TTL_MS };
  update({ ...state, rebind: request });
  return request;
}

/** Drops any pending request (the person moved to another surface). */
export function expireRebindRequest(): void {
  if (state.rebind !== null) update({ ...state, rebind: null });
}

/** Marks a request handled (confirmed or cancelled) so it doesn't reopen the dialog. */
export function consumeRebindRequest(nonce: number): void {
  if (state.rebind?.nonce !== nonce) return;
  update({ ...state, rebind: null });
}

/** The latest pending request, for non-React callers and tests. */
export function getRebindRequest(): RebindRequest | null {
  return liveRebind();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The latest pending rebind request (null when none is waiting). */
export function useRebindRequest(): RebindRequest | null {
  return useSyncExternalStore(subscribe, liveRebind, liveRebind);
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
  setSelectedCodeContext(null);
}
