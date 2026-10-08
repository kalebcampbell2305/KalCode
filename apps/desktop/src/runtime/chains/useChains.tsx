/**
 * The app's one Handoff Chains store. Chains, their steps' phases and the Operations they point at
 * come from the native `chains_snapshot` read; this provider only caches the last good answer,
 * keeps it fresh while a chain is still moving and forwards the person's explicit decisions.
 *
 * Every pane, the Fleet, Needs You and Activity read this one value, so a step finishing updates
 * them together. An unchanged answer keeps the previous objects, so unrelated panes never re-render.
 */
import type {
  Chain,
  ChainStartRequest,
  ChainStep,
  ChainStepResult,
  ChainStepRoute,
  ChainsSnapshot,
  OperationRecord,
} from "@kalcode/protocol";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type KalCodeError, toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../RuntimeProvider.tsx";

export interface ChainStepRef {
  chain: Chain;
  step: ChainStep;
}

export interface ChainsValue {
  /** The last good answer; null until the first read lands. */
  snapshot: ChainsSnapshot | null;
  chains: readonly Chain[];
  operationsById: ReadonlyMap<string, OperationRecord>;
  loading: boolean;
  /** The latest read or action failed. The last good snapshot is still shown. */
  error: KalCodeError | null;
  refresh: () => Promise<void>;
  /** A step's agent, by Operation id or provider thread id. */
  chainForOperation: (operationOrThreadId: string) => ChainStepRef | null;
  start: (request: ChainStartRequest) => Promise<Chain>;
  pause: (id: string) => Promise<Chain>;
  resume: (id: string) => Promise<Chain>;
  cancel: (id: string) => Promise<Chain>;
  retryStep: (id: string, stepKey: string, route?: ChainStepRoute | null) => Promise<Chain>;
  skipStep: (id: string, stepKey: string) => Promise<Chain>;
  rerouteStep: (id: string, stepKey: string, route: ChainStepRoute) => Promise<Chain>;
  recordStep: (id: string, stepKey: string, result: ChainStepResult, summary: string) => Promise<Chain>;
}

/** How often a chain with a step starting or working is read again. */
export const CHAINS_POLL_MS = 2000;
/** How often a chain whose only live step awaits its report (which the agent may still write). */
export const CHAINS_REPORT_POLL_MS = 10_000;

const NO_CHAINS: readonly Chain[] = [];
const NO_OPERATIONS: ReadonlyMap<string, OperationRecord> = new Map();

/** Phases in which a chain still changes without the person doing anything. */
export function chainSettled(chain: Chain): boolean {
  return !(
    chain.phase === "running" ||
    chain.phase === "needs_you" ||
    chain.phase === "paused" ||
    chain.phase === "blocked"
  );
}

/**
 * How soon this snapshot can change on its own: a step starting or working changes within
 * seconds; a step awaiting its report changes only when its agent writes it. Blocked and paused
 * chains wait for the person, whose actions (and window focus) read again anyway.
 */
export function chainsPollInterval(chains: readonly Chain[]): number | null {
  let interval: number | null = null;
  for (const chain of chains) {
    if (chain.phase === "cancelled" || chain.phase === "superseded") continue;
    for (const step of chain.steps) {
      if (step.phase === "starting" || step.phase === "working") return CHAINS_POLL_MS;
      if (step.phase === "needs_report") interval = CHAINS_REPORT_POLL_MS;
    }
  }
  return interval;
}

const ChainsContext = createContext<ChainsValue | null>(null);

interface State {
  snapshot: ChainsSnapshot | null;
  loading: boolean;
  error: KalCodeError | null;
}

