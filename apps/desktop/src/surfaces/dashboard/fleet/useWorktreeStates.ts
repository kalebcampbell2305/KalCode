import type { ThreadSummary, ThreadWorktreeState } from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEvents, useRuntime } from "../../../runtime/RuntimeProvider.tsx";

/** Git facts change with commits and edits; a fleet card doesn't need them faster than this. */
const POLL_MS = 10_000;
/** Bursts of file events (an agent editing) collapse into one read after this quiet period. */
const EVENT_DEBOUNCE_MS = 1_500;
/** The native command reads at most this many threads per call. */
const MAX_IDS = 64;
/** Git reads are heavy; large Squads use a small pool rather than one process burst per chunk. */
const READ_CONCURRENCY = 2;

export interface WorktreeStateGeneration {
  states: ThreadWorktreeState[];
  /** Native omitted at least one requested agent, so ownership coverage is not complete. */
  incomplete: boolean;
}

/**
 * Reads every agent through the native command's bounded contract. Results become visible only
 * after every chunk succeeds, so Needs You never compares paths from mixed read generations.
 */
export async function readWorktreeStateGeneration(
  read: (threadIds: string[]) => Promise<ThreadWorktreeState[]>,
  threadIds: readonly string[],
): Promise<WorktreeStateGeneration> {
  const chunks: string[][] = [];
  for (let index = 0; index < threadIds.length; index += MAX_IDS) {
    chunks.push(threadIds.slice(index, index + MAX_IDS));
  }
  const results = new Array<ThreadWorktreeState[]>(chunks.length);
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (failure === null && next < chunks.length) {
      const index = next;
      next += 1;
      const chunk = chunks[index];
      if (!chunk) continue;
      try {
        results[index] = await read(chunk);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, chunks.length) }, worker));
  if (failure !== null) throw failure;
  const states = results.flat();
  const returned = new Set(states.map((state) => state.threadId));
  return { states, incomplete: threadIds.some((id) => !returned.has(id)) };
}

/**
 * Worktree facts (ahead/behind, dirty, would-conflict) for the agents that run in their own
 * worktree, keyed by thread id. Read every 10 s while the window is visible and shortly after
 * thread, file and Git events settle. Only one read is in flight at a time (each one runs Git in
 * every worktree). A failed read keeps the last facts rather than inventing new ones.
 */
export interface WorktreeStates {
  states: Map<string, ThreadWorktreeState>;
  /** The current agent set has either been read or failed explicitly. */
  ready: boolean;
  /** The latest read failed; `states` remains the last known snapshot. */
  failed: boolean;
  /** Some agents or changed paths were omitted by a native read. */
  incomplete: boolean;
  /** Re-read now (Needs You and the Fleet share this same reader). */
  reload: () => void;
  /** Applies facts the caller just observed (e.g. after a commit) without waiting for a read. */
  apply: (state: ThreadWorktreeState) => void;
}

/** A read's `observedAt` moves every time; the cards never show it. */
function sameFacts(a: ThreadWorktreeState, b: ThreadWorktreeState): boolean {
  return JSON.stringify({ ...a, observedAt: "" }) === JSON.stringify({ ...b, observedAt: "" });
}

/**
 * The new read, keeping each unchanged agent's previous facts (and the map itself when nothing
 * changed), so a quiet 10 s read re-renders neither the board nor any card.
 */
export function keepUnchanged(
  current: Map<string, ThreadWorktreeState>,
  list: readonly ThreadWorktreeState[],
): Map<string, ThreadWorktreeState> {
  let changed = current.size !== list.length;
  const next = new Map<string, ThreadWorktreeState>();
  for (const state of list) {
    const before = current.get(state.threadId);
    const same = before !== undefined && sameFacts(before, state);
    next.set(state.threadId, same ? before : state);
    if (!same) changed = true;
  }
  return changed ? next : current;
}

export function useWorktreeStates(threads: readonly ThreadSummary[] | null): WorktreeStates {
  const { client } = useRuntime();
  const { events } = useEvents();
  const ids = useMemo(() => (threads ?? []).filter((t) => t.worktreeId).map((t) => t.id), [threads]);
  const key = ids.join(",");
  const trigger = events.find((e) => /^(thread\.|file\.|git\.)/.test(e.type))?.seq ?? 0;
  const [states, setStates] = useState<Map<string, ThreadWorktreeState>>(() => new Map());
  const [readState, setReadState] = useState({ key: "", ready: false, failed: false, incomplete: false });
  // The reader for the current set of ids; events ask it for a (debounced) read.
  const reader = useRef<{ request: () => void; reload: () => void } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `ids`.
  useEffect(() => {
    if (ids.length === 0) {
      setStates(new Map());
      setReadState({ key, ready: true, failed: false, incomplete: false });
      reader.current = null;
      return;
    }
    let disposed = false;
    let inFlight = false;
    let again = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      if (disposed || document.visibilityState === "hidden") return;
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      readWorktreeStateGeneration((chunk) => client.threadWorktreeStates(chunk), ids)
        .then(
          (generation) => {
            if (!disposed) {
              setStates((current) => keepUnchanged(current, generation.states));
              setReadState({ key, ready: true, failed: false, incomplete: generation.incomplete });
            }
          },
          () => {
            if (!disposed) {
              setReadState((current) => ({
                key,
                ready: true,
                failed: true,
                incomplete: current.key === key ? current.incomplete : false,
              }));
            }
          },
        )
        .finally(() => {
          inFlight = false;
          if (again && !disposed) {
            again = false;
            read();
          }
        });
    };
    reader.current = {
      request: () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(read, EVENT_DEBOUNCE_MS);
      },
      reload: read,
    };
    read();
    const timer = setInterval(read, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
      if (debounce) clearTimeout(debounce);
    };
  }, [client, key]);

  useEffect(() => {
    if (trigger > 0) reader.current?.request();
  }, [trigger]);

  const apply = useCallback(
    (state: ThreadWorktreeState) => setStates((current) => new Map(current).set(state.threadId, state)),
    [],
  );
  const reload = useCallback(() => reader.current?.reload(), []);
  const currentRead = readState.key === key ? readState : { ready: ids.length === 0, failed: false, incomplete: false };
  const incomplete = currentRead.incomplete || [...states.values()].some((state) => state.changedPathsTruncated);
  return useMemo(
    () => ({ states, ready: currentRead.ready, failed: currentRead.failed, incomplete, reload, apply }),
    [states, currentRead.ready, currentRead.failed, incomplete, reload, apply],
  );
}
