import type { ThreadSummary, ThreadWorktreeState } from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEvents, useRuntime } from "../../../runtime/RuntimeProvider.tsx";

/** Git facts change with commits and edits; a fleet card doesn't need them faster than this. */
const POLL_MS = 10_000;
/** Bursts of file events (an agent editing) collapse into one read after this quiet period. */
const EVENT_DEBOUNCE_MS = 1_500;
/** The native command reads at most this many threads per call. */
const MAX_IDS = 64;

/**
 * Worktree facts (ahead/behind, dirty, would-conflict) for the agents that run in their own
 * worktree, keyed by thread id. Read every 10 s while the window is visible and shortly after
 * thread, file and Git events settle. Only one read is in flight at a time (each one runs Git in
 * every worktree). A failed read keeps the last facts rather than inventing new ones.
 */
export interface WorktreeStates {
  states: Map<string, ThreadWorktreeState>;
  /** Applies facts the caller just observed (e.g. after a commit) without waiting for a read. */
  apply: (state: ThreadWorktreeState) => void;
}

export function useWorktreeStates(threads: readonly ThreadSummary[] | null): WorktreeStates {
  const { client } = useRuntime();
  const { events } = useEvents();
  const ids = useMemo(
    () =>
      (threads ?? [])
        .filter((t) => t.worktreeId)
        .map((t) => t.id)
        .slice(0, MAX_IDS),
    [threads],
  );
  const key = ids.join(",");
  const trigger = events.find((e) => /^(thread\.|file\.|git\.)/.test(e.type))?.seq ?? 0;
  const [states, setStates] = useState<Map<string, ThreadWorktreeState>>(() => new Map());
  // The reader for the current set of ids; events ask it for a (debounced) read.
  const reader = useRef<{ request: () => void } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `ids`.
  useEffect(() => {
    if (ids.length === 0) {
      setStates(new Map());
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
      client
        .threadWorktreeStates(ids)
        .then(
          (list) => {
            if (!disposed) setStates(new Map(list.map((s) => [s.threadId, s])));
          },
          () => {
            // Keep the last observed facts; cards say "Checking the worktree…" until the first read.
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
  return useMemo(() => ({ states, apply }), [states, apply]);
}
