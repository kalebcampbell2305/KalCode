import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Destination } from "./navigation.tsx";
import {
  initialHistory,
  type NavigationEntry,
  type NavigationHistory,
  type NavigationLocation,
  readNavigationHistory,
  visitLocation,
  writeNavigationHistory,
} from "./navigationHistory.ts";

export type NavigationRestorer = (
  entry: NavigationEntry,
  isCurrent: () => boolean,
) => boolean | undefined | Promise<boolean | undefined>;
const paint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function loadHistory(
  initial: Destination,
  visible: ReadonlySet<Destination>,
  storageKey: string | undefined,
): { state: NavigationHistory; previousSessionLocation: NavigationEntry | null } {
  const storage = storageKey ? browserStorage() : null;
  const restored = storage && storageKey ? readNavigationHistory(storage, storageKey, visible) : null;
  const previousSessionLocation = restored?.entries[restored.index] ?? null;
  return {
    state: restored ?? initialHistory(initial),
    previousSessionLocation,
  };
}

export function useNavigationHistory(initial: Destination, visible: ReadonlySet<Destination>, storageKey?: string) {
  const loaded = useRef<ReturnType<typeof loadHistory> | null>(null);
  if (loaded.current === null) loaded.current = loadHistory(initial, visible, storageKey);
  const [state, setState] = useState(() => loaded.current?.state ?? initialHistory(initial));
  const [previousSessionLocation, setPreviousSessionLocation] = useState<NavigationEntry | null>(
    () => loaded.current?.previousSessionLocation ?? null,
  );
  const live = useRef(state);
  const [current, setCurrent] = useState(initial);
  const loadedStorageKey = useRef(storageKey);
  const skipPersistence = useRef(false);
  const generation = useRef(0);
  const replaying = useRef(false);
  const requestedIndex = useRef<number | null>(null);
  const intentRevision = useRef(0);
  const restorers = useRef({ prepare: new Set<NavigationRestorer>(), focus: new Set<NavigationRestorer>() });
  const focused = useRef(new Map<number, HTMLElement>());
  const apply = useCallback((next: NavigationHistory) => {
    live.current = next;
    setState(next);
  }, []);
  const capture = useCallback(() => {
    const element = document.activeElement;
    const entry = live.current.entries[live.current.index];
    if (entry && element instanceof HTMLElement && element.closest("#main")) focused.current.set(entry.id, element);
    const kept = new Set(live.current.entries.map((item) => item.id));
    for (const id of focused.current.keys()) if (!kept.has(id)) focused.current.delete(id);
  }, []);
  const recordLocation = useCallback(
    (location: NavigationLocation) => {
      if (replaying.current || !visible.has(location.destination)) return;
      requestedIndex.current = null;
      capture();
      apply(visitLocation(live.current, location));
    },
    [apply, capture, visible],
  );
  const navigate = useCallback(
    (destination: Destination) => {
      if (!visible.has(destination)) return;
      intentRevision.current += 1;
      generation.current += 1;
      replaying.current = false;
      requestedIndex.current = null;
      capture();
      const entry = live.current.entries[live.current.index];
      // Clicking the current surface is a focus intent, not a duplicate visit.
      if (entry?.destination !== destination) apply(visitLocation(live.current, { destination }));
      setCurrent(destination);
    },
    [apply, capture, visible],
  );
  const registerRestorer = useCallback((handler: NavigationRestorer, phase: "prepare" | "focus" = "focus") => {
    restorers.current[phase].add(handler);
    return () => {
      restorers.current[phase].delete(handler);
    };
  }, []);

  const move = useCallback(
    async (index: number, direction: -1 | 1) => {
      if (index < 0 || index >= live.current.entries.length) return;
      capture();
      const origin = live.current.index;
      const originEntry = live.current.entries[origin];
      const revision = ++generation.current;
      intentRevision.current += 1;
      const isCurrent = () => generation.current === revision;
      replaying.current = true;
      requestedIndex.current = index;
      try {
        for (let next = index; next >= 0 && next < live.current.entries.length; next += direction) {
          const entry = live.current.entries[next];
          if (!entry || !visible.has(entry.destination)) continue;
          let valid = true;
          for (const handler of restorers.current.prepare) {
            try {
              if ((await handler(entry, isCurrent)) === false) valid = false;
            } catch {
              valid = false;
            }
            if (!isCurrent()) return;
          }
          if (!valid) continue;
          apply({ ...live.current, index: next });
          setCurrent(entry.destination);
          await paint();
          if (!isCurrent()) return;
          let handled = false;
          // A surface can still be mounting its handler or loading its pane layout. Give
          // it a bounded chance to register; never recreate a closed pane for history.
          for (let attempt = 0; attempt < 30; attempt += 1) {
            for (const handler of restorers.current.focus) {
              let result: boolean | undefined;
              try {
                result = await handler(entry, isCurrent);
              } catch {
                result = false;
              }
              if (!isCurrent()) return;
              if (result !== undefined) {
                valid = result;
                handled = true;
                break;
              }
            }
            if (handled || !entry.target) break;
            await paint();
            if (!isCurrent()) return;
          }
          if (!valid || (entry.target && !handled)) continue;
          await paint();
          if (!isCurrent()) return;
          const element = focused.current.get(entry.id);
          if (entry.target?.kind !== "pane" && element?.isConnected && !element.closest("[hidden], [inert]"))
            element.focus({ preventScroll: true });
          return;
        }
        // Every candidate was closed. Keep the original location instead of stranding the
        // cursor on the last invalid target that was inspected.
        if (isCurrent() && originEntry) {
          for (const handler of restorers.current.prepare) {
            try {
              await handler(originEntry, isCurrent);
            } catch {
              /* A removed origin still keeps its surface. */
            }
            if (!isCurrent()) return;
          }
          apply({ ...live.current, index: origin });
          setCurrent(originEntry.destination);
          await paint();
          if (!isCurrent()) return;
          for (const handler of restorers.current.focus) {
            let handled: boolean | undefined;
            try {
              handled = await handler(originEntry, isCurrent);
            } catch {
              handled = false;
            }
            if (!isCurrent()) return;
            if (handled !== undefined) break;
          }
        }
      } finally {
        if (isCurrent()) {
          replaying.current = false;
          requestedIndex.current = null;
        }
      }
    },
    [apply, capture, visible],
  );
  const back = useCallback(() => move((requestedIndex.current ?? live.current.index) - 1, -1), [move]);
  const forward = useCallback(() => move((requestedIndex.current ?? live.current.index) + 1, 1), [move]);
  const restore = useCallback(
    (id: number) => {
      const index = live.current.entries.findIndex((entry) => entry.id === id);
      return index < 0 ? Promise.resolve() : move(index, index < live.current.index ? -1 : 1);
    },
    [move],
  );
  const getIntentRevision = useCallback(() => intentRevision.current, []);
  useEffect(() => {
    const interrupt = () => {
      if (!replaying.current) return;
      generation.current += 1;
      replaying.current = false;
    };
    document.addEventListener("pointerdown", interrupt, true);
    document.addEventListener("keydown", interrupt, true);
    // Remember content focus before a sidebar, palette or Back button takes it.
    document.addEventListener("focusin", capture, true);
    return () => {
      document.removeEventListener("pointerdown", interrupt, true);
      document.removeEventListener("keydown", interrupt, true);
      document.removeEventListener("focusin", capture, true);
    };
  }, [capture]);
  useEffect(() => {
    if (storageKey === loadedStorageKey.current) return;
    generation.current += 1;
    replaying.current = false;
    requestedIndex.current = null;
    focused.current.clear();
    const next = loadHistory(initial, visible, storageKey);
    loadedStorageKey.current = storageKey;
    skipPersistence.current = true;
    live.current = next.state;
    setState(next.state);
    setCurrent(initial);
    setPreviousSessionLocation(next.previousSessionLocation);
  }, [initial, storageKey, visible]);
  useEffect(() => {
    if (!storageKey || loadedStorageKey.current !== storageKey) return;
    if (skipPersistence.current) {
      skipPersistence.current = false;
      return;
    }
    const storage = browserStorage();
    if (storage) writeNavigationHistory(storage, storageKey, state, visible);
  }, [state, storageKey, visible]);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  return useMemo(
    () => ({
      current,
      navigate,
      getIntentRevision,
      recordLocation,
      registerRestorer,
      back,
      forward,
      restore,
      previousSessionLocation,
      history: state.entries,
      historyIndex: state.index,
      canGoBack: state.index > 0,
      canGoForward: state.index < state.entries.length - 1,
    }),
    [
      current,
      navigate,
      getIntentRevision,
      recordLocation,
      registerRestorer,
      back,
      forward,
      restore,
      previousSessionLocation,
      state,
    ],
  );
}
