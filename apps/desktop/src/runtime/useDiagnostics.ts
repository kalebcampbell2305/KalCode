import type { Diagnostics } from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type KalCodeError, toKalCodeError } from "../ipc/errors.ts";
import { useEvents, useRuntime } from "./RuntimeProvider.tsx";
import { useThrottledValue } from "./useThrottledValue.ts";

/**
 * Diagnostics snapshot that refreshes when new events are recorded (every event moves the event
 * count it shows). A burst of events becomes one or two reads, not one read per event.
 */
export function useDiagnostics() {
  const { client } = useRuntime();
  const { events } = useEvents();
  const latestSeq = useThrottledValue(events[0]?.seq ?? 0);
  const scope = useMemo(() => ({ client, mounted: false }), [client]);
  const live = useRef(scope);
  live.current = scope;
  const [snapshot, setSnapshot] = useState<{
    owner: typeof scope;
    data: Diagnostics | null;
    error: KalCodeError | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    scope.mounted = true;
    return () => {
      scope.mounted = false;
    };
  }, [scope]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: latestSeq and attempt are refresh triggers.
  useEffect(() => {
    let cancelled = false;
    client
      .getDiagnostics()
      .then((next) => {
        if (cancelled || live.current !== scope || !scope.mounted) return;
        setSnapshot({ owner: scope, data: next, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled || live.current !== scope || !scope.mounted) return;
        setSnapshot((current) => ({
          owner: scope,
          data: current?.owner === scope ? current.data : null,
          error: toKalCodeError(err),
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [client, scope, latestSeq, attempt]);

  const refresh = useCallback(() => {
    if (live.current === scope && scope.mounted) setAttempt((n) => n + 1);
  }, [scope]);
  return {
    data: snapshot?.owner === scope ? snapshot.data : null,
    error: snapshot?.owner === scope ? snapshot.error : null,
    refresh,
  };
}
