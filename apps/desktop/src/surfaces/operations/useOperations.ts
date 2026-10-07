import type { OperationsSnapshot } from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OperationsApi } from "../../ipc/operations.ts";

export interface OperationsState {
  /**
   * The latest snapshot. Kept as the same object while polls observe identical content, so
   * nothing downstream re-renders for an unchanged answer; its own `observedAt` may lag.
   */
  snapshot: OperationsSnapshot | null;
  /** When the native runtime was last observed (every successful poll, changed or not). */
  observedAt: string | null;
  loading: boolean;
  /** A manual refresh is in flight (background polls never show as refreshing). */
  refreshing: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

const POLL_MS = 3_000;

/** Snapshot content without the observation time, to tell a changed answer from a repeat. */
function contentKey(snapshot: OperationsSnapshot): string {
  const { observedAt: _observedAt, ...content } = snapshot;
  return JSON.stringify(content);
}

/** One shared, visibility-aware native snapshot feed for every Operations projection. */
export function useOperations(client: OperationsApi, enabled = true): OperationsState {
  const [snapshotState, setSnapshot] = useState<{ owner: object; value: OperationsSnapshot; key: string } | null>(null);
  const [observedState, setObserved] = useState<{ owner: object; value: string } | null>(null);
  const [errorState, setError] = useState<{ owner: object; value: Error } | null>(null);
  const [refreshingOwner, setRefreshingOwner] = useState<object | null>(null);
  const lifecycle = useMemo(
    () => ({
      client,
      active: false,
      generation: 0,
      request: 0,
      inFlight: null as Promise<void> | null,
      /** One fresh read queued behind the read in flight, for a manual refresh that joined it. */
      followUp: null as Promise<void> | null,
    }),
    [client],
  );
  const live = useRef(lifecycle);
  live.current = lifecycle;

  useEffect(() => {
    lifecycle.active = enabled;
    if (!enabled) {
      lifecycle.generation += 1;
      lifecycle.inFlight = null;
      lifecycle.followUp = null;
      setRefreshingOwner((owner) => (owner === lifecycle ? null : owner));
    }
    return () => {
      lifecycle.active = false;
      lifecycle.generation += 1;
      lifecycle.inFlight = null;
      lifecycle.followUp = null;
    };
  }, [enabled, lifecycle]);

  const load = useCallback(
    (manual: boolean): Promise<void> => {
      if (!lifecycle.active) return Promise.resolve();
      // Only a manual refresh shows as refreshing; joining a background poll in flight still does.
      if (manual) setRefreshingOwner(lifecycle);
      if (lifecycle.inFlight) {
        if (!manual) return lifecycle.inFlight;
        // A manual refresh follows an action (Cancel, Run now, Hold...). The read in flight may
        // have started before that action committed, so its answer can predate it: read once more
        // after it lands. Refreshes that arrive meanwhile share that one follow-up read.
        if (!lifecycle.followUp) {
          const generation = lifecycle.generation;
          const followUp: Promise<void> = lifecycle.inFlight.then(() => {
            if (lifecycle.followUp === followUp) lifecycle.followUp = null;
            return lifecycle.generation === generation ? load(true) : undefined;
          });
          lifecycle.followUp = followUp;
        }
        return lifecycle.followUp;
      }
      const generation = lifecycle.generation;
      const request = ++lifecycle.request;
      const current = () =>
        live.current === lifecycle &&
        lifecycle.active &&
        lifecycle.generation === generation &&
        lifecycle.request === request;
      const promise = lifecycle.client
        .snapshot()
        .then((next) => {
          if (!current()) return;
          const key = contentKey(next);
          setSnapshot((previous) =>
            previous?.owner === lifecycle && previous.key === key ? previous : { owner: lifecycle, value: next, key },
          );
          setObserved((previous) =>
            previous?.owner === lifecycle && previous.value === next.observedAt
              ? previous
              : { owner: lifecycle, value: next.observedAt },
          );
          setError(null);
        })
        .catch((caught: unknown) => {
          if (!current()) return;
          setError({
            owner: lifecycle,
            value: caught instanceof Error ? caught : new Error("Operations are unavailable."),
          });
        })
        .finally(() => {
          if (lifecycle.inFlight === promise) lifecycle.inFlight = null;
          // A queued follow-up read keeps the manual refresh showing until it lands.
          if (current() && !lifecycle.followUp) setRefreshingOwner(null);
        });
      lifecycle.inFlight = promise;
      return promise;
    },
    [lifecycle],
  );
  const refresh = useCallback(() => load(true), [load]);
  const poll = useCallback(() => void load(false), [load]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const updateTimer = () => {
      if (timer) clearInterval(timer);
      timer = null;
      if (document.visibilityState === "hidden") return;
      poll();
      timer = setInterval(poll, POLL_MS);
    };
    updateTimer();
    document.addEventListener("visibilitychange", updateTimer);
    window.addEventListener("focus", poll);
    return () => {
      document.removeEventListener("visibilitychange", updateTimer);
      window.removeEventListener("focus", poll);
      if (timer) clearInterval(timer);
    };
  }, [enabled, poll]);

  const snapshot = snapshotState?.owner === lifecycle ? snapshotState.value : null;
  const error = errorState?.owner === lifecycle ? errorState.value : null;
  return {
    snapshot,
    observedAt: observedState?.owner === lifecycle ? observedState.value : null,
    loading: snapshot === null && error === null,
    refreshing: refreshingOwner === lifecycle,
    error,
    refresh,
  };
}
