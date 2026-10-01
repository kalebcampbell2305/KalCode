import type {
  DevelopmentService,
  OperationActivity,
  OperationDetail,
  OperationEnvironment,
  OperationEnvironmentKind,
  OperationKind,
  OperationRecord,
  OperationSpec,
  OperationStatus,
  OperationsSnapshot,
  ProviderAccount,
  ThreadOptions,
} from "@kalcode/protocol";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Select,
  Skeleton,
  StatusIndicator,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TextArea,
  TextInput,
  useToast,
} from "@kalcode/ui/components";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Box,
  Braces,
  Clock3,
  ExternalLink,
  FileCode2,
  GripVertical,
  ListChecks,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Square,
  TerminalSquare,
  TestTube2,
  X,
} from "lucide-react";
import {
  type DragEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { OperationsApi } from "../../ipc/operations.ts";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useOpenInPane } from "../../shell/panes/useOpenInPane.ts";
import {
  type ActivityRange,
  activityLevel,
  buildActivityHeatmap,
  durationLabel,
  filteredSnapshot,
  isActiveRun,
  moveQueueItem,
  operationDurationLabel,
  operationStatusLabel,
  orderedQueue,
  queueSections,
  timeLabel,
} from "./model.ts";
import styles from "./OperationsPage.module.css";
import { useOperations } from "./useOperations.ts";

export interface OperationsPageProps {
  client: OperationsApi;
  threadOptions: () => Promise<ThreadOptions>;
  providerAccounts?: () => Promise<ProviderAccount[]>;
}

type DetailTab = "overview" | "logs" | "timeline" | "files" | "artifacts" | "tests";

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

const KINDS: OperationKind[] = ["agent", "build", "test", "script", "deploy", "release", "background", "service"];
const ENVIRONMENTS: OperationEnvironmentKind[] = ["local", "preview", "staging", "production"];

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function status(record: OperationRecord, compact = false) {
  const label = operationStatusLabel(record.status);
  const action = record.currentAction?.trim();
  return (
    <StatusIndicator
      tone={STATUS_TONE[record.status]}
      pulse={record.status === "running" || record.status === "starting"}
    >
      {compact ? label : `${label}${action && action.toLowerCase() !== label.toLowerCase() ? ` · ${action}` : ""}`}
    </StatusIndicator>
  );
}

function dependencyLabel(owner: OperationRecord, dependencyId: string, records: ReadonlyMap<string, OperationRecord>) {
  const dependency = records.get(dependencyId);
  if (!dependency) return owner.spec.dependencies.includes(dependencyId) ? "Unavailable dependency" : dependencyId;
  const state =
    dependency.status === "queued" && dependency.startedAt === null && dependency.spec.lane === "later"
      ? "Later"
      : operationStatusLabel(dependency.status);
  return `${dependency.spec.name} (${state})`;
}

function Metadata({ record }: { record: OperationRecord }) {
  const provider = [record.spec.providerId, record.accountLabel, record.spec.model, record.spec.effort]
    .filter(Boolean)
    .join(" · ");
  return (
    <dl className={styles.metadata}>
      <div>
        <dt>Workspace</dt>
        <dd>{record.workspaceName}</dd>
      </div>
      <div>
        <dt>Branch</dt>
        <dd>{record.branch ?? "Not observed"}</dd>
      </div>
      <div>
        <dt>Started</dt>
        <dd>{timeLabel(record.startedAt)}</dd>
      </div>
      <div>
        <dt>Duration</dt>
        <dd>{operationDurationLabel(record)}</dd>
      </div>
      {provider ? (
        <div>
          <dt>Runtime</dt>
          <dd>{provider}</dd>
        </div>
      ) : null}
    </dl>
  );
}

