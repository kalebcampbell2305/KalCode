import type { DevelopmentService, OperationRecord, OperationStatus, PaneContent, SurfaceFlag } from "@kalcode/protocol";
import { limitsFor } from "@kalcode/protocol";
import {
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusIndicator,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from "@kalcode/ui/components";
import {
  Activity,
  ExternalLink,
  ListChecks,
  RefreshCw,
  RotateCcw,
  Server,
  Square,
  TerminalSquare,
  TestTube2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalAccount } from "../../account/AccountProvider.tsx";
import { planTier } from "../../ipc/account.ts";
import { type OperationsApi, OperationsClient } from "../../ipc/operations.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { registerPaneWidget } from "../../shell/panes/contentRegistry.ts";
import { useOpenInPane } from "../../shell/panes/useOpenInPane.ts";
import {
  filteredSnapshot,
  isActiveRun,
  operationDurationLabel,
  operationStatusLabel,
  timeLabel,
} from "../operations/model.ts";
import {
  type OperationsDetailTab,
  type OperationsMutationRunner,
  OperationsRunDetail,
} from "../operations/OperationsPage.tsx";
import { useOperations } from "../operations/useOperations.ts";
import styles from "./CodeContextOperations.module.css";

export const CODE_CONTEXT_OPERATIONS_WIDGET_ID = "code-context-operations";

type ContextTab = "runs" | "services" | "tests";

const STATUS_TONE: Record<
  OperationStatus,
  "working" | "recovering" | "waiting" | "paused" | "done" | "failed" | "muted"
> = {
  queued: "waiting",
  starting: "recovering",
  running: "working",
  paused: "paused",
  blocked: "waiting",
  succeeded: "done",
  failed: "failed",
  cancelled: "muted",
  interrupted: "failed",
  unknown: "muted",
};

export function codeContextOperationsContent(): PaneContent {
  return { kind: "widget", widgetId: CODE_CONTEXT_OPERATIONS_WIDGET_ID };
}

/** Mirrors the native surface gate: preview is usable; hidden and gated builds advertise nothing. */
export function codeContextOperationsAvailable(
  flags: readonly SurfaceFlag[] | { surfaces: readonly SurfaceFlag[] } | undefined,
): boolean {
  const surfaces = flags && "surfaces" in flags ? flags.surfaces : flags;
  const operations = surfaces?.find((flag) => flag.id === "operations");
  return Boolean(operations?.visible && operations.state !== "gated");
}

export function registerCodeContextOperations(client: OperationsApi): () => void {
  return registerPaneWidget(CODE_CONTEXT_OPERATIONS_WIDGET_ID, {
    describe: () => ({
      title: "Runs & services",
      glyph: <Activity />,
      statusText: "Current-workspace runs, services and test evidence",
    }),
    render: () => <CodeContextOperations client={client} />,
  });
}

/** Feature-aware registration for Code's pane registry. Opening the menu never starts or mutates work. */
export function CodeContextOperationsRegistration() {
  const { client, info } = useRuntime();
  const operations = useMemo(
    () => new OperationsClient((command, args) => client.transport.invoke(command, args)),
    [client],
  );
  const available = codeContextOperationsAvailable(info.flags);

  useEffect(() => {
    if (!available) return;
    return registerCodeContextOperations(operations);
  }, [available, operations]);

  return null;
}

export function CodeContextOperations({ client }: { client: OperationsApi }) {
  const navigation = useNavigation();
  const state = useOperations(client, navigation.current === "code");
  const toast = useToast();
  const workspaces = useWorkspaces();
  const openInPane = useOpenInPane();
  const tier = planTier(useOptionalAccount()?.snapshot);
  const [tab, setTab] = useState<ContextTab>("runs");
  const [selected, setSelected] = useState<{ id: string; tab: OperationsDetailTab } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mutation = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const workspace = workspaces.active;
  const snapshot = useMemo(
    () => (state.snapshot && workspace ? filteredSnapshot(state.snapshot, workspace.id) : null),
    [state.snapshot, workspace],
  );

  const mutate = useCallback<OperationsMutationRunner>(
    async (key, action, success) => {
      if (mutation.current !== null) return false;
      mutation.current = key;
      setBusy(key);
      try {
        await action();
        if (!mounted.current) return true;
        if (success) toast.show({ tone: "success", title: success });
        void state.refresh();
        return true;
      } catch (error) {
        if (mounted.current) {
          toast.show({
            tone: "danger",
            title: "Operations action failed",
            description: error instanceof Error ? error.message : "The native runtime refused the action.",
          });
        }
        return false;
      } finally {
        mutation.current = null;
        if (mounted.current) setBusy(null);
      }
    },
    [state.refresh, toast],
  );

  const openTerminal = useCallback(
    async (service: DevelopmentService) => {
      try {
        if (service.terminalId) {
          await openInPane({ kind: "terminal", terminalId: service.terminalId }, { workspaceId: service.workspaceId });
          return;
        }
        const activated = await workspaces.activate(service.workspaceId);
        if (!activated) return;
        const terminal = await workspaces.createTerminal(null, service.workspaceId);
        if (terminal) {
          await openInPane({ kind: "terminal", terminalId: terminal.id }, { workspaceId: service.workspaceId });
        }
      } catch (error) {
        toast.show({
          tone: "danger",
          title: "Terminal couldn't open",
          description: error instanceof Error ? error.message : "The workspace terminal is unavailable.",
        });
      }
    },
    [openInPane, toast, workspaces],
  );

  if (state.loading || workspaces.state === "loading") return <ContextLoading />;
  if (!workspace) {
    return (
      <div className={styles.state}>
        <EmptyState art={<ListChecks />} title="Open a workspace first">
          <p>Runs, services and tests follow the workspace currently open in Code.</p>
        </EmptyState>
      </div>
    );
  }
  if (!snapshot && state.error) {
    return (
      <div className={styles.state}>
        <ErrorState
          title="Workspace activity couldn't load"
          actions={<Button onClick={() => void state.refresh()}>Try again</Button>}
        >
          {state.error.message}
        </ErrorState>
      </div>
    );
  }
  if (!snapshot) return null;

  const historyLimit = limitsFor(tier).runHistory;
  const runs = visibleRuns(snapshot.items, historyLimit);
  const tests = visibleRuns(snapshot.items, historyLimit, true).filter((run) => run.spec.kind === "test");
  const services = snapshot.services.toSorted((left, right) => {
    const status = Number(right.status === "running") - Number(left.status === "running");
    return status || left.name.localeCompare(right.name);
  });
  const running = snapshot.items.filter(isActiveRun).length;
  const failed = snapshot.items.filter((run) => run.status === "failed").length;

  return (
    <section className={styles.context} aria-label={`Workspace context for ${workspace.name}`}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Live workspace context</span>
          <h2>{workspace.name}</h2>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw aria-hidden="true" />}
          busy={state.refreshing}
          onClick={() => void state.refresh()}
        >
          Refresh
        </Button>
      </header>

      <section className={styles.signal} aria-label="Workspace execution summary">
        <span data-tone="working">
          <strong>{running}</strong> running
        </span>
        <span data-tone="service">
          <strong>{services.filter((service) => service.status === "running").length}</strong> services
        </span>
        <span data-tone={failed > 0 ? "failed" : "quiet"}>
          <strong>{failed}</strong> failed
        </span>
        <small>Observed {timeLabel(state.observedAt ?? snapshot.observedAt)}</small>
      </section>

      {state.error ? (
        <p className={styles.stale} role="status">
          Refresh failed. Showing the last observed snapshot. {state.error.message}
        </p>
      ) : null}
      {snapshot.warnings.length > 0 ? (
        <ul className={styles.warnings} aria-label="Operations warnings">
          {snapshot.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <Tabs value={tab} onValueChange={(value) => setTab(value as ContextTab)} className={styles.tabs}>
        <TabsList className={styles.tabList} aria-label="Workspace context views">
          <TabsTrigger value="runs">
            Runs <span>{runs.length}</span>
          </TabsTrigger>
          <TabsTrigger value="services">
            Services <span>{services.length}</span>
          </TabsTrigger>
          <TabsTrigger value="tests">
            Tests <span>{tests.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="runs">
          <RunList
            runs={runs}
            emptyTitle="No runs in this workspace"
            emptyBody="Started agent, build, script and deployment work appears here."
            onSelect={(id) => setSelected({ id, tab: "overview" })}
          />
        </TabsContent>
        <TabsContent value="services">
          <ServiceList
            services={services}
            client={client}
            busy={busy}
            mutate={mutate}
            onRun={(id) => setSelected({ id, tab: "logs" })}
            onTerminal={openTerminal}
          />
        </TabsContent>
        <TabsContent value="tests">
          <RunList
            runs={tests}
            emptyTitle="No test runs in this workspace"
            emptyBody="Test runs appear here with their attached results and evidence."
            onSelect={(id) => setSelected({ id, tab: "tests" })}
          />
        </TabsContent>
      </Tabs>

      <footer className={styles.footer}>
        <Button size="sm" variant="ghost" onClick={() => navigation.navigate("operations")}>
          Open full Operations
        </Button>
      </footer>

      {selected ? (
        <OperationsRunDetail
          key={`${selected.id}:${selected.tab}`}
          client={client}
          id={selected.id}
          snapshot={snapshot}
          busy={busy}
          mutate={mutate}
          refreshKey={`${snapshot.revision}:${state.observedAt ?? snapshot.observedAt}`}
          initialTab={selected.tab}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}

function visibleRuns(
  items: readonly OperationRecord[],
  historyLimit: number | null,
  includePending = false,
): OperationRecord[] {
  const sorted = items
    .filter((item) => includePending || item.startedAt !== null || isActiveRun(item))
    .toSorted(
      (left, right) => Date.parse(right.startedAt ?? right.createdAt) - Date.parse(left.startedAt ?? left.createdAt),
    );
  if (historyLimit === null) return sorted;
  let finished = 0;
  return sorted.filter((run) => {
    if (run.endedAt === null) return true;
    if (finished >= historyLimit) return false;
    finished += 1;
    return true;
  });
}

function RunList({
  runs,
  emptyTitle,
  emptyBody,
  onSelect,
}: {
  runs: readonly OperationRecord[];
  emptyTitle: string;
  emptyBody: string;
  onSelect: (id: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <EmptyState art={<ListChecks />} title={emptyTitle}>
        <p>{emptyBody}</p>
      </EmptyState>
    );
  }
  return (
    <ol className={styles.runList} aria-label={emptyTitle.startsWith("No test") ? "Test runs" : "Workspace runs"}>
      {runs.map((run) => (
        <li key={run.id}>
          <button
            type="button"
            className={styles.run}
            onClick={() => onSelect(run.id)}
            aria-label={`Open run ${run.spec.name}`}
          >
            <span className={styles.runGlyph} data-kind={run.spec.kind} aria-hidden="true">
              {run.spec.kind === "test" ? <TestTube2 /> : <Activity />}
            </span>
            <span className={styles.runCopy}>
              <strong>{run.spec.name}</strong>
              <small>{run.currentAction ?? run.outcome ?? operationDurationLabel(run)}</small>
            </span>
            <span className={styles.runState}>
              <StatusIndicator
                tone={STATUS_TONE[run.status]}
                pulse={run.status === "running" || run.status === "starting"}
              >
                {operationStatusLabel(run.status)}
              </StatusIndicator>
              <small>{operationDurationLabel(run)}</small>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function ServiceList({
  services,
  client,
  busy,
  mutate,
  onRun,
  onTerminal,
}: {
  services: readonly DevelopmentService[];
  client: OperationsApi;
  busy: string | null;
  mutate: OperationsMutationRunner;
  onRun: (id: string) => void;
  onTerminal: (service: DevelopmentService) => Promise<void>;
}) {
  if (services.length === 0) {
    return (
      <EmptyState art={<Server />} title="No workspace services detected">
        <p>Development servers and other observed local services appear here.</p>
      </EmptyState>
    );
  }
  return (
    <ul className={styles.serviceList} aria-label="Workspace services">
      {services.map((service) => {
        const actionBusy = busy === `service:${service.id}`;
        return (
          <li key={service.id} className={styles.service}>
            <div className={styles.serviceHeading}>
              <span
                className={styles.serviceGlyph}
                data-running={service.status === "running" || undefined}
                aria-hidden="true"
              >
                <Server />
              </span>
              <span>
                <strong>{service.name}</strong>
                <small>
                  {service.processName}
                  {service.pid === null ? "" : ` · PID ${service.pid}`}
                  {service.ports.length === 0 ? "" : ` · :${service.ports.join(", :")}`}
                </small>
              </span>
              <StatusIndicator
                tone={
                  service.status === "running"
                    ? "working"
                    : service.status === "failed"
                      ? "failed"
                      : service.status === "starting"
                        ? "recovering"
                        : "muted"
                }
                pulse={service.status === "running"}
              >
                {service.status.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase())}
              </StatusIndicator>
            </div>
            <div className={styles.serviceActions}>
              {service.urls[0] ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<ExternalLink />}
                  disabled={busy !== null}
                  busy={busy === `url:${service.id}`}
                  onClick={() => void mutate(`url:${service.id}`, () => client.openUrl(service.urls[0] as string))}
                >
                  Browser
                </Button>
              ) : null}
              {service.runId ? (
                <Button size="sm" variant="ghost" onClick={() => onRun(service.runId as string)}>
                  Logs
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" icon={<TerminalSquare />} onClick={() => void onTerminal(service)}>
                Terminal
              </Button>
              {service.status === "running" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Square />}
                  disabled={busy !== null || !service.canStop}
                  busy={actionBusy}
                  title={!service.canStop ? (service.actionReason ?? undefined) : undefined}
                  onClick={() =>
                    void mutate(
                      `service:${service.id}`,
                      () => client.serviceAction(service.id, "stop"),
                      `${service.name} stopped`,
                    )
                  }
                >
                  Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RotateCcw />}
                  disabled={busy !== null || !service.canRestart}
                  busy={actionBusy}
                  title={!service.canRestart ? (service.actionReason ?? undefined) : undefined}
                  onClick={() =>
                    void mutate(
                      `service:${service.id}`,
                      () => client.serviceAction(service.id, "restart"),
                      `${service.name} restarted`,
                    )
                  }
                >
                  Restart
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ContextLoading() {
  return (
    <div className={styles.loading} role="status" aria-busy="true">
      <span className="visually-hidden">Loading workspace activity</span>
      <Skeleton width="9rem" height="1rem" />
      <Skeleton width="100%" height="3.5rem" />
      <Skeleton width="100%" height="12rem" />
    </div>
  );
}
