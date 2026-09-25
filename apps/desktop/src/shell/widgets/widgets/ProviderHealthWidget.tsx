import type { ProviderStatus } from "@kalcode/protocol";
import { Button, ProviderMark, Skeleton } from "@kalcode/ui/components";
import { useEffect, useMemo, useState } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { formatAbsolute, formatRelative } from "../../../runtime/describeEvent.ts";
import { useEvents, useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { useNavigation } from "../../navigation.tsx";
import styles from "./Widgets.module.css";

type Tone = "ok" | "warn" | "bad" | "muted";

/** The read-only detection state of one provider, in words. Never starts a detection. */
export function describeProvider(status: ProviderStatus): { text: string; tone: Tone } {
  const detection = status.detection;
  if (!detection) return { text: "Not checked yet", tone: "muted" };
  switch (detection.state) {
    case "not_installed":
      return { text: "Not installed", tone: "muted" };
    case "error":
      return { text: "Check failed", tone: "bad" };
    case "outdated":
      return { text: `Update needed${detection.version ? ` (${detection.version})` : ""}`, tone: "warn" };
    case "installed":
      if (detection.auth === "not_authenticated") return { text: "Signed out", tone: "warn" };
      return {
        text: `${detection.version ?? "Installed"}${detection.auth === "authenticated" ? " · signed in" : ""}`,
        tone: "ok",
      };
  }
}

/**
 * Provider health: what KalCode last detected for each provider CLI (installed, version, sign-in).
 * Read-only: it shows the cached detection (`providers_list`) and never runs a check itself.
 */
export function ProviderHealthWidget() {
  const { client } = useRuntime();
  const { events } = useEvents();
  const { navigate } = useNavigation();
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-read when detection records something (provider.detected / connected / disconnected).
  const providerSeq = useMemo(() => events.find((e) => e.type.startsWith("provider."))?.seq ?? 0, [events]);
  useEffect(() => {
    void providerSeq;
    let cancelled = false;
    client.listProviders().then(
      (list) => {
        if (cancelled) return;
        setProviders(list);
        setError(null);
      },
      (raw: unknown) => {
        if (!cancelled) setError(toKalCodeError(raw).message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, providerSeq]);

  if (error && !providers) return <p className={styles.none}>{error}</p>;
  if (!providers) {
    return (
      <div role="status" aria-busy="true">
        <span className="visually-hidden">Loading providers</span>
        <Skeleton width="65%" />
      </div>
    );
  }
  return (
    <>
      <ul className={styles.list} aria-label="Provider detection">
        {providers.map((provider) => {
          const state = describeProvider(provider);
          const checked = provider.detection?.checkedAt;
          return (
            <li key={provider.id} className={styles.item}>
              <ProviderMark provider={provider.id} name={provider.displayName} size="sm" tile />
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
      <div className={styles.footer}>
        <Button size="sm" variant="ghost" onClick={() => navigate("providers")}>
          Detection details
        </Button>
      </div>
    </>
  );
}
