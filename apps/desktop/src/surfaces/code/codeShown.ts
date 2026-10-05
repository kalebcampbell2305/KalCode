import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * Whether the Code surface is on screen, delivered straight to the terminal views that act on it.
 * Code stays mounted while hidden; passing the flag as a prop re-rendered every pane (header,
 * menus, usage badges) on each tab switch, so only the terminals subscribe here.
 */
export interface ShownStore {
  get(): boolean;
  set(shown: boolean): void;
  subscribe(listener: () => void): () => void;
}

export function createShownStore(initial: boolean): ShownStore {
  let shown = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => shown,
    set(next) {
      if (next === shown) return;
      shown = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const ALWAYS_SHOWN: ShownStore = { get: () => true, set: () => undefined, subscribe: () => () => undefined };

export const CodeShownContext = createContext<ShownStore>(ALWAYS_SHOWN);

/** True while the Code surface is shown (always true outside Code). */
export function useCodeShown(): boolean {
  const store = useContext(CodeShownContext);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
