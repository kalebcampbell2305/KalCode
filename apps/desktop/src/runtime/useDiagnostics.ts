import type { Diagnostics } from "@kalcode/protocol";
import { useCallback, useEffect, useState } from "react";
import { type KalCodeError, toKalCodeError } from "../ipc/errors.ts";
import { useEvents, useRuntime } from "./RuntimeProvider.tsx";

/** Diagnostics snapshot that refreshes whenever a new event is recorded. */
export function useDiagnostics() {
  const { client } = useRuntime();
  const { events } = useEvents();
  const latestSeq = events[0]?.seq ?? 0;
  const [data, setData] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<KalCodeError | null>(null);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: latestSeq and attempt are refresh triggers.
  useEffect(() => {
    let cancelled = false;
    client
      .getDiagnostics()
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(toKalCodeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, latestSeq, attempt]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, error, refresh };
}
