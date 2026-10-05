import type { Diagnostics } from "@kalcode/protocol";
import { Button, ErrorState, KeyValueList, Skeleton, StatusIndicator } from "@kalcode/ui/components";
import type { ReactNode } from "react";
import { formatVersion } from "../../../platform/version.ts";
import { formatDuration, formatRelative } from "../../../runtime/describeEvent.ts";
import { useDiagnostics } from "../../../runtime/useDiagnostics.ts";
import { useClock } from "../../../surfaces/dashboard/useNow.ts";
import type { ProvidersSummary } from "../../../surfaces/providers/providerLabels.ts";
import { useProvidersSummary } from "../../../surfaces/providers/useProvidersSummary.ts";
import { useDiagnosticsActions } from "../../../surfaces/settings/useDiagnosticsActions.ts";
import styles from "./RuntimeHealthWidget.module.css";

/** How long the core has run: the reported uptime, carried forward by the clock between reads. */
function uptimeAt(data: Diagnostics, now: number): number {
  return Math.max(data.uptimeMs, now - new Date(data.startedAt).getTime());
}

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
  if (!summary.checked) return <StatusIndicator tone="muted">Not checked</StatusIndicator>;
  return (
    <Detail
      status={
        <StatusIndicator tone={summary.installed > 0 ? "working" : "muted"}>
          {summary.installed} of {summary.total} installed
        </StatusIndicator>
      }
      detail={summary.installedNames.length > 0 ? summary.installedNames.join(", ") : "No provider CLI found"}
    />
  );
}

/**
 * Runtime health (Z5, as a widget since Z7-W3): the core, the local database, the credential
 * store (with an explicit check), providers found and the build — all from diagnostics.
 */
export function RuntimeHealthWidget() {
  const { data, error, refresh } = useDiagnostics();
  const providers = useProvidersSummary();
  const { checkSecureStore, checking } = useDiagnosticsActions();
  // The shared clock; a tick re-renders the widget only when its uptime or check time reads differently.
  const now = useClock((at) =>
    data
      ? `${formatDuration(uptimeAt(data, at))}|${data.secureStore.lastCheckedAt ? formatRelative(data.secureStore.lastCheckedAt, at) : ""}`
      : null,
  );

  if (error && !data) {
    return (
      <ErrorState
        title="Runtime status unavailable"
        actions={<Button onClick={refresh}>Try again</Button>}
        framed={false}
      >
        <p>{error.message}</p>
      </ErrorState>
    );
  }
  if (!data) {
    return (
      <div role="status" aria-busy="true" className={styles.loading}>
        <span className="visually-hidden">Loading runtime status</span>
        <Skeleton width="70%" />
        <Skeleton width="55%" />
      </div>
    );
  }

  const uptime = uptimeAt(data, now);
  const store = data.secureStore;
  const db = data.database;

  return (
    <div className={styles.body}>
      <KeyValueList
        className={styles.kv}
        items={[
          {
            key: "core",
            label: "Core",
            value: (
              <Detail
                status={
                  <StatusIndicator tone="working" pulse>
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
                  <StatusIndicator tone={db.schemaVersion === db.latestSchemaVersion ? "working" : "waiting"}>
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
                <StatusIndicator tone="muted">Not checked yet</StatusIndicator>
              ) : (
                <Detail
                  status={
                    store.lastCheckOk ? (
                      <StatusIndicator tone="working">Verified</StatusIndicator>
                    ) : (
                      <StatusIndicator tone="failed">Check failed</StatusIndicator>
                    )
                  }
                  detail={`${store.backend ?? "System store"}, ${formatRelative(store.lastCheckedAt, now)}`}
                />
              ),
          },
          { key: "providers", label: "Providers", value: providersValue(providers) },
          { key: "build", label: "Build", value: `${formatVersion(data.app.version)}, ${data.app.channel}` },
        ]}
      />
      <div>
        <Button size="sm" onClick={() => void checkSecureStore()} busy={checking}>
          {store.lastCheckedAt === null ? "Check credential store" : "Check again"}
        </Button>
      </div>
    </div>
  );
}
