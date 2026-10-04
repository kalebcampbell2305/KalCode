import type { ProviderAccount, ProviderHealth, ProviderId } from "@kalcode/protocol";
import { Button, ProviderMark, Skeleton } from "@kalcode/ui/components";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatAbsolute, formatRelative } from "../../../runtime/describeEvent.ts";
import { useEvents, useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { healthSummary } from "../../../surfaces/providers/healthLabels.ts";
import { requestProvidersTab } from "../../../surfaces/providers/providersTab.ts";
import { useNavigation } from "../../navigation.tsx";
import styles from "./Widgets.module.css";

/**
 * What a provider's accounts say about sign-in, for a provider whose health hasn't been checked
 * yet: signed in when any active account is, signed out when every one is, otherwise unknown.
 */
export function accountSignInState(
  accounts: readonly Pick<ProviderAccount, "providerId" | "authenticationState" | "archivedAt">[],
  providerId: ProviderId,
): "signed_in" | "signed_out" | null {
  const mine = accounts.filter((a) => a.providerId === providerId && a.archivedAt === null);
  if (mine.some((a) => a.authenticationState === "authenticated")) return "signed_in";
  if (mine.length > 0 && mine.every((a) => a.authenticationState === "not_authenticated")) return "signed_out";
  return null;
}

/**
 * Provider health: each provider's health as KalCode's health monitor last saw it (detection plus
 * what real sessions showed). It reads the in-memory snapshot (`provider_health_list`); a provider
 * that was never checked shows its account sign-in instead, with Check now running the same
 * detection as Providers › Check again.
 */
export function ProviderHealthWidget() {
  const { client } = useRuntime();
  const { events } = useEvents();
  const { navigate } = useNavigation();
  const [providers, setProviders] = useState<ProviderHealth[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [checking, setChecking] = useState(false);
  const [reread, setReread] = useState(0);

  // Re-read when a provider event is recorded (detected, health or capacity changed, ...).
  const providerSeq = useMemo(() => events.find((e) => e.type.startsWith("provider."))?.seq ?? 0, [events]);
  useEffect(() => {
    void providerSeq;
    void reread;
    let cancelled = false;
    client.listProviderAccounts().then(
      (list) => !cancelled && setAccounts(list),
      () => !cancelled && setAccounts([]),
    );
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
  }, [client, providerSeq, reread]);

  // The same detection Providers › Check again runs; health is re-read when it finishes.
  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      await client.detectProviders();
    } catch {
      // A failed check shows on the provider itself ("Check failed") once health is re-read.
    } finally {
      setChecking(false);
      setReread((n) => n + 1);
    }
  }, [client]);
  const showProviders = (tab: "health" | "accounts") => {
    requestProvidersTab(tab);
    navigate("providers");
  };
  const unchecked = providers?.some((p) => p.reasonCode === "not_checked") ?? false;

  const details = (
    <div className={styles.footer}>
      {unchecked ? (
        <Button size="sm" variant="ghost" icon={<RefreshCw />} busy={checking} onClick={() => void checkNow()}>
          Check now
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => showProviders("health")}>
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
          const signIn =
            provider.reasonCode === "not_checked" ? accountSignInState(accounts, provider.providerId) : null;
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
              {signIn === "signed_in" ? (
                <span className={styles.state} data-tone="ok">
                  Signed in
                </span>
              ) : signIn === "signed_out" ? (
                <span className={styles.state} data-tone="warn">
                  Signed out ·{" "}
                  <button
                    type="button"
                    className={styles.linkish}
                    onClick={() => showProviders("accounts")}
                    aria-label={`Sign in to ${provider.displayName}`}
                  >
                    Sign in
                  </button>
                </span>
              ) : (
                <span className={styles.state} data-tone={state.tone}>
                  {state.text}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {details}
    </>
  );
}
