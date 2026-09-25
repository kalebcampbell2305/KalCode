import type { ApprovalView, TerminalInfo, ThreadSummary } from "@kalcode/protocol";
import { useMemo } from "react";
import { Page } from "../../shell/Page.tsx";
import { usePermissions } from "../permissions/index.ts";
import { ActivityFeed } from "./ActivityFeed.tsx";
import { Announcer } from "./Announcer.tsx";
import { ApprovalQueue } from "./ApprovalQueue.tsx";
import styles from "./Dashboard.module.css";
import { DashboardDataProvider, useRunningTerminals, useThreadSummaries } from "./data/DashboardData.tsx";
import { readyData } from "./data/resource.ts";
import { describeRuntime, summarizeRuntime } from "./data/summary.ts";
import { RecentOutcomes } from "./RecentOutcomes.tsx";
import { RunningTerminals } from "./RunningTerminals.tsx";
import { RuntimeHealth } from "./RuntimeHealth.tsx";
import { SummaryStrip } from "./SummaryStrip.tsx";
import { ThreadList } from "./ThreadList.tsx";
import { useNow } from "./useNow.ts";

const NO_THREADS: readonly ThreadSummary[] = [];
const NO_APPROVALS: readonly ApprovalView[] = [];
const NO_TERMINALS: readonly TerminalInfo[] = [];

export function Dashboard() {
  return (
    <DashboardDataProvider>
      <DashboardPage />
    </DashboardDataProvider>
  );
}

function DashboardPage() {
  const threads = useThreadSummaries();
  const approvals = usePermissions();
  const terminals = useRunningTerminals();
  const now = useNow(30_000);

  const threadList = readyData(threads.state) ?? NO_THREADS;
  const approvalList = approvals.pendingState === "loading" ? NO_APPROVALS : approvals.pending;
  const terminalList = readyData(terminals.state) ?? NO_TERMINALS;

  const threadNames = useMemo(() => new Map(threadList.map((t) => [t.id, t.name])), [threadList]);
  const summary = useMemo(
    () => (threads.state.status === "ready" ? summarizeRuntime(threadList, approvalList, terminalList) : null),
    [threads.state.status, threadList, approvalList, terminalList],
  );

  const threadsAvailable = threads.state.status !== "unavailable";
  const description = summary ? describeRuntime(summary) : "Everything running in KalCode, as it happens.";

  return (
    <Page title="Dashboard" description={description}>
      {threadsAvailable && threads.state.status !== "error" ? (
        <SummaryStrip
          summary={summary}
          loading={threads.state.status === "loading"}
          approvalsAvailable
          terminalsAvailable={terminals.state.status !== "unavailable"}
        />
      ) : null}
      <div className={styles.layout}>
        <div className={styles.approvals}>
          <ApprovalQueue />
        </div>
        <div className={styles.threads}>
          <ThreadList now={now} />
        </div>
        <aside className={styles.aside} aria-label="Runtime health">
          <RuntimeHealth />
          <RunningTerminals threads={threadList} now={now} />
        </aside>
        <div className={styles.recent}>
          <RecentOutcomes now={now} />
        </div>
        <div className={styles.activity}>
          <ActivityFeed threadNames={threadNames} />
        </div>
      </div>
      <Announcer />
    </Page>
  );
}
