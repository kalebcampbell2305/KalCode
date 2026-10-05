import { useEffect, useMemo, useState } from "react";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useThrottledValue } from "../../runtime/useThrottledValue.ts";
import { type ProvidersSummary, summarizeProviders } from "./providerLabels.ts";

/**
 * Cached provider summary for compact places (the dashboard). Reads `providers_list` only —
 * it never starts detection — and refreshes when a provider event is recorded.
 */
export function useProvidersSummary(): { summary: ProvidersSummary | null; failed: boolean } {
  const { client } = useRuntime();
  const { events } = useEvents();
  const latestProviderSeq = useThrottledValue(events.find((e) => e.type.startsWith("provider."))?.seq ?? 0);
  const lifecycle = useMemo(() => ({ client }), [client]);
  const [snapshot, setSnapshot] = useState<{
    lifecycle: typeof lifecycle;
    summary: ProvidersSummary | null;
    failed: boolean;
  }>({
    lifecycle,
    summary: null,
    failed: false,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: latestProviderSeq is a refresh trigger.
  useEffect(() => {
    let cancelled = false;
    client
      .listProviders()
      .then((statuses) => {
        if (cancelled) return;
        setSnapshot({ lifecycle, summary: summarizeProviders(statuses), failed: false });
      })
      .catch(() => {
        // The row is supplementary; the Providers page reports failures in full.
        if (!cancelled)
          setSnapshot((previous) => ({
            lifecycle,
            summary: previous.lifecycle === lifecycle ? previous.summary : null,
            failed: true,
          }));
      });
    return () => {
      cancelled = true;
    };
  }, [client, latestProviderSeq, lifecycle]);

  return snapshot.lifecycle === lifecycle
    ? { summary: snapshot.summary, failed: snapshot.failed }
    : { summary: null, failed: false };
}
