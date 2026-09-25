import type { ProviderHealth } from "@kalcode/protocol";
import { Button, ProviderMark, Skeleton } from "@kalcode/ui/components";
import { useEffect, useMemo, useState } from "react";
import { formatAbsolute, formatRelative } from "../../../runtime/describeEvent.ts";
import { useEvents, useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { healthSummary } from "../../../surfaces/providers/healthLabels.ts";
import { requestProvidersTab } from "../../../surfaces/providers/providersTab.ts";
import { useNavigation } from "../../navigation.tsx";
import styles from "./Widgets.module.css";

/**
 * Provider health: each provider's health as KalCode's health monitor last saw it (detection plus
 * what real sessions showed). Read-only: it reads the in-memory snapshot (`provider_health_list`)
 * and never runs a check itself.
 */
export function ProviderHealthWidget() {
  const { client } = useRuntime();
  const { events } = useEvents();
  const { navigate } = useNavigation();
  const [providers, setProviders] = useState<ProviderHealth[] | null>(null);
  const [failed, setFailed] = useState(false);

  // Re-read when a provider event is recorded (detected, health or capacity changed, ...).
  const providerSeq = useMemo(() => events.find((e) => e.type.startsWith("provider."))?.seq ?? 0, [events]);
  useEffect(() => {
    void providerSeq;
    let cancelled = false;
    client.listProviderHealth().then(
      (list) => {
        if (cancelled) return;
        setProviders(list);
        setFailed(false);
      },
      () => {
        // Health is supplementary and never blocks anything (PH-06).
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, providerSeq]);

  const details = (
    <div className={styles.footer}>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          requestProvidersTab("health");
          navigate("providers");
        }}
      >
        Health details
      </Button>
    </div>
  );

  if (failed && !providers) {
    return (
      <>
        <p className={styles.none}>Health unknown. KalCode couldn't read provider health; threads aren't affected.</p>
        {details}
      </>
    );
  }
  if (!providers) {
    return (
      <div role="status" aria-busy="true">
        <span className="visually-hidden">Loading provider health</span>
        <Skeleton width="65%" />
      </div>
    );
  }
  return (
    <>
      <ul className={styles.list} aria-label="Providers">
        {providers.map((provider) => {
          const state = healthSummary(provider);
          const checked = provider.checkedAt;
          return (
            <li
              key={provider.providerId}
              className={styles.item}
              data-provider-health={provider.providerId}
              data-health-state={provider.state}
            >
              <ProviderMark provider={provider.providerId} name={provider.displayName} size="sm" tile />
              <span className={styles.secondary}>
                {checked ? (
                  <time dateTime={checked} title={formatAbsolute(checked)}>
                    <span className="visually-hidden">Checked </span>
                    {formatRelative(checked)}
                  </time>
                ) : null}
              </span>
              <span className={styles.state} data-tone={state.tone}>
                {state.text}
              </span>
            </li>
          );
        })}
      </ul>
      {details}
    </>
  );
}
