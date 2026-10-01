import type { OperationsSnapshot } from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OperationsApi } from "../../ipc/operations.ts";

export interface OperationsState {
  snapshot: OperationsSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

const POLL_MS = 3_000;

/** One shared, visibility-aware native snapshot feed for every Operations projection. */
export function useOperations(client: OperationsApi): OperationsState {
  const [snapshotState, setSnapshot] = useState<{ owner: object; value: OperationsSnapshot } | null>(null);
  const [errorState, setError] = useState<{ owner: object; value: Error } | null>(null);
  const [refreshingOwner, setRefreshingOwner] = useState<object | null>(null);
  const lifecycle = useMemo(
    () => ({ client, active: false, generation: 0, request: 0, inFlight: null as Promise<void> | null }),
    [client],
  );
  const live = useRef(lifecycle);
  live.current = lifecycle;

  useEffect(() => {
    lifecycle.active = true;
    return () => {
      lifecycle.active = false;
      lifecycle.generation += 1;
      lifecycle.inFlight = null;
    };
  }, [lifecycle]);

  const refresh = useCallback((): Promise<void> => {
    if (!lifecycle.active) return Promise.resolve();
    if (lifecycle.inFlight) return lifecycle.inFlight;
    const generation = lifecycle.generation;
    const request = ++lifecycle.request;
    const current = () =>
      live.current === lifecycle &&
      lifecycle.active &&
      lifecycle.generation === generation &&
      lifecycle.request === request;
    setRefreshingOwner(lifecycle);
    const promise = lifecycle.client
      .snapshot()
      .then((next) => {
        if (!current()) return;
        setSnapshot({ owner: lifecycle, value: next });
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
        if (current()) setRefreshingOwner(null);
      });
    lifecycle.inFlight = promise;
    return promise;
  }, [lifecycle]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const updateTimer = () => {
      if (timer) clearInterval(timer);
      timer = null;
      if (document.visibilityState === "hidden") return;
      void refresh();
      timer = setInterval(() => void refresh(), POLL_MS);
    };
    updateTimer();
    document.addEventListener("visibilitychange", updateTimer);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", updateTimer);
      window.removeEventListener("focus", refresh);
      if (timer) clearInterval(timer);
    };
  }, [refresh]);

  const snapshot = snapshotState?.owner === lifecycle ? snapshotState.value : null;
  const error = errorState?.owner === lifecycle ? errorState.value : null;
  return {
    snapshot,
    loading: snapshot === null && error === null,
    refreshing: refreshingOwner === lifecycle,
    error,
    refresh,
  };
}
