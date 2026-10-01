import { useSyncExternalStore } from "react";
import { accountFullLabel } from "../surfaces/providers/accountIdentity.ts";
import { forgetVoiceText } from "./voiceSpans.ts";

/**
 * Thread composers as fixed KalVoice targets (0.1.5 TK-2). Each thread's message box registers a
 * handle keyed by its thread id; dictation and the composer directives (`submit_composer`,
 * `clear_composer`, `compose_in_thread`) find a composer only through this registry, never by a
 * shared DOM id, so words and sends can't land in a different thread after a navigation.
 * Holds ids, names and callbacks only; never the text itself.
 */

/** What the composer's own Send does now (mirrors `threadActions(...).compose`). */
export type ComposerMode = "send" | "resume" | "blocked";

/** Shown and spoken names only; read fresh because a thread can be renamed or rebound. */
export interface ComposerIdentity {
  threadId: string;
  threadName: string;
  providerId: string;
  providerName: string;
  /** The thread's provider-account label ("Gemini B"); null for threads without one. */
  accountLabel: string | null;
}

/** What the composer's own Send did for a voice request. */
export type ComposerSubmitOutcome =
  /** The message was sent (prompt review passed). */
  | "sent"
  /** The prompt warning dialog is open: only the person can confirm it. */
  | "confirm"
  /** Send ran and failed; the composer already said why. */
  | "not_sent"
  /** A send is already in progress. */
  | "busy"
  /** Nothing to send. */
  | "empty"
  /** The composer can't send right now (see `blockedReason`). */
  | "blocked";

export interface ComposerHandle {
  readonly threadId: string;
  identity(): ComposerIdentity;
  /** The composer's text box while it is mounted. */
  element(): HTMLTextAreaElement | null;
  mode(): ComposerMode;
  /** The composer's own words for why it can't send (blocked mode), or null. */
  blockedReason(): string | null;
  /** Whether the box has text the person hasn't sent. */
  hasText(): boolean;
  /** Runs the composer's own Send: prompt review and the warning dialog apply unchanged. */
  submit(): Promise<ComposerSubmitOutcome>;
}

export interface ComposerRegistration {
  readonly handle: ComposerHandle;
  /** Distinguishes a remounted composer of the same thread from the one captured earlier. */
  readonly generation: number;
}

const byThread = new Map<string, ComposerRegistration>();
let nextGeneration = 1;
/** The thread whose composer the active push-to-talk session targets (for the hint). */
let listeningThread: string | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Registers a thread's composer. The newest registration for a thread wins; returns unregister. */
export function registerComposer(handle: ComposerHandle): () => void {
  const registration: ComposerRegistration = { handle, generation: nextGeneration++ };
  // A newly mounted box starts empty: nothing KalVoice typed earlier is in it.
  forgetVoiceText(handle.threadId);
  byThread.set(handle.threadId, registration);
  changed();
  return () => {
    if (byThread.get(handle.threadId) !== registration) return;
    byThread.delete(handle.threadId);
    forgetVoiceText(handle.threadId);
    changed();
  };
}

/** The mounted composer of `threadId`, or null. */
export function composerForThread(threadId: string): ComposerRegistration | null {
  return byThread.get(threadId) ?? null;
}

/** The registered composer whose text box is `element`, or null. */
export function composerForElement(element: Element | null): ComposerRegistration | null {
  if (!element) return null;
  for (const registration of byThread.values()) {
    if (registration.handle.element() === element) return registration;
  }
  return null;
}

/** Whether `registration` is still its thread's mounted composer (not replaced or unmounted). */
export function isCurrentComposer(registration: ComposerRegistration): boolean {
  return byThread.get(registration.handle.threadId) === registration;
}

/**
 * Resolves with the composer of `threadId` once it is mounted (after a navigation), or null
 * after `timeoutMs` or when `signal` aborts.
 */
export function waitForComposer(
  threadId: string,
  { timeoutMs = 3000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ComposerRegistration | null> {
  const ready = () => {
    const found = byThread.get(threadId);
    return found?.handle.element()?.isConnected ? found : null;
  };
  const now = ready();
  if (now || signal?.aborted) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: ComposerRegistration | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const check = () => {
      const found = ready();
      if (found) finish(found);
    };
    const onAbort = () => finish(null);
    // Registry changes come in bursts within one commit (a remount unregisters and registers
    // again), so look after the burst: the registration handed out is the one that stays.
    const unsubscribe = subscribe(() => queueMicrotask(check));
    // The element ref attaches in the same commit as the registration effect; re-check shortly.
    const poll = setInterval(check, 25);
    const timer = setTimeout(() => finish(ready()), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * "KALVOICE TARGET · Authentication · Claude Code · Work": thread, then provider and account named as
 * everywhere else (the account only when the thread has one).
 */
export function voiceTargetLabel(identity: ComposerIdentity): string {
  const account = identity.accountLabel?.trim();
  const runtime = account
    ? accountFullLabel({ providerId: identity.providerId, displayName: account })
    : identity.providerName;
  return `KALVOICE TARGET · ${identity.threadName} · ${runtime}`;
}

/** Called by KalVoice while a push-to-talk session targets a composer (null when none does). */
export function setListeningComposer(threadId: string | null): void {
  if (listeningThread === threadId) return;
  listeningThread = threadId;
  changed();
}

/** Whether the active push-to-talk session targets `threadId`'s composer. */
export function useComposerListening(threadId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => listeningThread === threadId,
    () => listeningThread === threadId,
  );
}

/** Test-only: forget every registration. */
export function resetComposerRegistryForTests(): void {
  byThread.clear();
  listeningThread = null;
  changed();
}
