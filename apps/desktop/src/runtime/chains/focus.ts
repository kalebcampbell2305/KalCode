/**
 * Which chain Activity should bring into view. Needs You, the command palette and a step's pane
 * chip call `focusChain(id)`; the Chains section reads `useFocusedChain()` and scrolls/highlights
 * that chain, then calls `clearFocusedChain()`. A per-session intent; nothing is persisted.
 */
import { useSyncExternalStore } from "react";

export interface ChainFocus {
  chainId: string;
  /** Increases on every request, so asking for the same chain twice still re-focuses it. */
  nonce: number;
}

let current: ChainFocus | null = null;
let counter = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function focusChain(chainId: string): void {
  counter += 1;
  current = { chainId, nonce: counter };
  emit();
}

export function clearFocusedChain(): void {
  if (current === null) return;
  current = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFocusedChain(): ChainFocus | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
