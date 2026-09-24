import { useEffect, useState } from "react";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { type ProvidersSummary, summarizeProviders } from "./providerLabels.ts";

/**
 * Cached provider summary for compact places (the dashboard). Reads `providers_list` only —
 * it never starts detection — and refreshes when a provider event is recorded.
 */
export function useProvidersSummary(): { summary: ProvidersSummary | null; failed: boolean } {
  const { client } = useRuntime();
  const { events } = useEvents();
  const latestProviderSeq = events.find((e) => e.type.startsWith("provider."))?.seq ?? 0;
  const [summary, setSummary] = useState<ProvidersSummary | null>(null);
  const [failed, setFailed] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: latestProviderSeq is a refresh trigger.
  useEffect(() => {
    let cancelled = false;
    client
      .listProviders()
      .then((statuses) => {
        if (cancelled) return;
        setSummary(summarizeProviders(statuses));
        setFailed(false);
      })
      .catch(() => {
        // The row is supplementary; the Providers page reports failures in full.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, latestProviderSeq]);

  return { summary, failed };
}
