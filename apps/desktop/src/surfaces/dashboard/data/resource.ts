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
  /** Applies a local change to this source's ready data; obsolete sources' updates are ignored. */
  update: (change: (data: T) => T) => void;
}

/**
 * Reads a source through `load` and re-reads it whenever `version` changes. Keep `load` stable for
 * the same source (e.g. useCallback keyed on the client). A new loader resets the source's state,
 * including an unavailable result. Obsolete responses are ignored; an unavailable source is not
 * polled again until its loader changes.
 */
export function useResource<T>(load: () => Promise<T>, version: number): Resource<T> {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);
  const unavailable = useRef(false);
  const source = useRef(load);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` and `attempt` are refresh triggers.
  useEffect(() => {
    if (source.current !== load) {
      source.current = load;
      unavailable.current = false;
      setState({ status: "loading" });
    }
    if (unavailable.current) return;
    const id = ++requestId.current;
    load().then(
      (data) => {
        if (id !== requestId.current) return;
        // A refresh that changed nothing keeps the state (and unchanged records keep their
        // identity), so consumers such as the Fleet's cards re-render only for what changed.
        setState((current) => {
          if (current.status !== "ready") return { status: "ready", data, error: null };
          const merged = reuseRecords(current.data, data);
          return merged === current.data && current.error === null
            ? current
            : { status: "ready", data: merged, error: null };
        });
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
    return () => {
      requestId.current += 1;
    };
  }, [load, version, attempt]);

  const reload = useCallback(() => {
    setState((current) => (current.status === "error" ? { status: "loading" } : current));
    setAttempt((n) => n + 1);
  }, []);

  const update = useCallback(
    (change: (data: T) => T) => {
      setState((current) =>
        source.current === load && current.status === "ready" ? { ...current, data: change(current.data) } : current,
      );
    },
    [load],
  );

  return useMemo(() => ({ state, reload, update }), [state, reload, update]);
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** `next`, reusing equal records of `previous` (by `id` in lists), and `previous` itself when equal. */
function reuseRecords<T>(previous: T, next: T): T {
  if (!Array.isArray(previous) || !Array.isArray(next)) return same(previous, next) ? previous : next;
  const byId = new Map<unknown, unknown>();
  for (const item of previous) if (item && typeof item === "object" && "id" in item) byId.set(item.id, item);
  let unchanged = previous.length === next.length;
  const merged = next.map((item: unknown, i) => {
    const before = item && typeof item === "object" && "id" in item ? byId.get(item.id) : undefined;
    const kept = before !== undefined && same(before, item) ? before : item;
    if (kept !== previous[i]) unchanged = false;
    return kept;
  });
  return (unchanged ? previous : merged) as T;
}

export function readyData<T>(state: ResourceState<T>): T | null {
  return state.status === "ready" ? state.data : null;
}
