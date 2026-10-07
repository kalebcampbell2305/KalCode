import type { OperationEnvironment, OperationRecord, OperationStatus } from "@kalcode/protocol";
import { Button, ProviderGlyph, Skeleton, StatusIndicator } from "@kalcode/ui/components";
import {
  Activity,
  AudioLines,
  BellDot,
  Bot,
  Boxes,
  CircleCheckBig,
  Clock3,
  ExternalLink,
  Gauge,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  Play,
  Server,
  TestTube2,
  TriangleAlert,
} from "lucide-react";
import { useMemo } from "react";
import { STATE_LABELS, usageLine } from "../../kalvoice/assistantState.ts";
import { useOptionalKalVoice } from "../../kalvoice/KalVoiceProvider.tsx";
import { focusOperationsTarget, type OperationsVoiceTarget } from "../../kalvoice/sceneOperations.ts";
import { useKalActions } from "../../runtime/actions.ts";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { fleetCounts } from "../../surfaces/dashboard/data/board.ts";
import { useCodingAgents } from "../../surfaces/dashboard/data/DashboardData.tsx";
import {
  filteredSnapshot,
  isActiveRun,
  operationDurationLabel,
  operationStatusLabel,
  queueSections,
} from "../../surfaces/operations/model.ts";
import { useOperationIdentity } from "../../surfaces/operations/operationIdentity.ts";
import { UsageMeter } from "../../surfaces/providers/AccountUsageBadge.tsx";
import {
  accountFullLabel,
  accountName,
  accountSignIn,
  sortAccounts,
} from "../../surfaces/providers/accountIdentity.ts";
import { notChecked, usageSummary } from "../../surfaces/providers/accountUsage.ts";
import { useOptionalProviderAccountSessions } from "../../surfaces/providers/ProviderAccountSessions.tsx";
import { openProviderAccounts } from "../../surfaces/providers/providersTab.ts";
import { AttentionList } from "../attention/AttentionList.tsx";
import { useAttention } from "../attention/useAttention.ts";
import { useNavigation } from "../navigation.tsx";
import { ActivityWidget } from "../widgets/widgets/ActivityWidget.tsx";
import { useDeckData } from "./DeckData.tsx";
import styles from "./DockSurfaces.module.css";
import { ENVIRONMENT_LABELS, environmentTone, humanize } from "./deckModel.ts";

export type DockSurfaceId =
  | "dashboard"
  | "needs-you"
  | "runs"
  | "queue"
  | "services"
  | "environments"
  | "activity"
  | "provider-usage"
  | "kalvoice"
  | "git"
  | "tests";

export interface DockSurfaceMeta {
  id: DockSurfaceId;
  label: string;
  icon: LucideIcon;
  /** A surface flag that must be usable before the item may be offered. */
  requires?: "dashboard" | "operations" | "kalvoice" | "providers";
}

/** Dock views backed by existing shell-lifetime authorities. Agents and Browser are owned by the dock frame. */
export const DOCK_SURFACE_META: readonly DockSurfaceMeta[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, requires: "dashboard" },
  { id: "needs-you", label: "Needs You", icon: BellDot, requires: "dashboard" },
  { id: "runs", label: "Runs", icon: Play, requires: "operations" },
  { id: "queue", label: "Queue", icon: ListChecks, requires: "operations" },
  { id: "services", label: "Services", icon: Server, requires: "operations" },
  { id: "environments", label: "Environments", icon: Boxes, requires: "operations" },
  { id: "activity", label: "Activity", icon: Activity, requires: "dashboard" },
  { id: "provider-usage", label: "Provider Usage", icon: Gauge, requires: "providers" },
  { id: "kalvoice", label: "KalVoice Usage", icon: AudioLines, requires: "kalvoice" },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "tests", label: "Tests / Build", icon: TestTube2, requires: "operations" },
] as const;

export interface DockSurfaceProps {
  id: DockSurfaceId;
  /** The dock's project; null (no project open) shows every workspace. */
  workspaceId: string | null;
  onOpenBrowser: (url?: string | null) => void;
}

