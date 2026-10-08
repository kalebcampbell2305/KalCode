import { useSyncExternalStore } from "react";

/**
 * "New handoff chain" from anywhere (command palette, Activity, KalVoice): a pending request the
 * Chains section on Activity answers by opening the composer. Per session; nothing is persisted.
 */
export interface ComposerRequest {
  nonce: number;
}

let pending: ComposerRequest | null = null;
let counter = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function requestChainComposer(): void {
  counter += 1;
  pending = { nonce: counter };
  emit();
}

/** Marks a request handled so revisiting Activity never reopens the composer. */
export function consumeChainComposer(nonce: number): void {
  if (pending?.nonce !== nonce) return;
  pending = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useChainComposerRequest(): ComposerRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => pending,
    () => null,
  );
}
