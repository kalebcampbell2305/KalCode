import { Sparkline } from "@kalcode/ui/components";
import { useMemo } from "react";
import { useEvents } from "../../runtime/RuntimeProvider.tsx";
import { Page } from "../../shell/Page.tsx";
import { WidgetDock } from "../../shell/widgets/WidgetDock.tsx";
import { Announcer } from "./Announcer.tsx";
import styles from "./Dashboard.module.css";
import { DashboardBoard } from "./DashboardBoard.tsx";
import { activityBuckets, chipCounts, summaryLine } from "./data/board.ts";
import { DashboardDataProvider, useThreadSummaries } from "./data/DashboardData.tsx";
import { useNow } from "./useNow.ts";

/** The Dashboard surface (Z7-W3): the live board of agents beside the widget dock. */
export function Dashboard() {
  return (
    <DashboardDataProvider>
      <DashboardPage />
    </DashboardDataProvider>
  );
}

function DashboardPage() {
  const { state } = useThreadSummaries();
  const summary = useMemo(
    () => (state.status === "ready" && state.data.length > 0 ? summaryLine(chipCounts(state.data)) : null),
    [state],
  );
  return (
    <Page
      title="Dashboard"
      description={summary ?? "Every agent KalCode runs, live: what it is doing, and what needs you."}
      actions={<ActivityTrend />}
    >
      <div className={styles.surface}>
        <div className={styles.layout}>
          <div className={styles.board}>
            <DashboardBoard />
          </div>
          <div className={styles.dock}>
            <WidgetDock />
          </div>
        </div>
      </div>
      <Announcer />
    </Page>
  );
}

/**
 * The Dashboard's activity trend: events recorded in the last hour, in five-minute bars. Real data
 * only (KalCode's event log); nothing is drawn when nothing happened.
 */
function ActivityTrend() {
  const { events } = useEvents();
  const now = useNow(60_000);
  const buckets = useMemo(() => activityBuckets(events, now), [events, now]);
  if (!buckets) return null;
  const total = buckets.reduce((sum, n) => sum + n, 0);
  return (
    <p className={styles.trend}>
      <span className={styles.trendLabel}>Last hour</span>
      <Sparkline values={buckets} variant="bars" width={96} height={24} />
      <span className={styles.trendValue}>
        {total} {total === 1 ? "event" : "events"}
      </span>
    </p>
  );
}

/**
 * The Dashboard as pane content (`PaneContent::Dashboard`, Z7-W1): the same live board, sized by
 * its pane (columns follow the pane's width), with its own one-line summary. The pane scrolls.
 */
export function DashboardPane() {
  return (
    <DashboardDataProvider>
      <div className={styles.pane} data-dashboard-pane>
        <DashboardBoard inPane />
      </div>
      <Announcer />
    </DashboardDataProvider>
  );
}