export function DockSurface({ id, workspaceId, onOpenBrowser }: DockSurfaceProps) {
  switch (id) {
    case "dashboard":
      return <MissionControl workspaceId={workspaceId} onOpenBrowser={onOpenBrowser} />;
    case "needs-you":
      return <NeedsYou />;
    case "runs":
      return <Runs workspaceId={workspaceId} />;
    case "queue":
      return <Queue workspaceId={workspaceId} />;
    case "services":
      return <Services workspaceId={workspaceId} onOpenBrowser={onOpenBrowser} />;
    case "environments":
      return <Environments workspaceId={workspaceId} onOpenBrowser={onOpenBrowser} />;
    case "activity":
      return <ActivitySurface />;
    case "provider-usage":
      return <ProviderUsage />;
    case "kalvoice":
      return <KalVoiceSurface />;
    case "git":
      return <GitSurface workspaceId={workspaceId} />;
    case "tests":
      return <TestsAndBuild workspaceId={workspaceId} />;
  }
}

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

function useWorkspaceOperations(workspaceId: string | null) {
  const { operations } = useDeckData();
  return {
    snapshot: useMemo(
      () => (operations.data ? filteredSnapshot(operations.data, workspaceId ?? "") : null),
      [operations.data, workspaceId],
    ),
    failed: operations.failed,
  };
}

function Loading({ label }: { label: string }) {
  return (
    <div className={styles.loading} role="status" aria-busy="true">
      <span className="visually-hidden">Loading {label}</span>
      <Skeleton width="68%" />
      <Skeleton width="92%" height="3.25rem" />
      <Skeleton width="84%" height="3.25rem" />
    </div>
  );
}

function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: string }) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon} aria-hidden="true">
        <Icon />
      </span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

function FeedNotice({ failed }: { failed: boolean }) {
  return failed ? (
    <p className={styles.notice} role="status">
      <TriangleAlert aria-hidden="true" /> Refresh failed. Showing the last observed state.
    </p>
  ) : null;
}

function openOperations(navigate: (destination: "operations") => void, target: OperationsVoiceTarget) {
  navigate("operations");
  void focusOperationsTarget(target);
}

