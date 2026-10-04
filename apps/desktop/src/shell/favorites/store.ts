import { useSyncExternalStore } from "react";
import {
  type FavoriteEntry,
  type FavoriteTarget,
  favoriteKey,
  hydrateFavorites,
  INVALID_BROWSER_FAVORITE,
  normalizeFavorite,
} from "./model.ts";

export const FAVORITES_STORAGE_KEY = "kalcode:favorites:v1";
interface Snapshot {
  entries: readonly FavoriteEntry[];
  error: string | null;
}
type StorageAccess = () => Pick<Storage, "getItem" | "setItem">;

/** One synchronous authority shared by pins, menus and workspace favorites. */
export function createFavoritesStore(
  storage: StorageAccess,
  events?: Pick<Window, "addEventListener" | "removeEventListener">,
) {
  let snapshot: Snapshot = { entries: [], error: null };
  let loaded = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const read = (): FavoriteEntry[] | null => {
    try {
      return hydrateFavorites(storage().getItem(FAVORITES_STORAGE_KEY));
    } catch {
      snapshot = { ...snapshot, error: "Favorites couldn't be read. Reload the app to try again." };
      return null;
    }
  };
  const refresh = () => {
    loaded = true;
    const entries = read();
    if (entries !== null) {
      if (JSON.stringify(entries) === JSON.stringify(snapshot.entries) && snapshot.error === null) return;
      snapshot = { entries, error: null };
    }
    notify();
  };
  const onStorage = (event: Event) => {
    const key = (event as StorageEvent).key;
    if (key === null || key === FAVORITES_STORAGE_KEY) refresh();
  };
  const save = (change: (entries: FavoriteEntry[]) => FavoriteEntry[]): boolean => {
    loaded = true;
    // Read again before a mutation so another window's most recent order is retained.
    const entries = read();
    if (entries === null) {
      notify();
      return false;
    }
    const next = change(entries);
    try {
      if (next.length > 1000) throw new Error("Favorites limit reached.");
      const serialized = JSON.stringify({ version: 1, entries: next });
      if (serialized.length > 1_048_576) throw new Error("Favorites storage limit reached.");
      storage().setItem(FAVORITES_STORAGE_KEY, serialized);
      snapshot = { entries: next, error: null };
      notify();
      return true;
    } catch {
      snapshot = { entries, error: "Favorites weren't saved. Free some app storage and try again." };
      notify();
      return false;
    }
  };
  return {
    getSnapshot: (): Snapshot => {
      if (!loaded) {
        loaded = true;
        const entries = read();
        if (entries !== null) snapshot = { entries, error: null };
      }
      return snapshot;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        events?.addEventListener("storage", onStorage);
        refresh();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) events?.removeEventListener("storage", onStorage);
      };
    },
    toggle: (target: FavoriteTarget, title: string, scopeId: string | null): boolean => {
      if (!loaded) {
        loaded = true;
        const entries = read();
        if (entries !== null) snapshot = { entries, error: null };
      }
      const entry = normalizeFavorite({ target, title, scopeId });
      if (!entry) {
        snapshot = {
          ...snapshot,
          error:
            target.kind === "browser"
              ? INVALID_BROWSER_FAVORITE
              : "This destination can't be saved. Choose a current destination with a name and a relative file path.",
        };
        notify();
        return false;
      }
      return save((entries) =>
        entries.some((item) => item.key === entry.key)
          ? entries.filter((item) => item.key !== entry.key)
          : [...entries, entry],
      );
    },
    remove: (key: string): boolean => save((entries) => entries.filter((entry) => entry.key !== key)),
    move: (key: string, beforeKey: string | null): boolean =>
      save((entries) => {
        const entry = entries.find((item) => item.key === key);
        if (!entry || key === beforeKey) return entries;
        const before = beforeKey === null ? null : entries.find((item) => item.key === beforeKey);
        if (beforeKey !== null && (!before || before.scopeId !== entry.scopeId)) return entries;
        const next = entries.filter((item) => item.key !== key);
        next.splice(before === null ? next.length : next.findIndex((item) => item.key === before?.key), 0, entry);
        return next;
      }),
  };
}

let shared: ReturnType<typeof createFavoritesStore> | undefined;
function sharedStore() {
  shared ??= createFavoritesStore(() => localStorage, typeof window === "undefined" ? undefined : window);
  return shared;
}

export function useFavorites() {
  const store = sharedStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return {
    ...snapshot,
    toggle: store.toggle,
    remove: store.remove,
    move: store.move,
    has: (target: FavoriteTarget, scopeId: string | null) => {
      const entry = normalizeFavorite({ target, title: target.id.slice(0, 256), scopeId });
      return !!entry && snapshot.entries.some((item) => item.key === favoriteKey(entry.target, scopeId));
    },
  };
}
