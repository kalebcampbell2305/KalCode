import type { HandoffRecord, ThreadSummary, ThreadWorktreeState } from "@kalcode/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEvents, useRuntime } from "../RuntimeProvider.tsx";
import { isActiveAgent, type PairConflict, pairKey, pairsToCheck, type TouchedPaths } from "./model.ts";

/** The sources ownership reads besides worktree Git facts (which the Fleet already reads). */
export interface OwnershipSources {
  touched: ReadonlyMap<string, TouchedPaths>;
  pairs: ReadonlyMap<string, PairConflict>;
  declared: ReadonlyMap<string, readonly string[]>;
  handoffs: readonly HandoffRecord[];
}

/** Provider edits change while agents work; declared areas and handoffs change rarely. */
const TOUCHED_POLL_MS = 10_000;
const SLOW_POLL_MS = 30_000;
const EVENT_DEBOUNCE_MS = 1_500;
const MAX_IDS = 64;
const MAX_PAIRS = 16;

const LIFECYCLE = /^thread\.(created|archived|unarchived|started|completed|failed)$/;

const NO_TOUCHED: ReadonlyMap<string, TouchedPaths> = new Map();
const NO_PAIRS: ReadonlyMap<string, PairConflict> = new Map();
const NO_DECLARED: ReadonlyMap<string, readonly string[]> = new Map();
const NO_HANDOFFS: readonly HandoffRecord[] = [];

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Re-runs `read` on mount, when `key` changes, every `pollMs` while the window is visible, when it
 * becomes visible again, and shortly after a matching event. One read in flight at a time. A failed
 * read keeps the last value (ownership never drops facts because one read failed), unless `fresh`:
 * then an answer about inputs that changed, or that could not be re-read, becomes unknown again
 * (`initial`) instead of standing as a stale fact.
 */
function usePolledRead<T>(
  key: string,
  enabled: boolean,
  read: () => Promise<T>,
  pollMs: number,
  trigger: number,
  initial: T,
  fresh = false,
): T {
  const [value, setValue] = useState<T>(initial);
  const latest = useRef(read);
  latest.current = read;
  const request = useRef<(() => void) | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names what `read` covers.
  useEffect(() => {
    if (!enabled) {
      setValue(initial);
      request.current = null;
      return;
    }
    if (fresh) setValue(initial);
    let disposed = false;
    let inFlight = false;
    let again = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      if (disposed || document.visibilityState === "hidden") return;
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      latest
        .current()
        .then(
          (next) => {
            if (!disposed) setValue(next);
          },
          () => {
            if (!disposed && fresh) setValue(initial);
          },
        )
        .finally(() => {
          inFlight = false;
          if (again && !disposed) {
            again = false;
            run();
          }
        });
    };
    request.current = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(run, EVENT_DEBOUNCE_MS);
    };
    run();
    const timer = setInterval(run, pollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      if (debounce) clearTimeout(debounce);
    };
  }, [key, enabled, pollMs, fresh]);

  useEffect(() => {
    if (trigger > 0) request.current?.();
  }, [trigger]);

  return value;
}

/**
 * Reads what ownership needs beyond Git worktree facts: provider edits of agents that share the
 * project folder, Git's merge answer for agents that changed the same files, Squad members' owned
 * paths and handoffs in flight. Mounted once, in the shared Dashboard data provider.
 */
export function useOwnershipSources(
  agents: readonly ThreadSummary[] | null,
  worktrees: ReadonlyMap<string, ThreadWorktreeState>,
): OwnershipSources {
  const { client } = useRuntime();
  const { events } = useEvents();
  const fileTrigger = events.find((e) => /^(thread\.|file\.|git\.)/.test(e.type))?.seq ?? 0;
  // Squad launches and handoffs start, finish or close agents; ordinary activity never re-reads them.
  const threadTrigger = events.find((e) => LIFECYCLE.test(e.type))?.seq ?? 0;
  const list = agents ?? [];

  const shared = useMemo(
    () =>
      list.filter((agent) => !agent.worktreeId && agent.archivedAt === null && isActiveAgent(agent)).map((a) => a.id),
    [list],
  );
  const sharedKey = shared.join(",");
  const touched = usePolledRead(
    sharedKey,
    shared.length > 0 && list.length > 1,
    async () => {
      const results = await Promise.all(chunks(shared, MAX_IDS).map((ids) => client.threadTouchedPaths(ids)));
      return new Map(results.flat().map((entry) => [entry.threadId, entry] as const)) as ReadonlyMap<
        string,
        TouchedPaths
      >;
    },
    TOUCHED_POLL_MS,
    fileTrigger,
    NO_TOUCHED,
  );

  const pairs = useMemo(() => pairsToCheck({ agents: list, worktrees }).slice(0, MAX_PAIRS), [list, worktrees]);
  // Git's answer covers committed work: re-asked when either side's commits move (an earlier answer
  // is then unknown, never stale), and on the slow poll for anything the counts can't see.
  const tips = (id: string) => {
    const state = worktrees.get(id);
    return state ? `${state.branch}@${state.ahead ?? "?"}/${state.behind ?? "?"}` : "";
  };
  const pairsKey = pairs.map(([a, b]) => `${a}:${b}:${tips(a)}:${tips(b)}`).join(",");
  const conflicts = usePolledRead(
    pairsKey,
    pairs.length > 0,
    async () => {
      const results = await client.agentPairConflicts(
        pairs.map(([leftThreadId, rightThreadId]) => ({ leftThreadId, rightThreadId })),
      );
      return new Map(
        results.map((entry) => [pairKey(entry.leftThreadId, entry.rightThreadId), entry] as const),
      ) as ReadonlyMap<string, PairConflict>;
    },
    SLOW_POLL_MS,
    0,
    NO_PAIRS,
    true,
  );

  const hasAgents = list.length > 1;
  const declared = usePolledRead(
    "squads",
    hasAgents,
    async () => {
      const snapshot = await client.squads.snapshot();
      const threadOf = new Map(snapshot.operations.map((operation) => [operation.id, operation.threadId] as const));
      const map = new Map<string, readonly string[]>();
      for (const launch of snapshot.launches) {
        for (const member of launch.members) {
          const threadId = threadOf.get(member.operationId);
          if (threadId && member.ownedPaths.length > 0) map.set(threadId, member.ownedPaths);
        }
      }
      return map as ReadonlyMap<string, readonly string[]>;
    },
    SLOW_POLL_MS,
    threadTrigger,
    NO_DECLARED,
  );

  const handoffs = usePolledRead(
    "handoffs",
    hasAgents,
    () => client.handoffs.list(null) as Promise<readonly HandoffRecord[]>,
    SLOW_POLL_MS,
    threadTrigger,
    NO_HANDOFFS,
  );

  return useMemo(() => ({ touched, pairs: conflicts, declared, handoffs }), [touched, conflicts, declared, handoffs]);
}
