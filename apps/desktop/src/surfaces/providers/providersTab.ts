import { useSyncExternalStore } from "react";

/** The Providers surface's views. */
export type ProvidersTab = "setup" | "health";

/**
 * A request to show one Providers tab (the Dashboard's "Health details"). A tiny store rather
 * than a route: the request is read when the Providers page mounts, and followed while it is
 * already open.
 */
let requested: { tab: ProvidersTab; nonce: number } | null = null;
let nextNonce = 1;
const listeners = new Set<() => void>();

export function requestProvidersTab(tab: ProvidersTab): void {
  requested = { tab, nonce: nextNonce++ };
  for (const listener of listeners) listener();
}

/** Marks a request handled, so a later plain visit opens the default tab. */
export function consumeProvidersTab(nonce: number): void {
  if (requested?.nonce !== nonce) return;
  requested = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The latest tab request (null until one is made). */
export function useProvidersTabRequest(): { tab: ProvidersTab; nonce: number } | null {
  return useSyncExternalStore(
    subscribe,
    () => requested,
    () => requested,
  );
}
