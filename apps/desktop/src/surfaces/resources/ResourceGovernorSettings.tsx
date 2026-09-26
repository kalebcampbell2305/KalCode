import { Button, ErrorState, Panel, Skeleton } from "@kalcode/ui/components";
import { RefreshCw } from "lucide-react";
import styles from "./ResourceGovernorView.module.css";
import { ResourceGovernorContent } from "./ResourceGovernorView.tsx";
import { useResourceGovernor } from "./useResourceGovernor.ts";

/** Settings → Resources. The hook is mounted only while Settings is visible. */
export function ResourceGovernorSettings() {
  const data = useResourceGovernor();
  return (
    <section className={styles.settingsSection} aria-labelledby="resource-settings-title">
      <header className={styles.settingsHeader}>
        <div>
          <h2 id="resource-settings-title" className={styles.settingsTitle}>
            Resources
          </h2>
          <p className={styles.settingsDescription}>
            Live machine pressure and room for new provider work. KalCode never stops running work automatically.
          </p>
        </div>
        <Button icon={<RefreshCw />} onClick={data.refresh}>
          Refresh
        </Button>
      </header>

      {data.loading ? (
        <Panel as="div" className={styles.loading} role="status" aria-busy="true">
          <span className="visually-hidden">Loading resource telemetry</span>
          <Skeleton width="35%" height="1rem" />
          <Skeleton width="70%" />
          <Skeleton width="55%" />
        </Panel>
      ) : !data.report ? (
        <ErrorState title="Resource status unavailable" actions={<Button onClick={data.refresh}>Try again</Button>}>
          <p>
            {data.error ?? "KalCode couldn't read resource status."} Local controls and running work are unaffected.
          </p>
        </ErrorState>
      ) : (
        <>
          {data.error ? (
            <p className={styles.refreshError} role="status">
              The latest refresh failed. Showing the previous observation.
            </p>
          ) : null}
          <ResourceGovernorContent
            report={data.report}
            changingMode={data.changingMode}
            onModeChange={data.changeMode}
          />
        </>
      )}
    </section>
  );
}
