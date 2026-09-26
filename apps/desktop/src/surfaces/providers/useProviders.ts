import type { ProviderStatus } from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type KalCodeError, toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { needsFirstDetection } from "./providerLabels.ts";

interface ProviderSnapshot {
  statuses: ProviderStatus[] | null;
  listError: KalCodeError | null;
  detectError: KalCodeError | null;
  detecting: boolean;
}
const EMPTY: ProviderSnapshot = { statuses: null, listError: null, detectError: null, detecting: false };

/**
 * Provider statuses for the Providers surface. Loads the native cache and, on the first visit
 * (when a provider has never been checked), runs detection once. "Check again" re-runs it.
 */
export function useProviders() {
  const { client } = useRuntime();
  const lifecycle = useMemo(() => ({ client, mounted: false, generation: 0 }), [client]);
  const current = useRef(lifecycle);
  current.current = lifecycle;
  const isCurrent = useCallback(
    (generation = lifecycle.generation) =>
      lifecycle.mounted && current.current === lifecycle && generation === lifecycle.generation,
    [lifecycle],
  );
  const [snapshot, setSnapshot] = useState({ lifecycle, ...EMPTY });
  const update = useCallback(
    (change: Partial<ProviderSnapshot>) => {
      setSnapshot((previous) => ({ ...(previous.lifecycle === lifecycle ? previous : EMPTY), lifecycle, ...change }));
    },
    [lifecycle],
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    lifecycle.mounted = true;
    update(EMPTY);
    return () => {
      lifecycle.mounted = false;
      lifecycle.generation += 1;
    };
  }, [lifecycle, update]);

  const detect = useCallback(async () => {
    if (!isCurrent()) return;
    const generation = ++lifecycle.generation;
    update({ detecting: true, detectError: null });
    try {
      const next = await client.detectProviders();
      if (isCurrent(generation)) update({ statuses: next, listError: null });
    } catch (error) {
      if (isCurrent(generation)) update({ detectError: toKalCodeError(error) });
    } finally {
      if (isCurrent(generation)) update({ detecting: false });
    }
  }, [client, lifecycle, isCurrent, update]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the load on retry.
  useEffect(() => {
    let cancelled = false;
    const generation = ++lifecycle.generation;
    update({ listError: null, detecting: false, detectError: null });
    client
      .listProviders()
      .then((cached) => {
        if (cancelled || !isCurrent(generation)) return;
        update({ statuses: cached });
        if (needsFirstDetection(cached)) void detect();
      })
      .catch((error: unknown) => {
        if (!cancelled && isCurrent(generation)) update({ listError: toKalCodeError(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [client, detect, attempt, lifecycle, isCurrent, update]);

  const retryList = useCallback(() => {
    if (isCurrent()) setAttempt((n) => n + 1);
  }, [isCurrent]);

  const visible = snapshot.lifecycle === lifecycle ? snapshot : EMPTY;
  return {
    statuses: visible.statuses,
    listError: visible.listError,
    retryList,
    detect,
    detecting: visible.detecting,
    detectError: visible.detectError,
  };
}