export function OperationsPage({ client, threadOptions, providerAccounts }: OperationsPageProps) {
  const state = useOperations(client);
  const toast = useToast();
  const workspaces = useWorkspaces();
  const openInPane = useOpenInPane();
  const [workspaceId, setWorkspaceId] = useState("");
  const workspaceInitialized = useRef(false);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (workspaceInitialized.current || workspaces.state === "loading") return;
    workspaceInitialized.current = true;
    setWorkspaceId(workspaces.active?.id ?? "");
  }, [workspaces.active?.id, workspaces.state]);

  const snapshot = useMemo(
    () => (state.snapshot ? filteredSnapshot(state.snapshot, workspaceId) : null),
    [state.snapshot, workspaceId],
  );

  const mutate = useCallback(
    async (key: string, action: () => Promise<unknown>, success?: string) => {
      if (busy) return false;
      setBusy(key);
      try {
        await action();
        if (success) toast.show({ tone: "success", title: success });
        await state.refresh();
        return true;
      } catch (error) {
        toast.show({
          tone: "danger",
          title: "Operations action failed",
          description: error instanceof Error ? error.message : "The native runtime refused the action.",
        });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [busy, state, toast],
  );

  const showRun = useCallback((id: string) => setSelectedRun(id), []);

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

  if (state.loading) return <OperationsLoading />;
  if (!snapshot && state.error) {
    return (
      <div className={styles.page}>
        <ErrorState
          headingLevel={1}
          title="Operations couldn't load"
          actions={<Button onClick={() => void state.refresh()}>Try again</Button>}
        >
          {state.error.message}
        </ErrorState>
      </div>
    );
  }
  if (!snapshot) return null;

  const active = snapshot.items.filter(isActiveRun).length;
  const queued = orderedQueue(snapshot.items).length;
  const failed = snapshot.items.filter((item) => item.status === "failed").length;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.headingLine}>
            <h1>Operations</h1>
            {snapshot.paused ? (
              <Badge tone="paused">Queue paused</Badge>
            ) : (
              <Badge tone="accent">Scheduler active</Badge>
            )}
          </div>
          <p>One execution record from queued intent to runtime evidence and deployed state.</p>
        </div>
        <div className={styles.headerActions}>
          <label className={styles.workspaceFilter}>
            <span>Workspace</span>
            <select
              value={workspaceId}
              onChange={(event) => {
                setSelectedRun(null);
                setWorkspaceId(event.target.value);
              }}
            >
              <option value="">All workspaces</option>
              {workspaces.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw aria-hidden="true" />}
            busy={state.refreshing}
            onClick={() => void state.refresh()}
          >
            Refresh
          </Button>
        </div>
      </header>

      <section className={styles.pulseBar} aria-label="Operations summary">
        <span>
          <strong>{active}</strong> running
        </span>
        <span>
          <strong>{queued}</strong> queued
        </span>
        <span>
          <strong>{snapshot.services.filter((service) => service.status === "running").length}</strong> services
        </span>
        <span className={failed > 0 ? styles.failedMetric : undefined}>
          <strong>{failed}</strong> failed
        </span>
        <span className={styles.observed}>Observed {timeLabel(snapshot.observedAt)}</span>
      </section>

      {state.error ? (
        <div className={styles.staleNotice} role="status">
          Refresh failed. Showing the last observed snapshot. {state.error.message}
        </div>
      ) : null}
      {snapshot.warnings.length > 0 ? (
        <ul className={styles.warnings} aria-label="Operations warnings">
          {snapshot.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <Tabs defaultValue="runs" className={styles.tabs}>
        <TabsList aria-label="Operations views" className={styles.tabList}>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="services">Services</TabsTrigger>
          <TabsTrigger value="environments">Environments</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="runs">
          <RunsView
            snapshot={snapshot}
            client={client}
            workspaceId={workspaceId}
            selected={selectedRun}
            onSelect={showRun}
          />
        </TabsContent>
        <TabsContent value="queue">
          <QueueView
            snapshot={snapshot}
            client={client}
            busy={busy}
            mutate={mutate}
            threadOptions={threadOptions}
            providerAccounts={providerAccounts}
            onRun={showRun}
          />
        </TabsContent>
        <TabsContent value="services">
          <ServicesView
            snapshot={snapshot}
            client={client}
            busy={busy}
            mutate={mutate}
            onRun={showRun}
            onTerminal={openTerminal}
          />
        </TabsContent>
        <TabsContent value="environments">
          <EnvironmentsView
            snapshot={snapshot}
            client={client}
            onRun={showRun}
            mutate={mutate}
            workspaceNames={new Map(workspaces.workspaces.map((workspace) => [workspace.id, workspace.name]))}
          />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityView snapshot={snapshot} onRun={showRun} />
        </TabsContent>
      </Tabs>

      {selectedRun ? (
        <RunDetail
          key={selectedRun}
          client={client}
          id={selectedRun}
          snapshot={snapshot}
          busy={busy}
          mutate={mutate}
          refreshKey={`${snapshot.revision}:${snapshot.observedAt}`}
          onClose={() => setSelectedRun(null)}
        />
      ) : null}
    </div>
  );
}

function OperationsLoading() {
  return (
    <section className={styles.page} aria-busy="true" aria-label="Loading Operations">
      <div className={styles.loadingHeader}>
        <Skeleton width="12rem" height="1.5rem" />
        <Skeleton width="28rem" />
      </div>
      <Skeleton width="100%" height="2.5rem" />
      <Skeleton width="100%" height="24rem" />
    </section>
  );
}

function RunsView({
  snapshot,
  client,
  workspaceId,
  selected,
  onSelect,
}: {
  snapshot: OperationsSnapshot;
  client: OperationsApi;
  workspaceId: string;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [older, setOlder] = useState<OperationRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [historyStarted, setHistoryStarted] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyEpoch = useRef(0);
  const historyScope = useRef({ client, workspaceId });

  useEffect(() => {
    if (historyScope.current.client !== client || historyScope.current.workspaceId !== workspaceId) {
      historyScope.current = { client, workspaceId };
      historyEpoch.current += 1;
      setOlder([]);
      setCursor(null);
      setHistoryStarted(false);
      setLoadingHistory(false);
      setHistoryError(null);
    }
    return () => {
      historyEpoch.current += 1;
    };
  }, [client, workspaceId]);

  const pendingIds = new Set(orderedQueue(snapshot.items).map((item) => item.id));
  const recent = snapshot.items.filter((item) => !pendingIds.has(item.id));
  const byId = new Map(older.map((item) => [item.id, item]));
  // A live snapshot wins every collision so paging can never roll a status backward.
  for (const item of recent) byId.set(item.id, item);
  const runs = [...byId.values()]
    .filter((item) => !workspaceId || item.spec.workspaceId === workspaceId)
    .sort((a, b) => Date.parse(b.startedAt ?? b.createdAt) - Date.parse(a.startedAt ?? a.createdAt));

  const loadOlder = async () => {
    if (loadingHistory || (historyStarted && cursor === null)) return;
    const epoch = historyEpoch.current;
    const known = new Set([...snapshot.items, ...older].map((item) => item.id));
    const additions: OperationRecord[] = [];
    let foundForWorkspace = false;
    let before = historyStarted ? cursor : null;
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      // Snapshot keeps up to 200 recent runs while native history pages contain 100. Skip
      // overlapping pages in one click so "Load older" always extends the visible history.
      for (let pageCount = 0; pageCount < 4; pageCount += 1) {
        const page = await client.history(before);
        for (const item of page.items) {
          if (!known.has(item.id)) {
            known.add(item.id);
            additions.push(item);
            if (!workspaceId || item.spec.workspaceId === workspaceId) foundForWorkspace = true;
          }
        }
        before = page.nextCursor;
        if (foundForWorkspace || before === null) break;
      }
      if (epoch !== historyEpoch.current) return;
      setOlder((current) => {
        const merged = new Map(current.map((item) => [item.id, item]));
        for (const item of additions) merged.set(item.id, item);
        return [...merged.values()];
      });
      setCursor(before);
      setHistoryStarted(true);
    } catch (error) {
      if (epoch === historyEpoch.current) {
        setHistoryError(error instanceof Error ? error.message : "Older run history is unavailable.");
      }
    } finally {
      if (epoch === historyEpoch.current) setLoadingHistory(false);
    }
  };

  return (
    <section className={styles.runLayout} aria-label="Execution history">
      {runs.length === 0 ? (
        <EmptyState art={<ListChecks />} title="No runs recorded">
          <p>Queued work appears here when the native scheduler starts it. Load older to check earlier history.</p>
        </EmptyState>
      ) : null}
      <div className={styles.runList}>
        {runs.map((run) => (
          <button
            key={run.id}
            type="button"
            className={styles.runRow}
            data-selected={selected === run.id || undefined}
            onClick={() => onSelect(run.id)}
          >
            <span className={styles.kindIcon} data-kind={run.spec.kind} aria-hidden="true">
              {kindIcon(run.spec.kind)}
            </span>
            <span className={styles.runMain}>
              <span className={styles.runTitle}>{run.spec.name}</span>
              <span className={styles.runContext}>
                {run.workspaceName}
                {run.branch ? ` · ${run.branch}` : ""}
              </span>
              <span className={styles.runAction}>
                {run.currentAction ??
                  run.outcome ??
                  (run.status === "unknown" ? "Execution details unavailable" : "No current action reported")}
              </span>
            </span>
            <span className={styles.runStatus}>
              {status(run, true)}
              <span>{operationDurationLabel(run)}</span>
            </span>
          </button>
        ))}
      </div>
      <div className={styles.runHint}>
        <span>Select a run to inspect its timeline, logs, changed files, artifacts, and tests.</span>
        {historyError ? <span role="alert">{historyError}</span> : null}
        {!historyStarted || cursor !== null ? (
          <Button size="sm" variant="secondary" busy={loadingHistory} onClick={() => void loadOlder()}>
            Load older
          </Button>
        ) : (
          <span>Complete history loaded</span>
        )}
      </div>
    </section>
  );
}

function kindIcon(kind: OperationKind): ReactNode {
  if (kind === "test") return <TestTube2 />;
  if (kind === "service" || kind === "deploy") return <Server />;
  if (kind === "agent") return <Braces />;
  if (kind === "build" || kind === "release") return <Box />;
  return <TerminalSquare />;
}

type MutationRunner = (key: string, action: () => Promise<unknown>, success?: string) => Promise<boolean>;

function QueueView({
  snapshot,
  client,
  busy,
  mutate,
  threadOptions,
  providerAccounts,
  onRun,
}: {
  snapshot: OperationsSnapshot;
  client: OperationsApi;
  busy: string | null;
  mutate: MutationRunner;
  threadOptions: () => Promise<ThreadOptions>;
  providerAccounts?: () => Promise<ProviderAccount[]>;
  onRun: (id: string) => void;
}) {
  const sections = queueSections(snapshot.items);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const queue = orderedQueue(snapshot.items);
  const records = new Map(snapshot.items.map((item) => [item.id, item]));

  const reorder = (id: string, direction: -1 | 1) => {
    const next = moveQueueItem(
      queue.map((item) => item.id),
      id,
      direction,
    );
    if (next.every((value, index) => value === queue[index]?.id)) return;
    void mutate(`reorder:${id}`, () => client.reorder(next, snapshot.revision));
  };

  const drop = (targetId: string) => {
    if (!dragged || dragged === targetId) return;
    const ids = queue.map((item) => item.id);
    const from = ids.indexOf(dragged);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragged);
    setDragged(null);
    void mutate(`reorder:${dragged}`, () => client.reorder(ids, snapshot.revision));
  };

  return (
    <section className={styles.queue} aria-label="Engineering queue">
      <div className={styles.sectionToolbar}>
        <div>
          <h2>Scheduler</h2>
          <p>Dependencies and priority are resolved by the native scheduler. Run now starts only eligible work.</p>
        </div>
        <div className={styles.toolbarActions}>
          <Button
            size="sm"
            variant="secondary"
            icon={snapshot.paused ? <Play /> : <Pause />}
            busy={busy === "scheduler"}
            onClick={() =>
              void mutate(
                "scheduler",
                () => client.pause(!snapshot.paused),
                snapshot.paused ? "Queue resumed" : "Queue paused",
              )
            }
          >
            {snapshot.paused ? "Resume queue" : "Pause queue"}
          </Button>
          <Button size="sm" icon={<Plus />} onClick={() => setCreating((value) => !value)}>
            {creating ? "Close form" : "New task"}
          </Button>
        </div>
      </div>
      {snapshot.paused ? (
        <div className={styles.pauseNotice} role="status">
          New work is paused. Active runs continue.
        </div>
      ) : null}
      {creating ? (
        <TaskEditor
          key="new"
          snapshot={snapshot}
          threadOptions={threadOptions}
          providerAccounts={providerAccounts}
          busy={busy === "enqueue"}
          onCancel={() => setCreating(false)}
          onSave={async (spec) => {
            if (await mutate("enqueue", () => client.enqueue(spec), "Task added to the queue")) setCreating(false);
          }}
        />
      ) : null}
      <div className={styles.queueColumns}>
        <QueueColumn title="Now" detail="Running" items={sections.now} empty="No work is running." onRun={onRun} />
        <QueueColumn title="Next" detail="Ready order" items={sections.next} empty="No tasks are ready next." />
        <QueueColumn title="Later" detail="Deferred" items={sections.later} empty="No later tasks." />
      </div>
      {queue.length === 0 ? (
        <EmptyState art={<ListChecks />} title="The queue is clear">
          <p>Add a task to schedule a script, test, build, deployment, or provider-backed agent run.</p>
        </EmptyState>
      ) : (
        <ol className={styles.queueRows} aria-label="Pending tasks">
          {queue.map((item, index) => (
            <li
              key={item.id}
              className={styles.queueItem}
              draggable
              onDragStart={(event) => {
                setDragged(item.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", item.id);
              }}
              onDragEnd={() => setDragged(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event: DragEvent) => {
                event.preventDefault();
                drop(item.id);
              }}
              data-dragged={dragged === item.id || undefined}
            >
              <span className={styles.dragHandle} title="Drag to reorder" aria-hidden="true">
                <GripVertical />
              </span>
              <div className={styles.queueItemMain}>
                <div className={styles.queueItemTitle}>
                  <strong>{item.spec.name}</strong>
                  {status(item, true)}
                </div>
                <p>
                  {titleCase(item.spec.kind)} · {item.workspaceName} · Priority {item.spec.priority}
                </p>
                {item.spec.dependencies.length > 0 ? (
                  <p>Depends on {item.spec.dependencies.map((id) => dependencyLabel(item, id, records)).join(", ")}</p>
                ) : null}
                {item.blockers.length > 0 ? (
                  <p className={styles.blocker}>
                    Blocked: {item.blockers.map((blocker) => dependencyLabel(item, blocker, records)).join(" · ")}
                  </p>
                ) : null}
              </div>
              <div className={styles.queueActions}>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Move ${item.spec.name} up`}
                  disabled={index === 0 || busy !== null}
                  onClick={() => reorder(item.id, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Move ${item.spec.name} down`}
                  disabled={index === queue.length - 1 || busy !== null}
                  onClick={() => reorder(item.id, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(editing === item.id ? null : item.id)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void mutate(`run:${item.id}`, () => client.runNow(item.id))}
                >
                  <Play /> Run now
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void mutate(`hold:${item.id}`, () => client.hold(item.id, item.status !== "paused"))}
                >
                  {item.status === "paused" ? <Play /> : <Pause />} {item.status === "paused" ? "Resume" : "Hold"}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy !== null}
                  onClick={() => void mutate(`cancel:${item.id}`, () => client.cancel(item.id))}
                >
                  <X /> Cancel
                </Button>
              </div>
              {editing === item.id ? (
                <TaskEditor
                  snapshot={snapshot}
                  initial={item}
                  threadOptions={threadOptions}
                  providerAccounts={providerAccounts}
                  busy={busy === `update:${item.id}`}
                  onCancel={() => setEditing(null)}
                  onSave={async (spec) => {
                    if (
                      await mutate(
                        `update:${item.id}`,
                        () => client.update(item.id, spec, snapshot.revision),
                        "Task updated",
                      )
                    ) {
                      setEditing(null);
                    }
                  }}
                />
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function QueueColumn({
  title,
  detail,
  items,
  empty,
  onRun,
}: {
  title: string;
  detail: string;
  items: OperationRecord[];
  empty: string;
  onRun?: (id: string) => void;
}) {
  return (
    <section className={styles.queueColumn}>
      <header>
        <h3>{title}</h3>
        <span>
          {detail} · {items.length}
        </span>
      </header>
      {items.length === 0 ? (
        <p className={styles.columnEmpty}>{empty}</p>
      ) : (
        <ol>
          {(onRun ? items : items.slice(0, 4)).map((item) => (
            <li key={item.id}>
              {onRun ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Open run ${item.spec.name}`}
                  onClick={() => onRun(item.id)}
                >
                  {item.spec.name}
                </Button>
              ) : (
                <span>{item.spec.name}</span>
              )}
              {status(item, true)}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function emptySpec(workspaceId: string): OperationSpec {
  return {
    name: "",
    workspaceId,
    kind: "script",
    command: "",
    prompt: null,
    providerId: null,
    providerAccountId: null,
    model: null,
    effort: null,
    dependencies: [],
    priority: 0,
    lane: "next",
    environment: "local",
    urls: [],
    envKeys: [],
  };
}

function TaskEditor({
  snapshot,
  initial,
  threadOptions,
  providerAccounts,
  busy,
  onCancel,
  onSave,
}: {
  snapshot: OperationsSnapshot;
  initial?: OperationRecord;
  threadOptions: () => Promise<ThreadOptions>;
  providerAccounts?: () => Promise<ProviderAccount[]>;
  busy: boolean;
  onCancel: () => void;
  onSave: (spec: OperationSpec) => Promise<void>;
}) {
  const formId = useId();
  const [options, setOptions] = useState<ThreadOptions | null>(null);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsRevision, setOptionsRevision] = useState(0);
  const fallbackWorkspace =
    initial?.spec.workspaceId ?? snapshot.items[0]?.spec.workspaceId ?? snapshot.services[0]?.workspaceId ?? "";
  const [spec, setSpec] = useState<OperationSpec>(() => initial?.spec ?? emptySpec(fallbackWorkspace));
  const [urls, setUrls] = useState(spec.urls.join(", "));
  const [envKeys, setEnvKeys] = useState(spec.envKeys.join(", "));

  useEffect(() => {
    let active = true;
    setOptionsError(null);
    if (optionsRevision > 0) {
      setOptions(null);
      setAccounts([]);
    }
    Promise.all([threadOptions(), providerAccounts?.() ?? Promise.resolve([])])
      .then(([next, nextAccounts]) => {
        if (!active) return;
        setOptions(next);
        setAccounts(nextAccounts.filter((account) => !account.archivedAt));
        setSpec((current) =>
          current.workspaceId ? current : { ...current, workspaceId: next.workspaces[0]?.id ?? "" },
        );
      })
      .catch((error: unknown) => {
        if (active)
          setOptionsError(error instanceof Error ? error.message : "Provider and workspace options are unavailable.");
      });
    return () => {
      active = false;
    };
  }, [optionsRevision, providerAccounts, threadOptions]);

  const provider = options?.providers.find((item) => item.id === spec.providerId);
  const providerAccountsForSelection = accounts.filter((account) => account.providerId === spec.providerId);
  const isAgent = spec.kind === "agent";
  const valid = Boolean(
    spec.name.trim() && spec.workspaceId && (isAgent ? spec.prompt?.trim() && spec.providerId : spec.command?.trim()),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    void onSave({
      ...spec,
      name: spec.name.trim(),
      command: isAgent ? null : spec.command?.trim() || null,
      prompt: isAgent ? spec.prompt?.trim() || null : null,
      providerId: isAgent ? spec.providerId : null,
      providerAccountId: isAgent ? spec.providerAccountId : null,
      model: isAgent ? spec.model : null,
      effort: null,
      urls: urls
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      envKeys: envKeys
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    });
  };

  return (
    <form className={styles.taskForm} onSubmit={submit}>
      <div className={styles.formHeading}>
        <div>
          <h3>{initial ? "Edit queued task" : "Queue engineering work"}</h3>
          <p>Commands and environment names are confirmed by the native runtime before they are saved.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Close
        </Button>
      </div>
      <div className={styles.formGrid}>
        <Field htmlFor={`${formId}-name`} label="Name">
          <TextInput
            id={`${formId}-name`}
            value={spec.name}
            onChange={(event) => setSpec({ ...spec, name: event.target.value })}
            required
          />
        </Field>
        <Field htmlFor={`${formId}-kind`} label="Kind">
          <Select
            id={`${formId}-kind`}
            value={spec.kind}
            onChange={(event) => {
              const kind = event.target.value as OperationKind;
              setSpec(
                kind === "agent"
                  ? { ...spec, kind, command: null, prompt: spec.prompt ?? "", effort: null }
                  : {
                      ...spec,
                      kind,
                      prompt: null,
                      providerId: null,
                      providerAccountId: null,
                      model: null,
                      effort: null,
                    },
              );
            }}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {titleCase(kind)}
              </option>
            ))}
          </Select>
        </Field>
        <Field htmlFor={`${formId}-workspace`} label="Workspace">
          <Select
            id={`${formId}-workspace`}
            value={spec.workspaceId}
            onChange={(event) => {
              setSpec({
                ...spec,
                workspaceId: event.target.value,
                providerAccountId: null,
                model: null,
              });
              setOptionsRevision((value) => value + 1);
            }}
            required
          >
            <option value="">Choose workspace</option>
            {options?.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field htmlFor={`${formId}-environment`} label="Environment">
          <Select
            id={`${formId}-environment`}
            value={spec.environment}
            onChange={(event) => setSpec({ ...spec, environment: event.target.value as OperationEnvironmentKind })}
          >
            {ENVIRONMENTS.map((environment) => (
              <option key={environment} value={environment}>
                {titleCase(environment)}
              </option>
            ))}
          </Select>
        </Field>
        <Field htmlFor={`${formId}-lane`} label="Schedule">
          <Select
            id={`${formId}-lane`}
            value={spec.lane}
            onChange={(event) => setSpec({ ...spec, lane: event.target.value as "next" | "later" })}
          >
            <option value="next">Next</option>
            <option value="later">Later</option>
          </Select>
        </Field>
        <Field
          htmlFor={`${formId}-priority`}
          label="Priority"
          hint="Higher priorities are considered first after dependencies."
        >
          <TextInput
            id={`${formId}-priority`}
            type="number"
            value={String(spec.priority)}
            onChange={(event) => setSpec({ ...spec, priority: Number.parseInt(event.target.value, 10) || 0 })}
          />
        </Field>
      </div>
      {isAgent ? (
        <>
          <div className={styles.permissionNotice}>
            Agent tasks start in <strong>Approve</strong> permission mode.
          </div>
          <div className={styles.formGrid}>
            <Field htmlFor={`${formId}-provider`} label="Provider">
              <Select
                id={`${formId}-provider`}
                value={spec.providerId ?? ""}
                onChange={(event) =>
                  setSpec({ ...spec, providerId: event.target.value || null, providerAccountId: null, model: null })
                }
                required
              >
                <option value="">Choose provider</option>
                {options?.providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field htmlFor={`${formId}-account`} label="Account">
              <Select
                id={`${formId}-account`}
                value={spec.providerAccountId ?? ""}
                onChange={(event) => setSpec({ ...spec, providerAccountId: event.target.value || null })}
              >
                <option value="">Provider default</option>
                {providerAccountsForSelection.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field htmlFor={`${formId}-model`} label="Model">
              <Select
                id={`${formId}-model`}
                value={spec.model ?? ""}
                onChange={(event) => setSpec({ ...spec, model: event.target.value || null })}
              >
                <option value="">Provider default</option>
                {provider?.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              htmlFor={`${formId}-effort`}
              label="Effort"
              hint="This provider runtime does not advertise effort selection."
            >
              <Select id={`${formId}-effort`} value="" disabled>
                <option value="">Provider default</option>
              </Select>
            </Field>
          </div>
          <Field htmlFor={`${formId}-prompt`} label="Prompt">
            <TextArea
              id={`${formId}-prompt`}
              rows={4}
              value={spec.prompt ?? ""}
              onChange={(event) => setSpec({ ...spec, prompt: event.target.value })}
              required
            />
          </Field>
        </>
      ) : (
        <Field htmlFor={`${formId}-command`} label="Command">
          <TextArea
            id={`${formId}-command`}
            rows={3}
            value={spec.command ?? ""}
            onChange={(event) => setSpec({ ...spec, command: event.target.value })}
            required
          />
        </Field>
      )}
      <div className={styles.formGrid}>
        <Field
          htmlFor={`${formId}-urls`}
          label="Declared URLs"
          optional
          hint="Comma-separated; declared endpoints are not live proof."
        >
          <TextInput id={`${formId}-urls`} value={urls} onChange={(event) => setUrls(event.target.value)} />
        </Field>
        <Field
          htmlFor={`${formId}-env`}
          label="Environment variable names"
          optional
          hint="Names only. Values never enter Operations."
        >
          <TextInput id={`${formId}-env`} value={envKeys} onChange={(event) => setEnvKeys(event.target.value)} />
        </Field>
      </div>
      <fieldset className={styles.dependencies}>
        <legend>Dependencies</legend>
        {snapshot.items.filter((item) => item.id !== initial?.id).length === 0 ? (
          <p>No other operations are available.</p>
        ) : (
          snapshot.items
            .filter((item) => item.id !== initial?.id)
            .map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={spec.dependencies.includes(item.id)}
                  onChange={(event) =>
                    setSpec({
                      ...spec,
                      dependencies: event.target.checked
                        ? [...spec.dependencies, item.id]
                        : spec.dependencies.filter((id) => id !== item.id),
                    })
                  }
                />
                {item.spec.name}
              </label>
            ))
        )}
      </fieldset>
      {optionsError ? (
        <p className={styles.formError} role="alert">
          {optionsError}
        </p>
      ) : null}
      <div className={styles.formFooter}>
        <Button type="submit" busy={busy} disabled={!valid}>
          {initial ? "Save task" : "Add to queue"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ServicesView({
  snapshot,
  client,
  busy,
  mutate,
  onRun,
  onTerminal,
}: {
  snapshot: OperationsSnapshot;
  client: OperationsApi;
  busy: string | null;
  mutate: MutationRunner;
  onRun: (id: string) => void;
  onTerminal: (service: DevelopmentService) => Promise<void>;
}) {
  if (snapshot.services.length === 0) {
    return (
      <EmptyState art={<Server />} title="No workspace services detected">
        <p>
          Start a development server from a KalCode workspace terminal. Listening processes appear here when native
          observation can attribute them safely.
        </p>
      </EmptyState>
    );
  }
  return (
    <section aria-label="Local development services">
      <div className={styles.sectionToolbar}>
        <div>
          <h2>Local services</h2>
          <p>Observed processes and listening ports attributed to a workspace.</p>
        </div>
      </div>
      <div className={styles.serviceTableWrap}>
        <table className={styles.serviceTable}>
          <thead>
            <tr>
              <th>Service</th>
              <th>Status</th>
              <th>Port / URL</th>
              <th>Process</th>
              <th>Uptime</th>
              <th>Workspace</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {snapshot.services.map((service) => {
              const stopped = service.status !== "running";
              const tone = service.status === "running" ? "working" : service.status === "failed" ? "failed" : "muted";
              return (
                <tr key={service.id}>
                  <td>
                    <strong>{service.name}</strong>
                  </td>
                  <td>
                    <StatusIndicator tone={tone} pulse={service.status === "running"}>
                      {titleCase(service.status)}
                    </StatusIndicator>
                  </td>
                  <td>
                    <div className={styles.endpoints}>
                      {service.urls.map((url) => (
                        <button
                          key={url}
                          type="button"
                          onClick={() => void mutate(`url:${service.id}`, () => client.openUrl(url))}
                        >
                          {url}
                          <ExternalLink />
                        </button>
                      ))}
                      {service.ports.length > 0 ? (
                        <span>{service.ports.map((port) => `:${port}`).join(" · ")}</span>
                      ) : service.urls.length === 0 ? (
                        <span>Not observed</span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <span className={styles.mono}>
                      {service.processName}
                      {service.pid ? ` · PID ${service.pid}` : ""}
                    </span>
                  </td>
                  <td>
                    {service.uptimeSeconds === null
                      ? "Unknown"
                      : durationLabel(new Date(Date.now() - service.uptimeSeconds * 1_000).toISOString(), null)}
                  </td>
                  <td>{service.workspaceName}</td>
                  <td>
                    <div className={styles.serviceActions}>
                      {service.urls[0] ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void mutate(`url:${service.id}`, () => client.openUrl(service.urls[0] as string))
                          }
                        >
                          Open in Browser
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!service.runId && !service.terminalId}
                        onClick={() => (service.runId ? onRun(service.runId) : void onTerminal(service))}
                      >
                        Logs
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void onTerminal(service)}>
                        <TerminalSquare /> Open terminal
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!service.canRestart || busy !== null}
                        title={
                          !service.canRestart
                            ? (service.actionReason ?? "Restart is unavailable for this process.")
                            : undefined
                        }
                        onClick={() =>
                          void mutate(`restart:${service.id}`, () => client.serviceAction(service.id, "restart"))
                        }
                      >
                        <RotateCcw /> Restart
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={!service.canStop || stopped || busy !== null}
                        title={
                          !service.canStop
                            ? (service.actionReason ?? "Stop is unavailable for this process.")
                            : undefined
                        }
                        onClick={() =>
                          void mutate(`stop:${service.id}`, () => client.serviceAction(service.id, "stop"))
                        }
                      >
                        <Square /> Stop
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EnvironmentsView({
  snapshot,
  client,
  onRun,
  mutate,
  workspaceNames,
}: {
  snapshot: OperationsSnapshot;
  client: OperationsApi;
  onRun: (id: string) => void;
  mutate: MutationRunner;
  workspaceNames: ReadonlyMap<string, string>;
}) {
  const workspaceIds = [
    ...new Set([
      ...snapshot.environments.map((environment) => environment.workspaceId),
      ...snapshot.items.map((item) => item.spec.workspaceId),
      ...snapshot.services.map((service) => service.workspaceId),
    ]),
  ];
  if (workspaceIds.length === 0) workspaceIds.push("");
  return (
    <section aria-label="Deployment environments">
      <div className={styles.sectionToolbar}>
        <div>
          <h2>What is live right now?</h2>
          <p>
            Observed deployments, local services, and declared configuration presence. Missing evidence stays unknown.
          </p>
        </div>
      </div>
      <div className={styles.environmentWorkspaces}>
        {workspaceIds.map((environmentWorkspaceId) => {
          const grouped = new Map<OperationEnvironmentKind, OperationEnvironment>();
          for (const environment of snapshot.environments) {
            if (environment.workspaceId === environmentWorkspaceId) grouped.set(environment.kind, environment);
          }
          const inferredName =
            snapshot.items.find((item) => item.spec.workspaceId === environmentWorkspaceId)?.workspaceName ??
            snapshot.services.find((service) => service.workspaceId === environmentWorkspaceId)?.workspaceName;
          const workspaceName =
            workspaceNames.get(environmentWorkspaceId) ??
            inferredName ??
            (environmentWorkspaceId || "Current workspace");
          return (
            <section
              key={environmentWorkspaceId || "empty"}
              className={styles.environmentWorkspace}
              aria-label={`${workspaceName} environments`}
            >
              {workspaceIds.length > 1 ? <h3 className={styles.environmentWorkspaceTitle}>{workspaceName}</h3> : null}
              <div className={styles.environmentGrid}>
                {ENVIRONMENTS.map((kind) => {
                  const environment = grouped.get(kind);
                  const production = kind === "production";
                  return (
                    <article
                      key={kind}
                      className={styles.environment}
                      data-production={production || undefined}
                      aria-label={`${titleCase(kind)} environment`}
                    >
                      <header>
                        <div>
                          <h3>{titleCase(kind)}</h3>
                          {production ? <span>Production</span> : null}
                        </div>
                        <EnvironmentHealth environment={environment} />
                      </header>
                      {!environment ? (
                        <div className={styles.notObserved}>
                          <strong>Not observed</strong>
                          <p>No current deployment or service evidence is available for this environment.</p>
                        </div>
                      ) : (
                        <>
                          <dl className={styles.environmentFacts}>
                            <div>
                              <dt>Branch / version</dt>
                              <dd>
                                {environment.branch ?? "Unknown"}
                                {environment.version ? ` · ${environment.version}` : ""}
                              </dd>
                            </div>
                            <div>
                              <dt>Deployment</dt>
                              <dd>{titleCase(environment.deploymentStatus || "unknown")}</dd>
                            </div>
                            <div>
                              <dt>Platform</dt>
                              <dd>{environment.platform ?? "Not observed"}</dd>
                            </div>
                            <div>
                              <dt>Last deploy</dt>
                              <dd>{timeLabel(environment.lastDeploy)}</dd>
                            </div>
                            <div>
                              <dt>Observed</dt>
                              <dd>{timeLabel(environment.observedAt)}</dd>
                            </div>
                          </dl>
                          <div className={styles.environmentUrls}>
                            <h4>
                              URLs <span>unverified</span>
                            </h4>
                            {environment.urls.length === 0 ? (
                              <span>No URL observed</span>
                            ) : (
                              environment.urls.map((url) => (
                                <Button
                                  key={url}
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    void mutate(`url:${environment.workspaceId}:${url}`, () => client.openUrl(url))
                                  }
                                >
                                  <ExternalLink /> {url}
                                </Button>
                              ))
                            )}
                          </div>
                          <div className={styles.variables}>
                            <h4>Configuration</h4>
                            {environment.variables.length === 0 ? (
                              <p>No variable names reported.</p>
                            ) : (
                              <ul>
                                {environment.variables.map((variable) => (
                                  <li key={variable.name}>
                                    <code>{variable.name}</code>
                                    <span
                                      data-state={
                                        variable.present === true
                                          ? "present"
                                          : variable.present === false
                                            ? "missing"
                                            : "unknown"
                                      }
                                    >
                                      {variable.present === true
                                        ? "Present"
                                        : variable.present === false
                                          ? "Missing"
                                          : "Unknown"}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                          {environment.notes.map((note) => (
                            <p key={note} className={styles.environmentNote}>
                              {note}
                            </p>
                          ))}
                          {environment.runId ? (
                            <Button size="sm" variant="secondary" onClick={() => onRun(environment.runId as string)}>
                              Open deployment run
                            </Button>
                          ) : null}
                        </>
                      )}
                      {production ? (
                        <p className={styles.productionNote}>
                          Production changes use native admission and confirmation before execution.
                        </p>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function EnvironmentHealth({ environment }: { environment?: OperationEnvironment }) {
  if (!environment) return <StatusIndicator tone="muted">Not observed</StatusIndicator>;
  const health = environment.health.toLowerCase();
  const tone =
    health === "healthy" || health === "live"
      ? "working"
      : health === "failed" || health === "unhealthy"
        ? "failed"
        : "muted";
  return <StatusIndicator tone={tone}>{titleCase(environment.health || "unknown")}</StatusIndicator>;
}

function ActivityView({ snapshot, onRun }: { snapshot: OperationsSnapshot; onRun: (id: string) => void }) {
  const [range, setRange] = useState<ActivityRange>("today");
  const [selection, setSelection] = useState<{ area?: string; bin?: number } | null>(null);
  const heatmap = useMemo(
    () => buildActivityHeatmap(snapshot.activity, snapshot.items, range),
    [range, snapshot.activity, snapshot.items],
  );
  const selectedEvents = heatmap.events
    .filter((event) => !selection?.area || (event.area.trim() || "Project") === selection.area)
    .filter(
      (event) =>
        selection?.bin === undefined ||
        (Date.parse(event.at) >= (heatmap.bins[selection.bin]?.start ?? 0) &&
          Date.parse(event.at) < (heatmap.bins[selection.bin]?.end ?? 0)),
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return (
    <section className={styles.activityView} aria-label="Project activity">
      <div className={styles.activityHero}>
        <div className={styles.activityHeading}>
          <div>
            <h2>Activity heatmap</h2>
            <p>Where agents, files, commits, tests, builds, deploys, and failures are changing the project.</p>
          </div>
          <fieldset className={styles.rangeControl}>
            <legend className="visually-hidden">Activity range</legend>
            {(["1h", "today", "7d", "release"] as ActivityRange[]).map((value) => (
              <button
                key={value}
                type="button"
                data-active={range === value || undefined}
                onClick={() => {
                  setRange(value);
                  setSelection(null);
                }}
              >
                {value === "today" ? "Today" : value === "release" ? "Release" : value}
              </button>
            ))}
          </fieldset>
        </div>
        {heatmap.rangeNote ? <p className={styles.rangeNote}>{heatmap.rangeNote}</p> : null}
        {heatmap.rows.length === 0 ? (
          <EmptyState framed={false} art={<Activity />} title="No activity in this range">
            <p>There is no observed execution evidence to plot.</p>
          </EmptyState>
        ) : (
          <div className={styles.heatmapScroll}>
            <div
              className={styles.heatmap}
              style={{
                gridTemplateColumns: `minmax(8rem, 12rem) repeat(${heatmap.bins.length}, minmax(1.25rem, 1fr))`,
              }}
            >
              <div className={styles.heatmapCorner}>Project area</div>
              {heatmap.bins.map((bin) => (
                <div key={bin.key} className={styles.binLabel} title={bin.label}>
                  {bin.label}
                </div>
              ))}
              {heatmap.rows.flatMap((row) => [
                <button
                  key={`${row.area}:label`}
                  type="button"
                  className={styles.areaLabel}
                  data-selected={selection?.area === row.area || undefined}
                  onClick={() => setSelection({ area: row.area })}
                >
                  <span>{row.area}</span>
                  <strong>{row.total}</strong>
                </button>,
                ...row.counts.map((count, index) => (
                  <button
                    key={`${row.area}:${heatmap.bins[index]?.key}`}
                    type="button"
                    className={styles.heatCell}
                    data-level={activityLevel(count, heatmap.max)}
                    aria-label={`${row.area}, ${heatmap.bins[index]?.label}: ${count} events`}
                    title={`${row.area} · ${heatmap.bins[index]?.label} · ${count} events`}
                    onClick={() => setSelection({ area: row.area, bin: index })}
                  />
                )),
              ])}
            </div>
          </div>
        )}
      </div>
      <div className={styles.activityFeed}>
        <header>
          <h3>{selection ? "Selected activity" : "Latest activity"}</h3>
          {selection ? (
            <Button size="sm" variant="ghost" onClick={() => setSelection(null)}>
              Clear filter
            </Button>
          ) : null}
        </header>
        {selectedEvents.length === 0 ? (
          <p>No events in this selection.</p>
        ) : (
          <ol>
            {selectedEvents.slice(0, 100).map((event) => (
              <ActivityEvent key={event.id} event={event} onRun={onRun} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function ActivityEvent({ event, onRun }: { event: OperationActivity; onRun: (id: string) => void }) {
  return (
    <li>
      <span className={styles.activityGlyph} aria-hidden="true">
        <Activity />
      </span>
      <span>
        <strong>{event.name}</strong>
        <small>
          {titleCase(event.kind)} · {event.area} · {timeLabel(event.at)}
        </small>
      </span>
      {event.runId ? (
        <Button size="sm" variant="ghost" onClick={() => onRun(event.runId as string)}>
          Open run
        </Button>
      ) : null}
    </li>
  );
}

function RunDetail({
  client,
  id,
  snapshot,
  busy,
  mutate,
  refreshKey,
  onClose,
}: {
  client: OperationsApi;
  id: string;
  snapshot: OperationsSnapshot;
  busy: string | null;
  mutate: MutationRunner;
  refreshKey: string;
  onClose: () => void;
}) {
  const loader = useMemo(
    () => ({ client, id, active: false, inFlight: false, pending: null as string | null, request: 0 }),
    [client, id],
  );
  const [detail, setDetail] = useState<{ owner: object; id: string; value: OperationDetail } | null>(null);
  const [error, setError] = useState<{ owner: object; message: string } | null>(null);
  const [tab, setTab] = useState<DetailTab>("overview");

  const pump = useCallback(() => {
    if (!loader.active || loader.inFlight || loader.pending === null) return;
    const requestedKey = loader.pending;
    loader.pending = null;
    loader.inFlight = true;
    const current = ++loader.request;
    setError(null);
    void loader.client
      .detail(loader.id)
      .then(
        (value) => {
          if (loader.active && current === loader.request) setDetail({ owner: loader, id: loader.id, value });
        },
        (caught: unknown) => {
          if (loader.active && current === loader.request) {
            setError({
              owner: loader,
              message: caught instanceof Error ? caught.message : "Run details are unavailable.",
            });
          }
        },
      )
      .finally(() => {
        if (!loader.active || current !== loader.request) return;
        loader.inFlight = false;
        if (loader.pending !== null && loader.pending !== requestedKey) queueMicrotask(pump);
      });
  }, [loader]);

  useEffect(() => {
    loader.active = true;
    return () => {
      loader.active = false;
      loader.pending = null;
    };
  }, [loader]);

  useEffect(() => {
    loader.pending = refreshKey;
    pump();
  }, [loader, pump, refreshKey]);

  const value = detail?.owner === loader && detail.id === id ? detail.value : null;
  const errorMessage = error?.owner === loader ? error.message : null;
  return (
    <aside className={styles.detail} aria-label="Run details">
      <header className={styles.detailHeader}>
        <div>
          <span className={styles.detailKind}>{value ? titleCase(value.run.spec.kind) : "Run"}</span>
          <h2>{value?.run.spec.name ?? "Loading run…"}</h2>
          {value ? status(value.run) : null}
        </div>
        {value?.run.source === "operations" && isActiveRun(value.run) ? (
          <Button
            size="sm"
            variant="danger"
            disabled={busy !== null}
            busy={busy === `cancel:${id}`}
            onClick={() => void mutate(`cancel:${id}`, () => client.cancel(id))}
          >
            Cancel run
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" aria-label="Close run details" onClick={onClose}>
          <X />
        </Button>
      </header>
      {!value && !errorMessage ? (
        <div className={styles.detailLoading} aria-busy="true">
          <Skeleton width="100%" height="8rem" />
          <Skeleton width="100%" height="16rem" />
        </div>
      ) : null}
      {errorMessage ? (
        <ErrorState framed={false} title="Run details unavailable">
          {errorMessage}
        </ErrorState>
      ) : null}
      {value ? (
        <Tabs value={tab} onValueChange={(next) => setTab(next as DetailTab)}>
          <TabsList className={styles.detailTabs} aria-label="Run evidence">
            {(["overview", "logs", "timeline", "files", "artifacts", "tests"] as DetailTab[]).map((value) => (
              <TabsTrigger key={value} value={value}>
                {titleCase(value)}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className={styles.detailBody}>
            {tab === "overview" ? <RunOverview detail={value} snapshot={snapshot} /> : null}
            {tab === "logs" ? (
              value.logs ? (
                <pre className={styles.logs} data-selectable>
                  {value.logs}
                </pre>
              ) : (
                <EvidenceEmpty label="No logs were captured for this run." />
              )
            ) : null}
            {tab === "timeline" ? (
              value.timeline.length > 0 ? (
                <ol className={styles.timeline}>
                  {value.timeline.map((moment) => (
                    <li key={moment.id}>
                      <span />
                      <div>
                        <strong>{moment.message}</strong>
                        <small>
                          {titleCase(moment.kind)} · {timeLabel(moment.at)}
                        </small>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <EvidenceEmpty label="No timeline events were recorded." />
              )
            ) : null}
            {tab === "files" ? (
              value.files.length > 0 ? (
                <ul className={styles.evidenceList}>
                  {value.files.map((file) => (
                    <li key={file}>
                      <FileCode2 />
                      <code data-selectable>{file}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <EvidenceEmpty label="No changed files were reported." />
              )
            ) : null}
            {tab === "artifacts" ? (
              value.artifacts.length > 0 ? (
                <ul className={styles.evidenceList}>
                  {value.artifacts.map((artifact) => (
                    <li key={`${artifact.kind}:${artifact.location}`}>
                      <Box />
                      <span>
                        <strong>{artifact.name}</strong>
                        <small>
                          {titleCase(artifact.kind)} · <code data-selectable>{artifact.location}</code>
                        </small>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EvidenceEmpty label="No artifacts were reported." />
              )
            ) : null}
            {tab === "tests" ? (
              value.tests.length > 0 ? (
                <ul className={styles.testList}>
                  {value.tests.map((test) => (
                    <li key={test.name}>
                      <StatusIndicator
                        tone={
                          test.status === "passed" || test.status === "succeeded"
                            ? "done"
                            : test.status === "failed"
                              ? "failed"
                              : "muted"
                        }
                      >
                        {titleCase(test.status)}
                      </StatusIndicator>
                      <span>
                        <strong>{test.name}</strong>
                        <small>{test.detail}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EvidenceEmpty label="No test results were attached." />
              )
            ) : null}
          </div>
        </Tabs>
      ) : null}
    </aside>
  );
}

function RunOverview({ detail, snapshot }: { detail: OperationDetail; snapshot: OperationsSnapshot }) {
  const run = detail.run;
  // Relationships are projections of the current canonical snapshot, never copied run state.
  const currentServices = snapshot.services.filter(
    (service) => service.runId === run.id && service.workspaceId === run.spec.workspaceId,
  );
  const currentEnvironments = snapshot.environments.filter(
    (environment) => environment.runId === run.id && environment.workspaceId === run.spec.workspaceId,
  );
  const activity = snapshot.activity.filter(
    (event) => event.runId === run.id && event.workspaceId === run.spec.workspaceId,
  );
  const services = [
    ...currentServices.map((service) => ({ service, isCurrent: true })),
    ...(detail.relatedServices ?? []).filter(
      ({ service, isCurrent }) =>
        !isCurrent &&
        service.runId === run.id &&
        service.workspaceId === run.spec.workspaceId &&
        !currentServices.some((current) => current.id === service.id),
    ),
  ];
  const environments = [
    ...currentEnvironments.map((environment) => ({ environment, isCurrent: true })),
    ...(detail.relatedDeployments ?? []).filter(
      ({ environment, isCurrent }) =>
        !isCurrent &&
        environment.runId === run.id &&
        environment.workspaceId === run.spec.workspaceId &&
        !currentEnvironments.some((current) => current.kind === environment.kind),
    ),
  ];
  return (
    <div className={styles.overview}>
      <Metadata record={run} />
      <section>
        <h3>Current action</h3>
        <p>
          {run.currentAction ??
            (run.status === "unknown" ? "Current action unavailable." : "No current action reported.")}
        </p>
      </section>
      <section>
        <h3>Final result</h3>
        <p>
          {run.outcome ??
            (run.status === "unknown"
              ? "Completion evidence unavailable."
              : run.endedAt
                ? "No final result was reported."
                : "Run has not finished.")}
        </p>
      </section>
      <section>
        <h3>Execution</h3>
        <dl className={styles.metadata}>
          <div>
            <dt>Source</dt>
            <dd>{titleCase(run.source)}</dd>
          </div>
          <div>
            <dt>Environment</dt>
            <dd>{titleCase(run.spec.environment)}</dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>{run.spec.priority}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{run.version ?? "Not observed"}</dd>
          </div>
        </dl>
      </section>
      <section aria-label="Run services">
        <h3>Services</h3>
        {services.length ? (
          <ul className={styles.evidenceList}>
            {services.map(({ service, isCurrent }) => (
              <li key={service.id}>
                <Server aria-hidden="true" />
                <span>
                  <strong>{service.name}</strong>
                  <small>{isCurrent ? "Current observation" : "Historical execution · not a live-service claim"}</small>
                  <small>
                    {titleCase(service.status)}
                    {service.ports.length ? ` · Ports ${service.ports.join(", ")}` : " · No listening port observed"}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No service evidence is linked to this run.</p>
        )}
      </section>
      <section aria-label="Run environments">
        <h3>Environments</h3>
        {environments.length ? (
          <ul className={styles.evidenceList}>
            {environments.map(({ environment, isCurrent }) => (
              <li key={environment.kind}>
                <span>
                  <strong>{titleCase(environment.kind)}</strong>
                  <small>
                    {isCurrent ? "Current environment" : "Recorded deployment outcome · not current environment state"}
                  </small>
                  <small>{titleCase(environment.deploymentStatus)}</small>
                  <small>Health: {titleCase(environment.health)}</small>
                  <small>
                    {environment.branch ?? "Branch not observed"} · {environment.version ?? "Version not observed"}
                  </small>
                  {environment.urls.map((url) => (
                    <small key={url}>
                      Declared target: <code data-selectable>{url}</code>
                    </small>
                  ))}
                  {environment.notes.map((note) => (
                    <small key={note}>{note}</small>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No environment evidence is linked to this run.</p>
        )}
      </section>
      <section aria-label="Run activity">
        <h3>Activity</h3>
        {activity.length ? (
          <ul className={styles.evidenceList}>
            {activity.slice(0, 10).map((event) => (
              <li key={event.id}>
                <span>
                  <strong>{event.name}</strong>
                  <small>
                    {event.area} · {timeLabel(event.at)}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No linked activity appears in the current observation window.</p>
        )}
        {activity.length > 10 ? (
          <p>Showing the latest 10 linked events. Open Activity for the full observation window.</p>
        ) : null}
      </section>
      {detail.notes.length > 0 ? (
        <section>
          <h3>Notes</h3>
          <ul>
            {detail.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function EvidenceEmpty({ label }: { label: string }) {
  return (
    <div className={styles.evidenceEmpty}>
      <Clock3 aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}