function MissionControl({ workspaceId, onOpenBrowser }: Pick<DockSurfaceProps, "workspaceId" | "onOpenBrowser">) {
  const agents = useCodingAgents().state;
  const attention = useAttention();
  const actions = useKalActions();
  const navigation = useNavigation();
  const { snapshot, failed } = useWorkspaceOperations(workspaceId);
  const workspaces = useWorkspaces();
  const workspace = workspaces.workspaces.find((candidate) => candidate.id === workspaceId);
  const counts =
    agents.status === "ready"
      ? fleetCounts(agents.data.filter((agent) => workspaceId === null || agent.workspaceId === workspaceId))
      : null;
  const running = snapshot?.items.filter(isActiveRun).length ?? 0;
  const failedRuns = snapshot?.items.filter((run) => run.status === "failed").length ?? 0;
  const live = snapshot?.services.filter((service) => service.status === "running") ?? [];
  const checks = snapshot ? latestChecks(snapshot.items) : [];
  const environment = [...(snapshot?.environments ?? [])]
    .filter((item) => item.kind === "local" || item.runId !== null)
    .sort(
      (a, b) =>
        ["local", "preview", "staging", "production"].indexOf(b.kind) -
        ["local", "preview", "staging", "production"].indexOf(a.kind),
    )[0];

  return (
    <div className={styles.surface}>
      <header className={styles.hero}>
        <span>Workspace pulse</span>
        <h2>{workspace?.name ?? "Current workspace"}</h2>
        <p>Live control signals beside your terminals.</p>
      </header>
      <div className={styles.metrics}>
        <button type="button" onClick={() => void actions.open("dashboard")}>
          <Bot aria-hidden="true" />
          <strong>{counts?.working ?? 0}</strong>
          <span>working</span>
        </button>
        <button
          type="button"
          data-tone={attention.items.length > 0 ? "waiting" : undefined}
          onClick={actions.openInbox}
        >
          <BellDot aria-hidden="true" />
          <strong>{attention.ready ? attention.items.length : "…"}</strong>
          <span>need you</span>
        </button>
        <button type="button" onClick={() => openOperations(navigation.navigate, { kind: "tab", tab: "runs" })}>
          <Play aria-hidden="true" />
          <strong>{running}</strong>
          <span>runs</span>
        </button>
        <button
          type="button"
          data-tone={failedRuns > 0 ? "failed" : undefined}
          onClick={() => openOperations(navigation.navigate, { kind: "tab", tab: "runs" })}
        >
          <TriangleAlert aria-hidden="true" />
          <strong>{failedRuns}</strong>
          <span>failed</span>
        </button>
      </div>
      {live.length > 0 ? (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h3>Live services</h3>
            <span>{live.length}</span>
          </div>
          <ul className={styles.rows}>
            {live.slice(0, 3).map((service) => (
              <li key={service.id} className={styles.row}>
                <span className={styles.rowIcon} data-tone="working">
                  <Server />
                </span>
                <span className={styles.rowCopy}>
                  <strong>{service.name}</strong>
                  <small>{service.ports[0] ? `localhost:${service.ports[0]}` : service.processName}</small>
                </span>
                {service.urls[0] ? (
                  <Button size="sm" variant="ghost" onClick={() => onOpenBrowser(service.urls[0])}>
                    Browser
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {environment ? (
        <button
          type="button"
          className={styles.environmentCard}
          onClick={() =>
            openOperations(navigation.navigate, {
              kind: "environment",
              tab: "environments",
              environment: environment.kind,
              workspaceId,
              label: ENVIRONMENT_LABELS[environment.kind],
            })
          }
        >
          <span>
            <Boxes aria-hidden="true" />
            Environment
          </span>
          <strong>{ENVIRONMENT_LABELS[environment.kind]}</strong>
          <StatusIndicator tone={environmentTone(environment)}>{humanize(environment.health)}</StatusIndicator>
        </button>
      ) : null}
      {checks.length > 0 ? (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h3>Tests &amp; builds</h3>
            <span>{checks.length}</span>
          </div>
          <OperationRows items={checks} empty="No test or build runs" />
        </section>
      ) : null}
      <AccountHealth />
      <FeedNotice failed={failed} />
    </div>
  );
}

/** Account health in one line: canonical session state first, then any running low (weekly left). */
function AccountHealth() {
  const sessions = useOptionalProviderAccountSessions();
  const navigation = useNavigation();
  const accounts = sessions?.accounts;
  if (!sessions || !accounts || accounts.length === 0) return null;
  const accountStates = sortAccounts(accounts).map((account) => ({
    account,
    health: sessions.states.get(account.id)?.health,
  }));
  const signedOut = accountStates.filter(({ health }) => health?.state === "expired");
  const unsettled = accountStates.filter(
    ({ health }) => health === undefined || (health.state !== "connected" && health.state !== "expired"),
  );
  const low = sortAccounts(accounts).filter(
    (account) => usageSummary(sessions.usage.get(account.id) ?? notChecked(account.id)).low,
  );
  const tone =
    signedOut.length > 0 || unsettled.some(({ health }) => health?.state === "error")
      ? "failed"
      : unsettled.length > 0 || low.length > 0
        ? "waiting"
        : "done";
  const line =
    signedOut.length > 0
      ? `${signedOut.length} ${signedOut.length === 1 ? "account needs" : "accounts need"} sign-in`
      : unsettled.length > 0
        ? unsettled
            .slice(0, 2)
            .map(({ account, health }) => `${accountName(account)} · ${health?.label ?? "Not checked"}`)
            .join(", ")
        : low.length > 0
          ? low
              .slice(0, 2)
              .map(
                (account) =>
                  `${accountName(account)} · ${usageSummary(sessions.usage.get(account.id) ?? notChecked(account.id)).short}`,
              )
              .join(", ")
          : `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"} ready`;
  return (
    <button
      type="button"
      className={styles.environmentCard}
      onClick={() => {
        const first = signedOut[0]?.account ?? unsettled[0]?.account ?? low[0];
        if (first) openProviderAccounts({ providerId: first.providerId, accountId: first.id });
        navigation.navigate("providers");
      }}
    >
      <span>
        <Gauge aria-hidden="true" />
        Accounts
      </span>
      <strong>{line}</strong>
      <StatusIndicator tone={tone}>
        {signedOut.length > 0
          ? "Sign-in needed"
          : unsettled.length > 0
            ? (unsettled[0]?.health?.label ?? "Not checked")
            : low.length > 0
              ? "Low"
              : "Healthy"}
      </StatusIndicator>
    </button>
  );
}

function NeedsYou() {
  const attention = useAttention();
  return (
    <div className={styles.scroller}>
      <AttentionList
        items={attention.items}
        ready={attention.ready}
        compact
        emptyHint="You're clear. New questions, failures and approvals appear here immediately."
      />
    </div>
  );
}

function sortRuns(items: readonly OperationRecord[]): OperationRecord[] {
  return [...items].sort((a, b) => Date.parse(b.startedAt ?? b.createdAt) - Date.parse(a.startedAt ?? a.createdAt));
}

function OperationIdentityLine({ record }: { record: OperationRecord }) {
  const identity = useOperationIdentity(record);
  const providerId = record.observedProviderId ?? record.spec.providerId;
  return providerId ? <small title={identity.detail}>{identity.compact}</small> : null;
}

function OperationRows({ items, empty }: { items: readonly OperationRecord[]; empty: string }) {
  const navigation = useNavigation();
  if (items.length === 0)
    return (
      <Empty icon={CircleCheckBig} title={empty}>
        New work appears here from the canonical Operations timeline.
      </Empty>
    );
  return (
    <ul className={styles.rows}>
      {items.map((run) => (
        <li key={run.id}>
          <button
            type="button"
            className={styles.rowButton}
            onClick={() =>
              openOperations(navigation.navigate, {
                kind: "run",
                tab: "runs",
                runId: run.id,
                workspaceId: run.spec.workspaceId,
                label: run.spec.name,
              })
            }
          >
            <span className={styles.rowIcon} data-tone={STATUS_TONE[run.status]}>
              {run.spec.kind === "test" ? <TestTube2 /> : <Activity />}
            </span>
            <span className={styles.rowCopy}>
              <strong>{run.spec.name}</strong>
              <small>{run.currentAction ?? run.outcome ?? operationDurationLabel(run)}</small>
              <OperationIdentityLine record={run} />
            </span>
            <span className={styles.rowState}>
              <StatusIndicator tone={STATUS_TONE[run.status]} pulse={isActiveRun(run)}>
                {operationStatusLabel(run.status)}
              </StatusIndicator>
              <small>{operationDurationLabel(run)}</small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Runs({ workspaceId }: { workspaceId: string | null }) {
  const { snapshot, failed } = useWorkspaceOperations(workspaceId);
  if (!snapshot)
    return failed ? (
      <Empty icon={TriangleAlert} title="Runs unavailable">
        KalCode couldn't read Operations right now.
      </Empty>
    ) : (
      <Loading label="runs" />
    );
  const runs = sortRuns(snapshot.items.filter((item) => item.startedAt !== null || isActiveRun(item))).slice(0, 30);
  return (
    <div className={styles.surface}>
      <FeedNotice failed={failed} />
      <OperationRows items={runs} empty="No runs yet" />
    </div>
  );
}

function Queue({ workspaceId }: { workspaceId: string | null }) {
  const { snapshot, failed } = useWorkspaceOperations(workspaceId);
  const navigation = useNavigation();
  if (!snapshot)
    return failed ? (
      <Empty icon={TriangleAlert} title="Queue unavailable">
        KalCode couldn't read Operations right now.
      </Empty>
    ) : (
      <Loading label="queue" />
    );
  const sections = queueSections(snapshot.items);
  const groups = [
    ["Running now", sections.now],
    ["Next", sections.next],
    ["Later", sections.later],
  ] as const;
  if (groups.every(([, items]) => items.length === 0))
    return (
      <Empty icon={ListChecks} title="Queue is clear">
        Queued and blocked work appears here.
      </Empty>
    );
  return (
    <div className={styles.surface}>
      <FeedNotice failed={failed} />
      {groups.map(([label, items]) =>
        items.length > 0 ? (
          <section key={label} className={styles.section}>
            <div className={styles.sectionHead}>
              <h3>{label}</h3>
              <span>{items.length}</span>
            </div>
            <ul className={styles.rows}>
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={styles.rowButton}
                    onClick={() =>
                      openOperations(navigation.navigate, {
                        kind: "queue",
                        tab: "queue",
                        runId: item.id,
                        workspaceId: item.spec.workspaceId,
                        label: item.spec.name,
                      })
                    }
                  >
                    <span className={styles.rowIcon} data-tone={STATUS_TONE[item.status]}>
                      <Clock3 />
                    </span>
                    <span className={styles.rowCopy}>
                      <strong>{item.spec.name}</strong>
                      <small>{item.blockers[0] ?? item.currentAction ?? item.spec.lane}</small>
                      <OperationIdentityLine record={item} />
                    </span>
                    <StatusIndicator tone={STATUS_TONE[item.status]}>
                      {operationStatusLabel(item.status)}
                    </StatusIndicator>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}

function Services({ workspaceId, onOpenBrowser }: Pick<DockSurfaceProps, "workspaceId" | "onOpenBrowser">) {
  const { snapshot, failed } = useWorkspaceOperations(workspaceId);
  const navigation = useNavigation();
  if (!snapshot)
    return failed ? (
      <Empty icon={TriangleAlert} title="Services unavailable">
        KalCode couldn't read Operations right now.
      </Empty>
    ) : (
      <Loading label="services" />
    );
  if (snapshot.services.length === 0)
    return (
      <Empty icon={Server} title="No services detected">
        Local servers and observed processes appear here.
      </Empty>
    );
  return (
    <div className={styles.surface}>
      <FeedNotice failed={failed} />
      <ul className={styles.cards}>
        {snapshot.services.map((service) => (
          <li key={service.id} className={styles.serviceCard}>
            <button
              type="button"
              className={styles.cardMain}
              onClick={() =>
                openOperations(navigation.navigate, {
                  kind: "service",
                  tab: "services",
                  serviceId: service.id,
                  workspaceId: service.workspaceId,
                  label: service.name,
                })
              }
            >
              <span
                className={styles.rowIcon}
                data-tone={service.status === "running" ? "working" : service.status === "failed" ? "failed" : "muted"}
              >
                <Server />
              </span>
              <span className={styles.rowCopy}>
                <strong>{service.name}</strong>
                <small>
                  {[service.processName, service.ports.map((port) => `:${port}`).join(", ")]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
              <StatusIndicator
                tone={service.status === "running" ? "working" : service.status === "failed" ? "failed" : "muted"}
                pulse={service.status === "running"}
              >
                {humanize(service.status)}
              </StatusIndicator>
            </button>
            {service.urls[0] ? (
              <Button size="sm" variant="ghost" icon={<ExternalLink />} onClick={() => onOpenBrowser(service.urls[0])}>
                Open Browser
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Environments({ workspaceId, onOpenBrowser }: Pick<DockSurfaceProps, "workspaceId" | "onOpenBrowser">) {
  const { snapshot, failed } = useWorkspaceOperations(workspaceId);
  const navigation = useNavigation();
  if (!snapshot)
    return failed ? (
      <Empty icon={TriangleAlert} title="Environments unavailable">
        KalCode couldn't read Operations right now.
      </Empty>
    ) : (
      <Loading label="environments" />
    );
  const order: OperationEnvironment["kind"][] = ["local", "preview", "staging", "production"];
  const environments = [...snapshot.environments].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  if (environments.length === 0)
    return (
      <Empty icon={Boxes} title="No environments observed">
        Local, Preview and Production state appears only after Operations observes it.
      </Empty>
    );
  return (
    <div className={styles.surface}>
      <FeedNotice failed={failed} />
      <ul className={styles.cards}>
        {environments.map((environment) => (
          <li key={`${environment.workspaceId}:${environment.kind}`} className={styles.environmentRow}>
            <button
              type="button"
              className={styles.cardMain}
              onClick={() =>
                openOperations(navigation.navigate, {
                  kind: "environment",
                  tab: "environments",
                  environment: environment.kind,
                  workspaceId,
                  label: ENVIRONMENT_LABELS[environment.kind],
                })
              }
            >
              <span className={styles.rowIcon} data-tone={environmentTone(environment)}>
                <Boxes />
              </span>
              <span className={styles.rowCopy}>
                <strong>{ENVIRONMENT_LABELS[environment.kind]}</strong>
                <small>
                  {[environment.version, humanize(environment.deploymentStatus)].filter(Boolean).join(" · ")}
                </small>
              </span>
              <StatusIndicator tone={environmentTone(environment)}>{humanize(environment.health)}</StatusIndicator>
            </button>
            {environment.urls[0] ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<ExternalLink />}
                onClick={() => onOpenBrowser(environment.urls[0])}
              >
                Open Browser
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActivitySurface() {
  return (
    <div className={styles.activity}>
      <ActivityWidget />
    </div>
  );
}

function ProviderUsage() {
  const sessions = useOptionalProviderAccountSessions();
  const navigation = useNavigation();
  if (!sessions || (sessions.accounts === null && !sessions.loadError)) return <Loading label="provider usage" />;
  if (sessions.accounts === null)
    return (
      <Empty icon={TriangleAlert} title="Accounts unavailable">
        {sessions.loadError ?? "KalCode couldn't read provider accounts."}
      </Empty>
    );
  if (sessions.accounts.length === 0)
    return (
      <Empty icon={Gauge} title="No provider accounts">
        Connect an account to see its provider-reported weekly usage.
      </Empty>
    );
  return (
    <div className={styles.surface}>
      <ul className={styles.usageList}>
        {sortAccounts(sessions.accounts).map((account) => {
          const usage = sessions.usage.get(account.id) ?? notChecked(account.id);
          const session = sessions.states.get(account.id)?.health;
          return (
            <li key={account.id}>
              <button
                type="button"
                onClick={() => {
                  openProviderAccounts({ providerId: account.providerId, accountId: account.id });
                  navigation.navigate("providers");
                }}
              >
                <ProviderGlyph provider={account.providerId} size="sm" />
                <span className={styles.rowCopy}>
                  <strong>{accountFullLabel(account)}</strong>
                  <small>
                    {session?.state === "connected"
                      ? (usage.plan ?? "Weekly usage")
                      : (session?.label ?? accountSignIn(account).label)}
                  </small>
                </span>
                <UsageMeter usage={usage} />
              </button>
            </li>
          );
        })}
      </ul>
      <p className={styles.disclosure}>Percentages appear only when reported by the provider.</p>
    </div>
  );
}

const MODE_LABELS = { dictation: "Dictation", command: "Command", talk: "Talk" } as const;

function KalVoiceSurface() {
  const voice = useOptionalKalVoice();
  const navigation = useNavigation();
  if (!voice)
    return (
      <Empty icon={AudioLines} title="KalVoice isn't available">
        This build does not expose the canonical KalVoice service.
      </Empty>
    );
  const { phase, mode, partial, message } = voice.state;
  const listening = phase === "listening";
  const busy = phase === "listening" || phase === "transcribing" || phase === "thinking" || phase === "executing";
  const detail = listening ? partial : message;
  const recent = voice.history.at(-1);
  // The destination is real only while a dictation session holds one; otherwise voice goes to
  // whatever has focus when the person speaks.
  const target = voice.dictationTarget
    ? voice.dictationTarget.composerThreadId
      ? "The focused agent's composer"
      : voice.dictationTarget.paneId
        ? "The focused Code pane"
        : "The focused field"
    : "Whatever has focus when you speak";
  return (
    <div className={styles.surface}>
      <section className={styles.voiceHero} data-phase={phase}>
        <span className={styles.voiceOrb} data-live={busy || undefined} aria-hidden="true">
          <AudioLines />
        </span>
        <div>
          <span>KalVoice</span>
          <h2>{STATE_LABELS[phase]}</h2>
        </div>
        {mode ? (
          <StatusIndicator tone={phase === "error" ? "failed" : busy ? "working" : "done"} pulse={listening}>
            {MODE_LABELS[mode]}
          </StatusIndicator>
        ) : null}
      </section>
      {detail ? (
        <section className={styles.transcript} aria-live="polite">
          <span>{listening ? "Transcription" : "Recent action"}</span>
          <p>{detail}</p>
        </section>
      ) : null}
      <dl className={styles.facts}>
        <div>
          <dt>Target</dt>
          <dd>{target}</dd>
        </div>
        <div>
          <dt>Cloud usage</dt>
          <dd>{voice.status ? usageLine(voice.status.usage) : "Usage unavailable"}</dd>
        </div>
        {recent?.text ? (
          <div>
            <dt>Last request</dt>
            <dd>{recent.text}</dd>
          </div>
        ) : null}
      </dl>
      <Button size="sm" variant="ghost" onClick={() => navigation.navigate("kalvoice")}>
        Open KalVoice
      </Button>
    </div>
  );
}

function GitSurface({ workspaceId }: { workspaceId: string | null }) {
  const { git } = useDeckData();
  const workspaces = useWorkspaces();
  const active = workspaces.active?.id === workspaceId;
  if (!active)
    return (
      <Empty icon={GitBranch} title="Workspace isn't active">
        Activate this workspace to read its live Git status.
      </Empty>
    );
  if (!git.loaded) return <Loading label="Git status" />;
  if (!git.data)
    return (
      <Empty
        icon={git.failed ? TriangleAlert : GitBranch}
        title={git.failed ? "Git unavailable" : "Not a Git repository"}
      >
        {git.failed ? "KalCode couldn't read Git status right now." : "This workspace has no repository metadata."}
      </Empty>
    );
  const changed = git.data.changed + git.data.untracked;
  const branch = git.data.branch ?? (git.data.head ? `detached ${git.data.head.slice(0, 7)}` : "No commits");
  return (
    <div className={styles.surface}>
      <section className={styles.gitHero} data-dirty={changed > 0 || undefined}>
        <span className={styles.rowIcon}>
          <GitBranch />
        </span>
        <div>
          <span>Current branch</span>
          <h2>{branch}</h2>
        </div>
        <StatusIndicator tone={changed > 0 ? "waiting" : "done"}>{changed > 0 ? "Dirty" : "Clean"}</StatusIndicator>
      </section>
      <div className={styles.metrics}>
        <div>
          <strong>{git.data.changed}</strong>
          <span>changed</span>
        </div>
        <div>
          <strong>{git.data.untracked}</strong>
          <span>untracked</span>
        </div>
        <div>
          <strong>{git.data.ahead ?? "—"}</strong>
          <span>ahead</span>
        </div>
        <div>
          <strong>{git.data.behind ?? "—"}</strong>
          <span>behind</span>
        </div>
      </div>
      <FeedNotice failed={git.failed} />
    </div>
  );
}

/** The newest test run and the newest build run, when Operations observed them. */
function latestChecks(items: readonly OperationRecord[]): OperationRecord[] {
  const latest = (kind: "test" | "build") => sortRuns(items.filter((item) => item.spec.kind === kind))[0];
  return [latest("test"), latest("build")].filter((item): item is OperationRecord => Boolean(item));
}

function TestsAndBuild({ workspaceId }: { workspaceId: string | null }) {
  const { snapshot, failed } = useWorkspaceOperations(workspaceId);
  if (!snapshot)
    return failed ? (
      <Empty icon={TriangleAlert} title="Build status unavailable">
        KalCode couldn't read Operations right now.
      </Empty>
    ) : (
      <Loading label="tests and builds" />
    );
  const checks = latestChecks(snapshot.items);
  if (checks.length === 0)
    return (
      <Empty icon={TestTube2} title="No test or build runs">
        Observed tests and builds appear here with their real result.
      </Empty>
    );
  return (
    <div className={styles.surface}>
      <FeedNotice failed={failed} />
      <OperationRows items={checks} empty="No test or build runs" />
    </div>
  );
}
