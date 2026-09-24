import type { ProviderStatus } from "@kalcode/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { type KalCodeError, toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { needsFirstDetection } from "./providerLabels.ts";

/**
 * Provider statuses for the Providers surface. Loads the native cache and, on the first visit
 * (when a provider has never been checked), runs detection once. "Check again" re-runs it.
 */
export function useProviders() {
  const { client } = useRuntime();
  const [statuses, setStatuses] = useState<ProviderStatus[] | null>(null);
  const [listError, setListError] = useState<KalCodeError | null>(null);
  const [detectError, setDetectError] = useState<KalCodeError | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const detect = useCallback(async () => {
    setDetecting(true);
    setDetectError(null);
    try {
      const next = await client.detectProviders();
      if (mounted.current) setStatuses(next);
    } catch (error) {
      if (mounted.current) setDetectError(toKalCodeError(error));
    } finally {
      if (mounted.current) setDetecting(false);
    }
  }, [client]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the load on retry.
  useEffect(() => {
    let cancelled = false;
    setListError(null);
    client
      .listProviders()
      .then((cached) => {
        if (cancelled) return;
        setStatuses(cached);
        if (needsFirstDetection(cached)) void detect();
      })
      .catch((error: unknown) => {
        if (!cancelled) setListError(toKalCodeError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [client, detect, attempt]);

  const retryList = useCallback(() => setAttempt((n) => n + 1), []);

  return { statuses, listError, retryList, detect, detecting, detectError };
}
