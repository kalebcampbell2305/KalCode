import { useCallback, useSyncExternalStore } from "react";
import { useOptionalAccount } from "../account/AccountProvider.tsx";

const listeners = new Set<() => void>();
const requests = new Map<string, number>();
const keyFor = (owner: string) => `kalcode:desk-restore:v1:${owner}`;
function automatic(owner: string): boolean {
  try {
    return localStorage.getItem(keyFor(owner)) !== "manual";
  } catch {
    return true;
  }
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
};

/** Noncredential preference; existing native layout and session stores remain authoritative. */
export function useDeskRestore(workspaceId?: string) {
  const owner = useOptionalAccount()?.snapshot.account?.id ?? "local";
  const requestKey = `${owner}:${workspaceId ?? ""}`;
  const enabled = useSyncExternalStore(subscribe, () => automatic(owner));
  const request = useSyncExternalStore(subscribe, () => requests.get(requestKey) ?? 0);
  const setAutomatic = useCallback(
    (value: boolean) => {
      try {
        localStorage.setItem(keyFor(owner), value ? "automatic" : "manual");
      } catch {
        return false;
      }
      for (const listener of listeners) listener();
      return true;
    },
    [owner],
  );
  const continueDesk = useCallback(() => {
    requests.set(requestKey, (requests.get(requestKey) ?? 0) + 1);
    for (const listener of listeners) listener();
  }, [requestKey]);
  return { automatic: enabled, setAutomatic, continueDesk, request };
}
