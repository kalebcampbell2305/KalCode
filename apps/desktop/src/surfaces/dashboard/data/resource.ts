import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isCommandUnavailable, type KalCodeError, toKalCodeError } from "../../../ipc/errors.ts";

/**
 * The state of one Dashboard data source.
 * - loading:     first request in flight; nothing to show yet
 * - ready:       data is current (`error` is set when a later refresh failed and data is stale)
 * - unavailable: this build does not include the command (its campaign has not landed)
 * - error:       the first request failed; nothing to show
 */
export type ResourceState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T; error: KalCodeError | null }
  | { status: "unavailable" }
  | { status: "error"; error: KalCodeError };

export interface Resource<T> {
  state: ResourceState<T>;
  /** Re-reads the source (used by Try again and by event-driven invalidation). */
  reload: () => void;
  /** Applies a local change to ready data (e.g. an action's returned summary) until the next read. */
  update: (change: (data: T) => T) => void;
}

/**
 * Reads a source through `load` and re-reads it whenever `version` changes. Responses that arrive
 * after a newer request started are ignored, so the state always reflects the latest read. Once a
 * source is known to be unavailable in this build it is never polled again.
 */
export function useResource<T>(load: () => Promise<T>, version: number): Resource<T> {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);
  const unavailable = useRef(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` and `attempt` are refresh triggers.
  useEffect(() => {
    if (unavailable.current) return;
    const id = ++requestId.current;
    loadRef.current().then(
      (data) => {
        if (id !== requestId.current) return;
        setState({ status: "ready", data, error: null });
      },
      (raw: unknown) => {
        if (id !== requestId.current) return;
        const error = toKalCodeError(raw);
        if (isCommandUnavailable(error)) {
          unavailable.current = true;
          setState({ status: "unavailable" });
          return;
        }
        setState((current) => (current.status === "ready" ? { ...current, error } : { status: "error", error }));
      },
    );
  }, [version, attempt]);

  const reload = useCallback(() => {
    setState((current) => (current.status === "error" ? { status: "loading" } : current));
    setAttempt((n) => n + 1);
  }, []);

  const update = useCallback((change: (data: T) => T) => {
    setState((current) => (current.status === "ready" ? { ...current, data: change(current.data) } : current));
  }, []);

  return useMemo(() => ({ state, reload, update }), [state, reload, update]);
}

export function readyData<T>(state: ResourceState<T>): T | null {
  return state.status === "ready" ? state.data : null;
}
