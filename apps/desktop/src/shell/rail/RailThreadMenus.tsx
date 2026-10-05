import type { ThreadSummary } from "@kalcode/protocol";
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { CodingAgentContextMenu } from "../../surfaces/code/CodingAgentContextMenu.tsx";
import { isCodingAgent } from "../../surfaces/dashboard/data/agents.ts";
import { useOptionalAllThreads } from "../../surfaces/dashboard/data/DashboardData.tsx";
import { ThreadContextMenu, ThreadMenuDataProvider } from "../../surfaces/threads/ThreadContextMenu.tsx";
import { FavoriteButton } from "../favorites/FavoriteActions.tsx";
import { useRail } from "./RailProvider.tsx";

const EMPTY: ReadonlyMap<string, ThreadSummary> = new Map();
const Summaries = createContext<ReadonlyMap<string, ThreadSummary>>(EMPTY);

export function RailThreadFavoriteButton({ id }: { id: string }) {
  const thread = useContext(Summaries).get(id);
  return thread ? (
    <FavoriteButton
      target={{ kind: isCodingAgent(thread) ? "agent" : "thread", id, workspaceId: thread.workspaceId }}
      title={thread.name}
    />
  ) : null;
}

/** Coalesces a burst of thread events (a busy agent emits several) into one read. */
const REFRESH_DEBOUNCE_MS = 120;

/**
 * The summaries by id, keeping unchanged records (and the map itself when nothing changed), so a
 * quiet thread event re-renders no rail row.
 */
function mergeSummaries(
  previous: ReadonlyMap<string, ThreadSummary>,
  threads: readonly ThreadSummary[],
): ReadonlyMap<string, ThreadSummary> {
  let changed = previous.size !== threads.length;
  const next = new Map<string, ThreadSummary>();
  for (const thread of threads) {
    const before = previous.get(thread.id);
    const same = before !== undefined && (before === thread || JSON.stringify(before) === JSON.stringify(thread));
    if (!same) changed = true;
    next.set(thread.id, same ? before : thread);
  }
  return changed ? next : previous;
}

/**
 * Rail projections omit account/runtime identity; read authoritative records once for the tree.
 * The Shell's shared thread list (Dashboard data) is reused when mounted; otherwise the list is
 * read here, once per burst of thread events.
 */
export function RailThreadMenus({ children }: { children: ReactNode }) {
  const shared = useOptionalAllThreads();
  const own = useOwnSummaries(shared === undefined);
  const merged = useRef<ReadonlyMap<string, ThreadSummary>>(EMPTY);
  if (shared !== undefined) merged.current = shared ? mergeSummaries(merged.current, shared) : EMPTY;
  return (
    <Summaries.Provider value={shared === undefined ? own : merged.current}>
      <ThreadMenuDataProvider>{children}</ThreadMenuDataProvider>
    </Summaries.Provider>
  );
}

/** The list read here, when no shared list is mounted. */
function useOwnSummaries(enabled: boolean): ReadonlyMap<string, ThreadSummary> {
  const { client } = useRuntime();
  const { events } = useEvents();
  const [snapshot, setSnapshot] = useState<{
    client: typeof client;
    threads: ReadonlyMap<string, ThreadSummary>;
  } | null>(null);
  const revision = events.find((event) => event.type.startsWith("thread."))?.seq;
  const loaded = useRef<typeof client | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a thread event invalidates this projection.
  useEffect(() => {
    if (!enabled) {
      loaded.current = null;
      return;
    }
    let current = true;
    const read = () =>
      void client
        .listThreads({ includeArchived: true })
        .then((threads) => {
          if (!current) return;
          setSnapshot((previous) => {
            const before = previous?.client === client ? previous.threads : EMPTY;
            const next = mergeSummaries(before, threads);
            return previous?.client === client && next === before ? previous : { client, threads: next };
          });
        })
        .catch(() => {
          if (current) setSnapshot(null);
        });
    // The first read for a client runs at once; event-driven reads are coalesced.
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (loaded.current !== client) {
      loaded.current = client;
      read();
    } else timer = setTimeout(read, REFRESH_DEBOUNCE_MS);
    return () => {
      current = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, revision, enabled]);
  return enabled && snapshot?.client === client ? snapshot.threads : EMPTY;
}

export function RailThreadContextMenu({ id, children }: { id: string; children: ReactElement }) {
  const thread = useContext(Summaries).get(id);
  const rail = useRail();
  const { refresh, openThread } = rail;
  const onChanged = useCallback(() => void refresh(), [refresh]);
  const onDuplicated = useCallback((copy: ThreadSummary) => openThread(copy.id, copy.workspaceId), [openThread]);
  if (!thread) return children;
  if (isCodingAgent(thread))
    return (
      <CodingAgentContextMenu thread={thread} onChanged={onChanged}>
        {children}
      </CodingAgentContextMenu>
    );
  return (
    <ThreadContextMenu thread={thread} onChanged={onChanged} onDuplicated={onDuplicated}>
      {children}
    </ThreadContextMenu>
  );
}
