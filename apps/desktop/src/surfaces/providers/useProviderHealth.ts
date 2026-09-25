import type { HealthRollup, ProviderHealth } from "@kalcode/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { type KalCodeError, toKalCodeError } from "../../ipc/errors.ts";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";

/** How often the Health tab re-reads while it is visible. */
export const HEALTH_REFRESH_MS = 30_000;
/** The compact history window. */
export const HISTORY_HOURS = 24;

export interface ProviderHealthData {
  list: ProviderHealth[] | null;
  /** Set when `provider_health_list` failed; the page shows "Health unknown" and carries on. */
  error: KalCodeError | null;
  /** Last-24-hours rollups per provider; `null` when that provider's trend couldn't be read. */
  trends: Record<string, HealthRollup[] | null>;
  refresh: () => void;
}

/**
 * Provider Health for the Providers surface. Reads cheap in-memory snapshots only (never a
 * detection). While `active`, it re-reads when a `provider.*` event is recorded and every 30 s
 * while the window is visible.
 */
export function useProviderHealth(active: boolean): ProviderHealthData {
  const { client } = useRuntime();
  const { events } = useEvents();
  const latestProviderSeq = events.find((e) => e.type.startsWith("provider."))?.seq ?? 0;
  const [list, setList] = useState<ProviderHealth[] | null>(null);
  const [error, setError] = useState<KalCodeError | null>(null);
  const [trends, setTrends] = useState<Record<string, HealthRollup[] | null>>({});
  const [tick, setTick] = useState(0);
  const generation = useRef(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` and `latestProviderSeq` are refresh triggers.
  useEffect(() => {
    if (!active) return;
    const current = ++generation.current;
    let cancelled = false;
    (async () => {
      try {
        const next = await client.listProviderHealth();
        if (cancelled || current !== generation.current) return;
        setList(next);
        setError(null);
        const read = await Promise.all(
          next.map((h) =>
            client.providerHealthTrend(h.providerId, HISTORY_HOURS).then(
              (rollups) => [h.providerId, rollups] as const,
              () => [h.providerId, null] as const,
            ),
          ),
        );
        if (!cancelled && current === generation.current) setTrends(Object.fromEntries(read));
      } catch (cause) {
        if (!cancelled && current === generation.current) setError(toKalCodeError(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, active, tick, latestProviderSeq]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") refresh();
    }, HEALTH_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, refresh]);

  return { list, error, trends, refresh };
}
