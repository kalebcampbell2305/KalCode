/**
 * Live data for the Command Deck chrome (top bar, Account Usage Center): the Operations snapshot,
 * provider health and the active workspace's Git summary. Each is a cheap native read, refreshed
 * while the window is visible, on window focus and after the events that change it. A failed read keeps the last good value and reports the error; nothing is
 * invented to fill a gap.
 */
import type { GitStatusSummary, OperationsSnapshot, ProviderHealth } from "@kalcode/protocol";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { OperationsClient } from "../../ipc/operations.ts";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useThrottledValue } from "../../runtime/useThrottledValue.ts";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";

export interface Feed<T> {
  data: T | null;
  /** The last read failed (the previous value, if any, is still shown). */
  failed: boolean;
}

export interface DeckDataValue {
  operations: Feed<OperationsSnapshot>;
  health: Feed<ProviderHealth[]>;
  /** `null` data with `failed: false` once loaded means the folder isn't a Git repository. */
  git: Feed<GitStatusSummary> & { loaded: boolean };
}

/** Operations snapshots read event history; the deck doesn't need the page's 3 s cadence. */
const OPERATIONS_MS = 10_000;
const HEALTH_MS = 30_000;
const GIT_MS = 15_000;

const DeckDataContext = createContext<DeckDataValue | null>(null);

/** Payloads are small; a repeat answer keeps the previous object so nothing re-renders for it. */
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** An Operations snapshot's `observedAt` moves on every read; the deck never shows it. */
const sameOperations = (a: OperationsSnapshot | null, b: OperationsSnapshot | null) =>
  sameJson(a && { ...a, observedAt: "" }, b && { ...b, observedAt: "" });

/**
 * Calls `load` now, every `intervalMs` while the document is visible, when the window regains
 * focus and whenever `trigger` changes. Results from a superseded call are dropped, and a result
 * `same` as the one shown keeps the current feed object (no re-render for an unchanged answer).
 */
function usePolled<T>(
  load: (() => Promise<T>) | null,
  intervalMs: number,
  trigger: unknown,
  same: (a: T | null, b: T | null) => boolean = sameJson,
): Feed<T> & { at: number } {
  const [feed, setFeed] = useState<Feed<T> & { at: number }>({ data: null, failed: false, at: 0 });
  const generation = useRef(0);
  const lastLoad = useRef(load);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `trigger` is a refresh signal.
  useEffect(() => {
    const mine = ++generation.current;
    // A different source (another workspace) never shows the previous source's value.
    if (lastLoad.current !== load) {
      lastLoad.current = load;
      setFeed({ data: null, failed: false, at: 0 });
    }
    if (!load) return;
    let disposed = false;
    const read = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      load().then(
        (data) => {
          if (disposed || mine !== generation.current) return;
          setFeed((prev) =>
            prev.at > 0 && !prev.failed && same(prev.data, data) ? prev : { data, failed: false, at: Date.now() },
          );
        },
        () => {
          if (disposed || mine !== generation.current) return;
          setFeed((prev) => (prev.at > 0 && prev.failed ? prev : { ...prev, failed: true, at: Date.now() }));
        },
      );
    };
    read();
    const timer = setInterval(read, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", read);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", read);
    };
  }, [load, intervalMs, trigger, same]);

  return feed;
}

export function DeckDataProvider({ children }: { children: ReactNode }) {
  const { client } = useRuntime();
  const { events } = useEvents();
  const { active } = useWorkspaces();
  const activeId = active?.id ?? null;

  const operationsClient = useMemo(
    () => new OperationsClient((command, args) => client.transport.invoke(command, args)),
    [client],
  );
  const loadOperations = useMemo(() => () => operationsClient.snapshot(), [operationsClient]);
  const loadHealth = useMemo(() => () => client.listProviderHealth(), [client]);
  const loadGit = useMemo(
    () => (activeId ? () => client.gitStatus(activeId, 1).then((r) => (r.repository ? r.summary : null)) : null),
    [client, activeId],
  );

  // The newest event of each family re-reads its feed.
  const latest = (prefix: string) => events.find((e) => e.type.startsWith(prefix))?.seq ?? 0;
  // A burst of events re-reads each feed once or twice, not once per event.
  const providerSeq = useThrottledValue(latest("provider."));
  const gitSeq = useThrottledValue(latest("git."));
  const operationSeq = useThrottledValue(latest("operation."));

  const operations = usePolled(loadOperations, OPERATIONS_MS, operationSeq, sameOperations);
  const health = usePolled(loadHealth, HEALTH_MS, providerSeq);
  const git = usePolled(loadGit, GIT_MS, gitSeq);
  const gitLoaded = git.at > 0;

  const value = useMemo<DeckDataValue>(
    () => ({
      operations: { data: operations.data, failed: operations.failed },
      health: { data: health.data, failed: health.failed },
      git: { data: git.data, failed: git.failed, loaded: gitLoaded },
    }),
    [operations.data, operations.failed, health.data, health.failed, git.data, git.failed, gitLoaded],
  );
  return <DeckDataContext.Provider value={value}>{children}</DeckDataContext.Provider>;
}

export function useDeckData(): DeckDataValue {
  const value = useContext(DeckDataContext);
  if (!value) throw new Error("useDeckData must be used inside <DeckDataProvider>");
  return value;
}

/** Deck data when a DeckDataProvider is mounted (panes rendered in isolation have none). */
export function useOptionalDeckData(): DeckDataValue | null {
  return useContext(DeckDataContext);
}
