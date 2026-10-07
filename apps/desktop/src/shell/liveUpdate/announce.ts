import type { LiveUpdated } from "../../ipc/liveUpdate.ts";

/**
 * Hands the "KalCode updated" result from the app-level ready report (App.tsx) to the Shell's
 * host, which can show a toast. The ready report may resolve before or after the Shell mounts,
 * so the announcement is buffered until someone takes it, and delivered once.
 */
let buffered: LiveUpdated | null = null;
const listeners = new Set<(updated: LiveUpdated) => void>();

export function publishUpdated(updated: LiveUpdated): void {
  const [first] = listeners;
  if (first) first(updated);
  else buffered = updated;
}

export function subscribeUpdated(listener: (updated: LiveUpdated) => void): () => void {
  if (buffered) {
    const pending = buffered;
    buffered = null;
    listener(pending);
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test helper. */
export function resetAnnouncements(): void {
  buffered = null;
  listeners.clear();
}