export function ChainsProvider({ children }: { children: ReactNode }) {
  const { client } = useRuntime();
  const [state, setState] = useState<State>({ snapshot: null, loading: true, error: null });
  const mounted = useRef(true);
  const inflight = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const read = useCallback(
    (fresh: boolean): Promise<void> => {
      if (inflight.current) {
        // A read that started before an action can't show its result: run one more afterwards.
        if (fresh) again.current = true;
        return inflight.current;
      }
      const run = async () => {
        do {
          again.current = false;
          try {
            const next = await client.chains.snapshot(null);
            if (!mounted.current) return;
            const serialized = JSON.stringify(next);
            setState((prev) => {
              // An unchanged answer keeps every previous object.
              const same = prev.snapshot !== null && JSON.stringify(prev.snapshot) === serialized;
              if (same && !prev.loading && prev.error === null) return prev;
              return { snapshot: same ? prev.snapshot : next, loading: false, error: null };
            });
          } catch (raw) {
            if (!mounted.current) return;
            const error = toKalCodeError(raw, "chains_snapshot");
            setState((prev) =>
              !prev.loading && prev.error?.code === error.code && prev.error.message === error.message
                ? prev
                : { snapshot: prev.snapshot, loading: false, error },
            );
          }
        } while (again.current && mounted.current);
      };
      const promise = run().finally(() => {
        inflight.current = null;
      });
      inflight.current = promise;
      return promise;
    },
    [client],
  );

  useEffect(() => {
    mounted.current = true;
    void read(false);
    const onFocus = () => void read(false);
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [read]);

  const interval = useMemo(() => chainsPollInterval(state.snapshot?.chains ?? NO_CHAINS), [state.snapshot]);
  useEffect(() => {
    if (interval === null) return;
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void read(false);
    }, interval);
    return () => clearInterval(timer);
  }, [interval, read]);

  const refresh = useCallback(() => read(true), [read]);

  // Every action asks the native authority, then reads the result back, even when it failed.
  const act = useCallback(
    async (run: () => Promise<Chain>): Promise<Chain> => {
      try {
        return await run();
      } finally {
        await read(true);
      }
    },
    [read],
  );
  const actions = useMemo(
    () => ({
      start: (request: ChainStartRequest) => act(() => client.chains.start(request)),
      pause: (id: string) => act(() => client.chains.pause(id)),
      resume: (id: string) => act(() => client.chains.resume(id)),
      cancel: (id: string) => act(() => client.chains.cancel(id)),
      retryStep: (id: string, stepKey: string, route: ChainStepRoute | null = null) =>
        act(() => client.chains.retryStep(id, stepKey, route)),
      skipStep: (id: string, stepKey: string) => act(() => client.chains.skipStep(id, stepKey)),
      rerouteStep: (id: string, stepKey: string, route: ChainStepRoute) =>
        act(() => client.chains.rerouteStep(id, stepKey, route)),
      recordStep: (id: string, stepKey: string, result: ChainStepResult, summary: string) =>
        act(() => client.chains.recordStep(id, stepKey, result, summary)),
    }),
    [act, client],
  );

  const snapshot = state.snapshot;
  const chains = snapshot?.chains ?? NO_CHAINS;
  const operationsById = useMemo(
    () =>
      snapshot ? new Map(snapshot.operations.map((operation) => [operation.id, operation] as const)) : NO_OPERATIONS,
    [snapshot],
  );
  // A step's operation id is its provider thread id natively; either key finds the step.
  const byAgent = useMemo(() => {
    const index = new Map<string, ChainStepRef>();
    for (const chain of chains) {
      for (const step of chain.steps) {
        const ref = { chain, step };
        index.set(step.operationId, ref);
        const threadId = operationsById.get(step.operationId)?.threadId;
        if (threadId) index.set(threadId, ref);
      }
    }
    return index;
  }, [chains, operationsById]);
  const chainForOperation = useCallback((id: string) => byAgent.get(id) ?? null, [byAgent]);

  const value = useMemo<ChainsValue>(
    () => ({
      snapshot,
      chains,
      operationsById,
      loading: state.loading,
      error: state.error,
      refresh,
      chainForOperation,
      ...actions,
    }),
    [snapshot, chains, operationsById, state.loading, state.error, refresh, chainForOperation, actions],
  );
  return <ChainsContext.Provider value={value}>{children}</ChainsContext.Provider>;
}

export function useChains(): ChainsValue {
  const value = useContext(ChainsContext);
  if (!value) throw new Error("useChains must be used inside <ChainsProvider>");
  return value;
}

/** The chains store when one is mounted (isolated renders and tests may not have it). */
export function useOptionalChains(): ChainsValue | null {
  return useContext(ChainsContext);
}
