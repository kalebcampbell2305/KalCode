/**
 * Live data for the Command Deck chrome (top bar and status strip): the Operations snapshot,
 * provider health, the connected provider accounts and the active workspace's Git summary. Each is
 * a cheap native read, refreshed while the window is visible, on window focus and after the events
 * that change it. A failed read keeps the last good value and reports the error; nothing is
 * invented to fill a gap.
 */
import type { GitStatusSummary, OperationsSnapshot, ProviderAccount, ProviderHealth } from "@kalcode/protocol";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { OperationsClient } from "../../ipc/operations.ts";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";

export interface Feed<T> {
  data: T | null;
  /** The last read failed (the previous value, if any, is still shown). */
  failed: boolean;
}

export interface DeckDataValue {
  operations: Feed<OperationsSnapshot>;
  health: Feed<ProviderHealth[]>;
  /** Every provider account, removed ones included (the Provider Dock filters). */
  accounts: Feed<ProviderAccount[]>;
  /** `null` data with `failed: false` once loaded means the folder isn't a Git repository. */
  git: Feed<GitStatusSummary> & { loaded: boolean };
}

/** Operations snapshots read event history; the strip doesn't need the page's 3 s cadence. */
const OPERATIONS_MS = 10_000;
const HEALTH_MS = 30_000;
const ACCOUNTS_MS = 30_000;
const GIT_MS = 15_000;

const DeckDataContext = createContext<DeckDataValue | null>(null);

/**
 * Calls `load` now, every `intervalMs` while the document is visible, when the window regains
 * focus and whenever `trigger` changes. Results from a superseded call are dropped.
 */
function usePolled<T>(load: (() => Promise<T>) | null, intervalMs: number, trigger: unknown): Feed<T> & { at: number } {
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
          if (!disposed && mine === generation.current) setFeed({ data, failed: false, at: Date.now() });
        },
        () => {
          if (!disposed && mine === generation.current) setFeed((prev) => ({ ...prev, failed: true, at: Date.now() }));
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
  }, [load, intervalMs, trigger]);

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
  const loadAccounts = useMemo(() => () => client.listProviderAccounts(), [client]);
  const loadGit = useMemo(
    () => (activeId ? () => client.gitStatus(activeId, 1).then((r) => (r.repository ? r.summary : null)) : null),
    [client, activeId],
  );

  // The newest event of each family re-reads its feed.
  const latest = (prefix: string) => events.find((e) => e.type.startsWith(prefix))?.seq ?? 0;
  const providerSeq = latest("provider.");
  const gitSeq = latest("git.");
  const operationSeq = latest("operation.");

  const operations = usePolled(loadOperations, OPERATIONS_MS, operationSeq);
  const health = usePolled(loadHealth, HEALTH_MS, providerSeq);
  const accounts = usePolled(loadAccounts, ACCOUNTS_MS, providerSeq);
  const git = usePolled(loadGit, GIT_MS, gitSeq);

  const value = useMemo<DeckDataValue>(
    () => ({
      operations: { data: operations.data, failed: operations.failed },
      health: { data: health.data, failed: health.failed },
      accounts: { data: accounts.data, failed: accounts.failed },
      git: { data: git.data, failed: git.failed, loaded: git.at > 0 },
    }),
    [
      operations.data,
      operations.failed,
      health.data,
      health.failed,
      accounts.data,
      accounts.failed,
      git.data,
      git.failed,
      git.at,
    ],
  );
  return <DeckDataContext.Provider value={value}>{children}</DeckDataContext.Provider>;
}

export function useDeckData(): DeckDataValue {
  const value = useContext(DeckDataContext);
  if (!value) throw new Error("useDeckData must be used inside <DeckDataProvider>");
  return value;
}
