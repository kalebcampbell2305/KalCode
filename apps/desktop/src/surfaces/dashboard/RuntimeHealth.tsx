import { Button, ErrorState, KeyValueList, Section, Skeleton, StatusIndicator } from "@kalcode/ui/components";
import { type ReactNode, useEffect, useState } from "react";
import { formatDuration, formatRelative } from "../../runtime/describeEvent.ts";
import { useDiagnostics } from "../../runtime/useDiagnostics.ts";
import type { ProvidersSummary } from "../providers/providerLabels.ts";
import { useProvidersSummary } from "../providers/useProvidersSummary.ts";
import { useDiagnosticsActions } from "../settings/useDiagnosticsActions.ts";
import styles from "./RuntimeHealth.module.css";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Detail({ status, detail }: { status: ReactNode; detail: string }) {
  return (
    <span className={styles.detail}>
      {status}
      <span className={styles.detailText}>{detail}</span>
    </span>
  );
}

function providersValue({ summary, failed }: { summary: ProvidersSummary | null; failed: boolean }): ReactNode {
  if (!summary) return failed ? "Unavailable" : <Skeleton width="60%" />;
  if (!summary.checked) return <StatusIndicator tone="idle">Not checked</StatusIndicator>;
  return (
    <Detail
      status={
        <StatusIndicator tone={summary.installed > 0 ? "success" : "idle"}>
          {summary.installed} of {summary.total} installed
        </StatusIndicator>
      }
      detail={summary.installedNames.length > 0 ? summary.installedNames.join(", ") : "No provider CLI found"}
    />
  );
}

export function RuntimeHealth() {
  const { data, error, refresh } = useDiagnostics();
  const providers = useProvidersSummary();
  const { checkSecureStore, checking } = useDiagnosticsActions();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (error && !data) {
    return (
      <Section title="Runtime">
        <ErrorState title="Runtime status unavailable" actions={<Button onClick={refresh}>Try again</Button>}>
          <p>{error.message}</p>
        </ErrorState>
      </Section>
    );
  }

  if (!data) {
    return (
      <Section title="Runtime">
        <div role="status" aria-busy="true" className={styles.loading}>
          <span className="visually-hidden">Loading runtime status</span>
          <Skeleton width="70%" />
          <Skeleton width="55%" />
          <Skeleton width="62%" />
        </div>
      </Section>
    );
  }

  const uptime = Math.max(data.uptimeMs, now - new Date(data.startedAt).getTime());
  const store = data.secureStore;
  const db = data.database;

  return (
    <Section title="Runtime">
      <KeyValueList
        items={[
          {
            key: "core",
            label: "Core",
            value: (
              <Detail
                status={
                  <StatusIndicator tone="live" pulse>
                    Running
                  </StatusIndicator>
                }
                detail={`For ${formatDuration(uptime)}`}
              />
            ),
          },
          {
            key: "database",
            label: "Local database",
            value: (
              <Detail
                status={
                  <StatusIndicator tone={db.schemaVersion === db.latestSchemaVersion ? "success" : "waiting"}>
                    {db.schemaVersion === db.latestSchemaVersion ? "Healthy" : "Upgrade pending"}
                  </StatusIndicator>
                }
                detail={`Schema ${db.schemaVersion}, ${db.eventCount.toLocaleString()} events, ${formatBytes(db.sizeBytes)}`}
              />
            ),
          },
          {
            key: "keychain",
            label: "Credential store",
            value:
              store.lastCheckedAt === null ? (
                <StatusIndicator tone="idle">Not checked yet</StatusIndicator>
              ) : (
                <Detail
                  status={
                    store.lastCheckOk ? (
                      <StatusIndicator tone="success">Verified</StatusIndicator>
                    ) : (
                      <StatusIndicator tone="danger">Check failed</StatusIndicator>
                    )
                  }
                  detail={`${store.backend ?? "System store"}, ${formatRelative(store.lastCheckedAt, now)}`}
                />
              ),
          },
          { key: "providers", label: "Providers", value: providersValue(providers) },
          {
            key: "build",
            label: "Build",
            value: `${data.app.version}, ${data.app.channel}`,
          },
        ]}
      />
      <div>
        <Button size="sm" onClick={() => void checkSecureStore()} busy={checking}>
          {store.lastCheckedAt === null ? "Check credential store" : "Check again"}
        </Button>
      </div>
    </Section>
  );
}
