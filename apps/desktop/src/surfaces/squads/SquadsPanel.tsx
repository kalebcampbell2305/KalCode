import {
  getPlanFeature,
  type ProviderAccount,
  type ProviderOption,
  planIncludes,
  type SquadDefinition,
  type SquadLaunch,
  type SquadMemberDefinition,
  type SquadRecipe,
  type SquadsSnapshot,
  type ThreadOptions,
} from "@kalcode/protocol";
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  ProviderGlyph,
  Select,
  Skeleton,
  StatusIndicator,
  TextArea,
  TextInput,
  useToast,
} from "@kalcode/ui/components";
import {
  ArrowRight,
  Bot,
  GitBranch,
  Handshake,
  Layers3,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Route,
  Save,
  ShieldAlert,
  Sparkles,
  TerminalSquare,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useOptionalAccount } from "../../account/AccountProvider.tsx";
import { planTier } from "../../ipc/account.ts";
import type { OperationsApi } from "../../ipc/operations.ts";
import type { SquadsApi } from "../../ipc/squads.ts";
import { focusOperationsTarget } from "../../kalvoice/sceneOperations.ts";
import { useOptionalUiIntents } from "../../runtime/uiIntents.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { HandOffDialog } from "../code/HandOffDialog.tsx";
import { AGENT_EFFORTS, effortLabel } from "../code/panes/agentLaunch.ts";
import type { PaneProviderId } from "../code/panes/paneChannel.ts";
import { providerIdentity } from "../code/panes/paneLabels.ts";
import { useLaunchAgent } from "../code/useLaunchAgent.ts";
import { useCodingAgents } from "../dashboard/data/DashboardData.tsx";
import { OverlapNote } from "../dashboard/fleet/OverlapNote.tsx";
import { useAgentOverlaps } from "../dashboard/fleet/useAgentOverlaps.ts";
import { AgentOutcome } from "../dashboard/outcome/AgentOutcome.tsx";
import { accountName, accountSessionState, sortAccounts } from "../providers/accountIdentity.ts";
import { LaunchSignIn } from "../providers/LaunchAccountPicker.tsx";
import { launchTruth, memberDisplay, ownershipCollisions, type SquadLaunchTruth } from "./model.ts";
import styles from "./SquadsPanel.module.css";

const REFRESH_MS = 2_500;
const ROLE_TEMPLATES = ["implementation", "test", "review", "release"] as const;

function uid(prefix: string): string {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

function entityId(): string {
  const issued = globalThis.crypto?.randomUUID?.();
  if (issued) return issued;
  const tail = `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff_ffff).toString(16)}`
    .padEnd(12, "0")
    .slice(0, 12);
  return `00000000-0000-4000-8000-${tail}`;
}

function defaultProvider(
  providers: readonly ProviderOption[],
  accounts: readonly ProviderAccount[],
): ProviderOption | null {
  const usable = accounts.filter((account) => account.archivedAt === null && accountSessionState(account).usable);
  return (
    providers.find((provider) => usable.some((account) => account.providerId === provider.id && account.isDefault)) ??
    providers.find((provider) => usable.some((account) => account.providerId === provider.id)) ??
    providers[0] ??
    null
  );
}

function newMember(index: number, providers: readonly ProviderOption[], accounts: readonly ProviderAccount[]) {
  const provider = defaultProvider(providers, accounts);
  const providerId = provider?.id ?? "";
  const candidates = sortAccounts(
    accounts.filter((candidate) => candidate.providerId === providerId && candidate.archivedAt === null),
  );
  const account = candidates.find((candidate) => accountSessionState(candidate).usable) ?? candidates[0];
  return {
    key: uid("member"),
    name: `Agent ${index}`,
    providerId,
    providerAccountId: account?.id ?? "",
    model: provider?.models.find((model) => model.isDefault)?.id ?? "",
    effort: "",
    role: ROLE_TEMPLATES[(index - 1) % ROLE_TEMPLATES.length] ?? "implementation",
    task: null,
    worktree: true,
    dependsOn: [],
    managerKey: null,
    ownedPaths: [],
  } satisfies SquadMemberDefinition;
}

function newSquad(providers: readonly ProviderOption[], accounts: readonly ProviderAccount[]): SquadDefinition {
  return {
    id: entityId(),
    name: "",
    goal: "",
    members: [newMember(1, providers, accounts), newMember(2, providers, accounts)],
  };
}

function normalized(definition: SquadDefinition): SquadDefinition {
  return {
    ...definition,
    name: definition.name.trim(),
    goal: definition.goal.trim(),
    members: definition.members.map((member) => ({
      ...member,
      name: member.name.trim(),
      role: member.role.trim(),
      task: member.task?.trim() || null,
      ownedPaths: [...new Set(member.ownedPaths.map((path) => path.trim()).filter(Boolean))],
      dependsOn: [...new Set(member.dependsOn)].filter((key) => key !== member.key),
      managerKey: member.managerKey === member.key ? null : member.managerKey,
    })),
  };
}

function definitionError(
  definition: SquadDefinition,
  accounts: readonly ProviderAccount[],
  accountCatalogUnavailable: boolean,
): string | null {
  if (!definition.name.trim()) return "Name the squad.";
  if (definition.members.length === 0) return "Add at least one real coding agent.";
  if (definition.members.some((member) => !member.name.trim())) return "Every member needs a name.";
  if (definition.members.some((member) => !member.providerId.trim())) return "Every member needs a provider.";
  if (
    definition.members.some(
      (member) =>
        !accounts.some(
          (account) =>
            account.id === member.providerAccountId &&
            account.providerId === member.providerId &&
            account.archivedAt === null,
        ) && !(accountCatalogUnavailable && Boolean(member.providerAccountId.trim())),
    )
  ) {
    return "Connect and select an active provider account for every member.";
  }
  const keys = new Set(definition.members.map((member) => member.key));
  if (keys.size !== definition.members.length) return "Every member needs a unique identity.";
  if (definition.members.some((member) => member.dependsOn.some((key) => !keys.has(key)))) {
    return "A dependency points to a member that is no longer in this squad.";
  }
  if (definition.members.some((member) => member.managerKey && !keys.has(member.managerKey))) {
    return "A manager points to a member that is no longer in this squad.";
  }
  return null;
}

function providerName(providerId: string): string {
  return providerIdentity(providerId as PaneProviderId).name;
}

function launchDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Recently"
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function needsRecovery(
  operation: SquadLaunchTruth["members"][number]["operation"],
): operation is NonNullable<SquadLaunchTruth["members"][number]["operation"]> {
  return Boolean(operation?.attentionReason && ["queued", "paused", "blocked"].includes(operation.status));
}

function activeOperationAccount(
  operation: NonNullable<SquadLaunchTruth["members"][number]["operation"]>,
  accounts: readonly ProviderAccount[],
): ProviderAccount | undefined {
  return accounts.find(
    (account) =>
      account.id === operation.spec.providerAccountId &&
      account.providerId === operation.spec.providerId &&
      account.archivedAt === null,
  );
}

function canResumeOperation(
  operation: SquadLaunchTruth["members"][number]["operation"],
  accounts: readonly ProviderAccount[],
  accountCatalogReady: boolean,
): operation is NonNullable<SquadLaunchTruth["members"][number]["operation"]> {
  if (!needsRecovery(operation)) return false;
  if (!accountCatalogReady) return true;
  return activeOperationAccount(operation, accounts)?.authenticationState === "authenticated";
}

export interface SquadsPanelProps {
  client: SquadsApi;
  operations: OperationsApi;
  workspaceId: string;
  threadOptions: () => Promise<ThreadOptions>;
  providerAccounts?: () => Promise<ProviderAccount[]>;
  onOperationsChanged?: () => void;
}

/**
 * Reusable Squad definitions around canonical Operations and real provider terminals. The only
 * local state is form draft and immediate interaction feedback; member runtime truth is always
 * projected from the launch's Operation and the shared coding-agent list.
 */
export function SquadsPanel({
  client,
  operations,
  workspaceId,
  threadOptions,
  providerAccounts,
  onOperationsChanged,
}: SquadsPanelProps) {
  const toast = useToast();
  const account = useOptionalAccount();
  const navigation = useNavigation();
  const codingAgents = useCodingAgents();
  const uiIntents = useOptionalUiIntents();
  const launchAgent = useLaunchAgent();
  const actualOverlaps = useAgentOverlaps().byAgent;
  const [snapshot, setSnapshot] = useState<SquadsSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [editor, setEditor] = useState<SquadDefinition | null>(null);
  const [hierarchyVisible, setHierarchyVisible] = useState(false);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [accountCatalogReady, setAccountCatalogReady] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [launchBusy, setLaunchBusy] = useState<string | null>(null);
  const [pendingLaunch, setPendingLaunch] = useState<{ key: string; requestId: string } | null>(null);
  const [memberBusy, setMemberBusy] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState<string | null>(null);
  const [recipeDraft, setRecipeDraft] = useState<{ name: string; squadId: string; goal: string } | null>(null);
  const [handoffSource, setHandoffSource] = useState<string | null>(null);
  const mounted = useRef(true);
  const loadFlight = useRef<Promise<void> | null>(null);
  const catalogRequest = useRef(0);
  const editorTouched = useRef(false);
  const editorHeading = useId();
  const feature = getPlanFeature("squads");
  const tier = planTier(account?.snapshot);
  const available = account ? planIncludes(tier === "owner" ? "max2x" : tier, feature) : true;
  const agents = codingAgents.state.status === "ready" ? codingAgents.state.data : [];

  const reloadAccounts = useCallback(async () => {
    if (!providerAccounts) {
      if (mounted.current) setAccountCatalogReady(false);
      return [];
    }
    const next = await providerAccounts();
    if (mounted.current) {
      setAccounts(next);
      setAccountCatalogReady(true);
    }
    return next;
  }, [providerAccounts]);

  const rememberAccount = useCallback((connected: ProviderAccount) => {
    setAccounts((current) => [connected, ...current.filter((candidate) => candidate.id !== connected.id)]);
  }, []);

  const load = useCallback(
    async (quiet = false): Promise<void> => {
      if (loadFlight.current) {
        await loadFlight.current;
        return load(quiet);
      }
      if (!quiet) setRefreshing(true);
      const request = (async () => {
        try {
          const next = await client.snapshot();
          if (!mounted.current) return;
          setSnapshot(next);
          setError(null);
        } catch (reason) {
          if (mounted.current) setError(reason instanceof Error ? reason : new Error("Squads are unavailable."));
        } finally {
          if (mounted.current && !quiet) setRefreshing(false);
        }
      })();
      loadFlight.current = request;
      try {
        await request;
      } finally {
        if (loadFlight.current === request) loadFlight.current = null;
      }
    },
    [client],
  );

  useEffect(() => {
    mounted.current = true;
    void load();
    if (providerAccounts) void reloadAccounts().catch(() => undefined);
    return () => {
      mounted.current = false;
    };
  }, [load, providerAccounts, reloadAccounts]);

  const live = snapshot?.operations.some((operation) =>
    ["queued", "starting", "running", "paused", "blocked"].includes(operation.status),
  );
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void load(true), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [live, load]);

  const truths = useMemo(
    () =>
      snapshot
        ? snapshot.launches
            .map((launch) => launchTruth(launch, snapshot.squads, snapshot.operations, agents))
            .toSorted((left, right) => right.launch.createdAt.localeCompare(left.launch.createdAt))
        : [],
    [agents, snapshot],
  );

  const openEditor = useCallback(
    (definition?: SquadDefinition) => {
      const request = ++catalogRequest.current;
      setFormError(null);
      setCatalogError(null);
      setCatalogLoading(true);
      editorTouched.current = false;
      setHierarchyVisible(Boolean(definition?.members.some((member) => member.managerKey)));
      setEditor(definition ? structuredClone(definition) : newSquad(providers, accounts));
      void Promise.all([threadOptions(), reloadAccounts()]).then(
        ([options, nextAccounts]) => {
          if (request !== catalogRequest.current) return;
          setProviders(options.providers);
          setAccounts(nextAccounts);
          setEditor((current) => {
            if (!current || definition || editorTouched.current) return current;
            return newSquad(options.providers, nextAccounts);
          });
          setCatalogLoading(false);
        },
        (reason) => {
          if (request !== catalogRequest.current) return;
          setCatalogError(reason instanceof Error ? reason.message : "Provider choices could not load.");
          setCatalogLoading(false);
        },
      );
    },
    [accounts, providers, reloadAccounts, threadOptions],
  );

  const saveSquad = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!editor || saving) return;
      const next = normalized(editor);
      const problem = definitionError(next, accounts, Boolean(catalogError));
      if (problem) {
        setFormError(problem);
        return;
      }
      setSaving(true);
      setFormError(null);
      try {
        await client.save(next);
        setEditor(null);
        await load(true);
        toast.show({ tone: "success", title: "Squad saved", description: `${next.name} is ready to launch again.` });
      } catch (reason) {
        setFormError(reason instanceof Error ? reason.message : "The squad could not be saved.");
      } finally {
        setSaving(false);
      }
    },
    [accounts, catalogError, client, editor, load, saving, toast],
  );

  const runLaunch = useCallback(
    async (key: string, action: (requestId: string) => Promise<SquadLaunch>) => {
      if (!workspaceId) {
        toast.show({ tone: "danger", title: "Choose a workspace", description: "A Squad needs a project to work in." });
        return;
      }
      if (launchBusy) return;
      const requestId = pendingLaunch?.key === key ? pendingLaunch.requestId : uid("launch-request");
      setLaunchBusy(key);
      try {
        await action(requestId);
        setPendingLaunch(null);
        await load(true);
        onOperationsChanged?.();
        toast.show({
          tone: "success",
          title: "Squad launched",
          description: "Real coding terminals are starting now.",
        });
      } catch (reason) {
        setPendingLaunch({ key, requestId });
        await load(true);
        toast.show({
          tone: "danger",
          title: "Launch needs attention",
          description:
            reason instanceof Error
              ? `${reason.message} The latest member state is shown below; retry keeps the same launch request.`
              : "KalCode could not confirm every member. The latest state is shown below; retry keeps this request.",
        });
      } finally {
        setLaunchBusy(null);
      }
    },
    [launchBusy, load, onOperationsChanged, pendingLaunch, toast, workspaceId],
  );

  const mutateMember = useCallback(
    async (key: string, action: () => Promise<unknown>, success: string) => {
      if (memberBusy) return;
      setMemberBusy(key);
      try {
        await action();
        await load(true);
        onOperationsChanged?.();
        toast.show({ tone: "success", title: success });
        return true;
      } catch (reason) {
        toast.show({
          tone: "danger",
          title: "Squad action failed",
          description: reason instanceof Error ? reason.message : "The native runtime refused the action.",
        });
        return false;
      } finally {
        setMemberBusy(null);
      }
    },
    [load, memberBusy, onOperationsChanged, toast],
  );

  const stopLaunch = useCallback(
    async (truth: SquadLaunchTruth) => {
      const key = `stop:${truth.launch.id}`;
      if (memberBusy) return;
      const cancellable = truth.members.flatMap(({ operation }) =>
        operation && ["queued", "starting", "running", "paused", "blocked"].includes(operation.status)
          ? [operation]
          : [],
      );
      if (cancellable.length === 0) return;
      setMemberBusy(key);
      const results = await Promise.allSettled(cancellable.map((operation) => operations.cancel(operation.id)));
      await load(true);
      onOperationsChanged?.();
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed === 0) {
        toast.show({
          tone: "success",
          title: "Squad stopped",
          description: "Every pending or running member was cancelled.",
        });
      } else {
        toast.show({
          tone: "danger",
          title: `${failed} ${failed === 1 ? "member" : "members"} could not stop`,
          description: `${cancellable.length - failed} stopped. The remaining member state is shown below.`,
        });
      }
      setMemberBusy(null);
    },
    [load, memberBusy, onOperationsChanged, operations, toast],
  );

  const resumeLaunch = useCallback(
    async (truth: SquadLaunchTruth) => {
      const key = `resume:${truth.launch.id}`;
      if (memberBusy) return;
      const recoverable = truth.members.flatMap(({ operation }) =>
        canResumeOperation(operation, accounts, accountCatalogReady) ? [operation] : [],
      );
      if (recoverable.length === 0) return;
      setMemberBusy(key);
      const results = await Promise.allSettled(recoverable.map((operation) => operations.runNow(operation.id)));
      await load(true);
      onOperationsChanged?.();
      const failed = results.filter((result) => result.status === "rejected").length;
      toast.show(
        failed === 0
          ? {
              tone: "success",
              title: "Squad resumed",
              description: "Recovered members will run as dependencies become ready.",
            }
          : {
              tone: "danger",
              title: `${failed} ${failed === 1 ? "member still needs" : "members still need"} recovery`,
              description: `${recoverable.length - failed} resumed. The remaining decision is shown below.`,
            },
      );
      setMemberBusy(null);
    },
    [accountCatalogReady, accounts, load, memberBusy, onOperationsChanged, operations, toast],
  );

  const source = agents.find((agent) => agent.id === handoffSource) ?? null;

  if (!snapshot && !error) return <SquadsLoading />;
  if (!snapshot && error) {
    return (
      <div className={styles.state}>
        <ErrorState title="Squads couldn't load" actions={<Button onClick={() => void load()}>Try again</Button>}>
          {error.message}
        </ErrorState>
      </div>
    );
  }
  if (!snapshot) return null;

  return (
    <section className={styles.root} aria-labelledby="squads-heading">
      <header className={styles.hero}>
        <div className={styles.heroMark} aria-hidden="true">
          <UsersRound />
        </div>
        <div className={styles.heroCopy}>
          <div className={styles.eyebrow}>Unified orchestration</div>
          <h2 id="squads-heading">Squads</h2>
          <p>Reusable teams of real coding agents. One goal, independent work, shared Operations truth.</p>
        </div>
        <div className={styles.heroActions}>
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw aria-hidden="true" />}
            busy={refreshing}
            onClick={() => void load()}
          >
            Refresh
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Plus aria-hidden="true" />}
            disabled={!available}
            onClick={() => void openEditor()}
          >
            New squad
          </Button>
        </div>
      </header>

      {!available ? (
        <div className={styles.planNotice}>
          <Sparkles aria-hidden="true" />
          <div>
            <strong>Squads are included with MAX.</strong>
            <span>Build and relaunch coordinated teams with mixed providers and exact agent settings.</span>
          </div>
          <Button size="sm" onClick={() => navigation.navigate("settings")}>
            View plans
          </Button>
        </div>
      ) : null}

      {error ? (
        <p className={styles.stale} role="status">
          Refresh failed. Showing the last observed Squad state.
        </p>
      ) : null}

      {truths.length > 0 ? (
        <div className={styles.section}>
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.eyebrow}>Now</span>
              <h3>Squad runs</h3>
            </div>
            <span className={styles.sectionNote}>
              {truths.length} recent {truths.length === 1 ? "launch" : "launches"}
            </span>
          </div>
          <div className={styles.launches}>
            {truths.map((truth) => (
              <LaunchRow
                key={truth.launch.id}
                truth={truth}
                memberBusy={memberBusy}
                overlaps={actualOverlaps}
                accounts={accounts}
                accountCatalogReady={accountCatalogReady}
                reloadAccounts={reloadAccounts}
                onAccountConnected={rememberAccount}
                onOpen={(agentId, memberWorkspaceId) =>
                  void uiIntents?.focus({ kind: "agent", agentId, workspaceId: memberWorkspaceId })
                }
                onHandoff={setHandoffSource}
                onResumeMember={(operationId) =>
                  void mutateMember(
                    `resume:${operationId}`,
                    () => operations.runNow(operationId),
                    "Member queued to resume",
                  )
                }
                onReconnect={(operationId) =>
                  mutateMember(
                    `resume:${operationId}`,
                    () => operations.runNow(operationId),
                    "Account reconnected and member queued",
                  )
                }
                onReplaceAccount={(operation, providerAccountId) =>
                  mutateMember(
                    `account:${operation.id}`,
                    async () => {
                      const latest = await operations.snapshot();
                      const current = latest.items.find((candidate) => candidate.id === operation.id);
                      if (!current) throw new Error("This member is no longer in the Operations queue.");
                      if (current.threadId) {
                        throw new Error(
                          "This terminal already has an account identity. Inspect the run before changing it.",
                        );
                      }
                      await operations.update(current.id, { ...current.spec, providerAccountId }, latest.revision);
                      await operations.runNow(current.id);
                    },
                    "Account changed and member queued",
                  )
                }
                onInspect={(operation) =>
                  void focusOperationsTarget({
                    kind: "run",
                    tab: "runs",
                    runId: operation.id,
                    workspaceId: operation.spec.workspaceId,
                    label: operation.spec.name,
                  })
                }
                onManager={(memberKey, managerKey) =>
                  void mutateMember(
                    `manager:${truth.launch.id}:${memberKey}`,
                    () => client.reassignManager(truth.launch.id, memberKey, managerKey),
                    "Manager reassigned",
                  )
                }
                onResume={() => void resumeLaunch(truth)}
                onStop={() => void stopLaunch(truth)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className={styles.section}>
        <div className={styles.sectionHeading}>
          <div>
            <span className={styles.eyebrow}>Library</span>
            <h3>Reusable teams</h3>
          </div>
          {snapshot.squads.length > 0 ? (
            <span className={styles.sectionNote}>{snapshot.squads.length} saved</span>
          ) : null}
        </div>
        {snapshot.squads.length === 0 ? (
          <EmptyState
            art={<UsersRound aria-hidden="true" />}
            title="Build your first squad"
            actions={
              <Button variant="primary" disabled={!available} onClick={() => void openEditor()}>
                Create a squad
              </Button>
            }
          >
            Choose each coding agent's provider, account, model, effort and responsibility once, then launch the team in
            one action.
          </EmptyState>
        ) : (
          <div className={styles.library}>
            {snapshot.squads.map((squad) => {
              const conflicts = ownershipCollisions(squad.members);
              return (
                <article key={squad.id} className={styles.squadCard} data-squad-id={squad.id}>
                  <div className={styles.squadMain}>
                    <div className={styles.squadTitle}>
                      <span className={styles.teamGlyph}>
                        <UsersRound aria-hidden="true" />
                      </span>
                      <div>
                        <h4>{squad.name}</h4>
                        <p>{squad.goal}</p>
                      </div>
                    </div>
                    <ul className={styles.roster} aria-label={`${squad.name} members`}>
                      {squad.members.map((member) => (
                        <li key={member.key} className={styles.rosterMember}>
                          <ProviderGlyph provider={member.providerId} />
                          <span>
                            <strong>{member.name}</strong>
                            <small>
                              {member.role} · {providerName(member.providerId)}
                            </small>
                          </span>
                        </li>
                      ))}
                    </ul>
                    {conflicts.length > 0 ? (
                      <div className={styles.ownershipNote}>
                        <ShieldAlert aria-hidden="true" />
                        <span>
                          {conflicts.some((conflict) => conflict.undeclared)
                            ? "Shared checkout with undeclared ownership. KalCode will run those tasks sequentially."
                            : conflicts.some((conflict) => conflict.mode === "shared")
                              ? "Shared-checkout ownership overlaps. KalCode will sequence those paths before agents edit."
                              : "Worktree ownership overlaps. Agents can proceed; resolve those paths in the merge train."}
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <div className={styles.cardActions}>
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Play aria-hidden="true" />}
                      busy={launchBusy === `squad:${squad.id}`}
                      disabled={!available || Boolean(launchBusy)}
                      onClick={() =>
                        void runLaunch(`squad:${squad.id}`, (requestId) =>
                          client.launch(squad.id, workspaceId, requestId),
                        )
                      }
                    >
                      Launch
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Pencil aria-hidden="true" />}
                      onClick={() => void openEditor(squad)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant={deleteArmed === squad.id ? "danger" : "ghost"}
                      icon={<Trash2 aria-hidden="true" />}
                      onClick={() => {
                        if (deleteArmed !== squad.id) {
                          setDeleteArmed(squad.id);
                          return;
                        }
                        void mutateMember(`delete:${squad.id}`, () => client.delete(squad.id), "Squad deleted");
                        setDeleteArmed(null);
                      }}
                    >
                      {deleteArmed === squad.id ? "Delete squad" : "Delete"}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <Recipes
        recipes={snapshot.recipes}
        squads={snapshot.squads}
        draft={recipeDraft}
        busy={launchBusy}
        disabled={!available}
        onDraft={setRecipeDraft}
        onSave={async (draft) => {
          const recipe: SquadRecipe = {
            id: entityId(),
            name: draft.name.trim(),
            squadId: draft.squadId,
            goal: draft.goal.trim() || null,
          };
          const saved = await mutateMember(`recipe:${recipe.id}`, () => client.saveRecipe(recipe), "Recipe saved");
          if (saved) setRecipeDraft(null);
        }}
        onDelete={(id) => void mutateMember(`recipe-delete:${id}`, () => client.deleteRecipe(id), "Recipe deleted")}
        onLaunch={(recipe) =>
          void runLaunch(`recipe:${recipe.id}`, (requestId) => client.launchRecipe(recipe.id, workspaceId, requestId))
        }
      />

      {editor ? (
        <SquadEditor
          headingId={editorHeading}
          value={editor}
          providers={providers}
          accounts={accounts}
          hierarchyVisible={hierarchyVisible}
          catalogError={catalogError}
          catalogLoading={catalogLoading}
          error={formError}
          saving={saving}
          onHierarchy={setHierarchyVisible}
          onReloadAccounts={reloadAccounts}
          onAccountConnected={rememberAccount}
          onChange={(next) => {
            editorTouched.current = true;
            setEditor(next);
          }}
          onCancel={() => {
            catalogRequest.current += 1;
            setEditor(null);
          }}
          onSubmit={saveSquad}
        />
      ) : null}

      {source ? (
        <HandOffDialog open source={source} onNewAgent={launchAgent} onClose={() => setHandoffSource(null)} />
      ) : null}
    </section>
  );
}

function LaunchRow({
  truth,
  memberBusy,
  overlaps,
  accounts,
  accountCatalogReady,
  reloadAccounts,
  onAccountConnected,
  onOpen,
  onHandoff,
  onResumeMember,
  onReconnect,
  onReplaceAccount,
  onInspect,
  onManager,
  onResume,
  onStop,
}: {
  truth: SquadLaunchTruth;
  memberBusy: string | null;
  overlaps: ReturnType<typeof useAgentOverlaps>["byAgent"];
  accounts: readonly ProviderAccount[];
  accountCatalogReady: boolean;
  reloadAccounts(): Promise<unknown>;
  onAccountConnected(account: ProviderAccount): void;
  onOpen(agentId: string, workspaceId: string): void;
  onHandoff(agentId: string): void;
  onResumeMember(operationId: string): void;
  onReconnect(operationId: string): Promise<unknown>;
  onReplaceAccount(
    operation: NonNullable<SquadLaunchTruth["members"][number]["operation"]>,
    providerAccountId: string,
  ): Promise<unknown>;
  onInspect(operation: NonNullable<SquadLaunchTruth["members"][number]["operation"]>): void;
  onManager(memberKey: string, managerKey: string | null): void;
  onResume(): void;
  onStop(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [managerEditing, setManagerEditing] = useState<string | null>(null);
  const progress = truth.members.length > 0 ? Math.round((truth.completed / truth.members.length) * 100) : 0;
  const hasHierarchy = truth.members.some(({ member }) => member.managerKey);
  const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
  const settled =
    truth.members.length > 0 && truth.members.every(({ operation }) => operation && terminal.has(operation.status));
  const priority = (member: SquadLaunchTruth["members"][number]) => {
    if (member.state === "needs_you" || member.state === "failed") return 0;
    if (["starting", "working", "testing"].includes(member.state)) return 1;
    if (member.state === "waiting" || member.state === "queued" || member.state === "unavailable") return 2;
    return 3;
  };
  const ordered = truth.members.toSorted((left, right) => priority(left) - priority(right));
  const visible = expanded ? ordered : settled ? [] : ordered.slice(0, 8);
  return (
    <article className={styles.launch} data-squad-launch-id={truth.launch.id}>
      <div className={styles.launchHeader}>
        <div>
          <div className={styles.launchTitle}>
            <h4>{truth.launch.name}</h4>
            <StatusIndicator
              tone={
                truth.failed > 0
                  ? "failed"
                  : truth.needsYou > 0
                    ? "waiting"
                    : truth.completed === truth.members.length
                      ? "done"
                      : "working"
              }
              pulse={truth.active > 0}
            >
              {truth.outcome}
            </StatusIndicator>
          </div>
          <p>{truth.launch.goal || "Ready for direction"}</p>
        </div>
        <div className={styles.launchHeaderActions}>
          <span className={styles.launchTime}>{launchDate(truth.launch.createdAt)}</span>
          {truth.members.some(({ operation }) => canResumeOperation(operation, accounts, accountCatalogReady)) ? (
            <Button size="sm" variant="secondary" busy={memberBusy === `resume:${truth.launch.id}`} onClick={onResume}>
              Resume squad
            </Button>
          ) : null}
          {settled ? (
            <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "Hide details" : "Show details"}
            </Button>
          ) : null}
          {truth.members.some(
            ({ operation }) =>
              operation && ["queued", "starting", "running", "paused", "blocked"].includes(operation.status),
          ) ? (
            <Button size="sm" variant="ghost" busy={memberBusy === `stop:${truth.launch.id}`} onClick={onStop}>
              Stop squad
            </Button>
          ) : null}
        </div>
      </div>
      <div
        className={styles.progress}
        role="progressbar"
        aria-label="Members done"
        aria-valuemin={0}
        aria-valuemax={truth.members.length}
        aria-valuenow={truth.completed}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className={styles.memberList}>
        {visible.map(({ member, definition, operation, agent, state, tone, label, reason }) => {
          const display = memberDisplay({ member, definition, operation, agent, state, tone, label, reason });
          const runtime = [
            providerName(display.providerId),
            operation?.accountLabel,
            display.model,
            display.effort ? `${effortLabel(display.effort)} effort` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          const identityDetail = [display.name, member.role, runtime].filter(Boolean).join(" · ");
          const managerCandidates = truth.members.filter((candidate) => candidate.member.key !== member.key);
          const recovery = needsRecovery(operation);
          const exactAccount =
            recovery && accountCatalogReady ? activeOperationAccount(operation, accounts) : undefined;
          const reconnectAccount =
            exactAccount && exactAccount.authenticationState !== "authenticated" ? exactAccount : undefined;
          const missingAccount = recovery && accountCatalogReady && !exactAccount;
          const replaceableAccount = missingAccount && !operation.threadId;
          const inspectUnavailableAccount = missingAccount && Boolean(operation.threadId) && !agent;
          const inspectFailure = operation && !agent && ["failed", "interrupted"].includes(operation.status);
          return (
            <div
              key={member.key}
              className={styles.memberRow}
              data-squad-member-key={member.key}
              data-testid="squad-member-row"
            >
              <span className={styles.memberProvider}>
                <ProviderGlyph provider={display.providerId} />
              </span>
              <div className={styles.memberIdentity} title={identityDetail}>
                <strong title={display.name}>{display.name}</strong>
                <span>
                  {member.role}
                  {runtime ? ` · ${runtime}` : ""}
                </span>
              </div>
              <div className={styles.memberState}>
                <StatusIndicator tone={tone} pulse={state === "starting" || state === "working" || state === "testing"}>
                  {label}
                </StatusIndicator>
                {reason ? (
                  <small title={reason}>{reason}</small>
                ) : operation?.status === "queued" && operation.blockers.length > 0 ? (
                  <small>
                    Waiting for {operation.blockers.length} dependent task{operation.blockers.length === 1 ? "" : "s"}
                  </small>
                ) : null}
                {agent ? <AgentOutcome thread={agent} variant="card" /> : null}
                {agent && (overlaps.get(agent.id)?.length ?? 0) > 0 ? (
                  <OverlapNote
                    overlaps={overlaps.get(agent.id) ?? []}
                    onFocus={(other) => onOpen(other.id, other.workspaceId)}
                  />
                ) : null}
              </div>
              {hasHierarchy && managerEditing === member.key ? (
                <label className={styles.managerSelect}>
                  <span>Manager</span>
                  <select
                    aria-label={`Manager for ${display.name}`}
                    value={member.managerKey ?? ""}
                    disabled={memberBusy !== null}
                    onChange={(event) => {
                      onManager(member.key, event.target.value || null);
                      setManagerEditing(null);
                    }}
                  >
                    <option value="">Lead</option>
                    {managerCandidates.map((candidate) => (
                      <option key={candidate.member.key} value={candidate.member.key}>
                        {memberDisplay(candidate).name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className={styles.memberActions}>
                {hasHierarchy && managerEditing !== member.key ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setManagerEditing(member.key)}
                    aria-label={`Reassign manager for ${display.name}`}
                  >
                    Reassign
                  </Button>
                ) : null}
                {reconnectAccount && operation ? (
                  <InlineAccountConnection
                    providerId={reconnectAccount.providerId}
                    account={reconnectAccount}
                    reloadAccounts={reloadAccounts}
                    reconnect
                    onConnected={async (connected) => {
                      onAccountConnected(connected);
                      await onReconnect(operation.id);
                    }}
                  />
                ) : replaceableAccount ? (
                  <MissingAccountRecovery
                    operation={operation}
                    accounts={accounts}
                    busy={memberBusy === `account:${operation.id}`}
                    reloadAccounts={reloadAccounts}
                    onAccountConnected={onAccountConnected}
                    onReplace={(providerAccountId) => onReplaceAccount(operation, providerAccountId)}
                  />
                ) : recovery && !missingAccount ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    busy={memberBusy === `resume:${operation.id}`}
                    onClick={() => onResumeMember(operation.id)}
                  >
                    Resume member
                  </Button>
                ) : null}
                {inspectFailure || inspectUnavailableAccount ? (
                  <Button size="sm" variant="secondary" onClick={() => onInspect(operation)}>
                    Inspect run
                  </Button>
                ) : null}
                {agent ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Handshake aria-hidden="true" />}
                      onClick={() => onHandoff(agent.id)}
                    >
                      Hand off
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<TerminalSquare aria-hidden="true" />}
                      onClick={() => onOpen(agent.id, agent.workspaceId)}
                    >
                      Open terminal
                    </Button>
                  </>
                ) : (
                  <span className={styles.terminalPending}>
                    {replaceableAccount
                      ? "Held before terminal start"
                      : operation?.status === "queued"
                        ? "Queued"
                        : "Terminal starting…"}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {truth.members.length > 8 && !settled ? (
          <button type="button" className={styles.showMembers} onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Show priority members" : `Show all ${truth.members.length} members`}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function InlineAccountConnection({
  providerId,
  account,
  reloadAccounts,
  onConnected,
  reconnect = false,
  disabled = false,
}: {
  providerId: string;
  account: ProviderAccount | undefined;
  reloadAccounts(): Promise<unknown>;
  onConnected(account: ProviderAccount): Promise<void>;
  reconnect?: boolean;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div aria-busy={busy || undefined}>
      <LaunchSignIn
        providerId={providerId}
        providerName={providerName(providerId)}
        account={account}
        needed
        disabled={disabled}
        onReload={reloadAccounts}
        onBusyChange={setBusy}
        onConnected={onConnected}
        reconnect={reconnect}
      />
    </div>
  );
}

function MissingAccountRecovery({
  operation,
  accounts,
  busy,
  reloadAccounts,
  onAccountConnected,
  onReplace,
}: {
  operation: NonNullable<SquadLaunchTruth["members"][number]["operation"]>;
  accounts: readonly ProviderAccount[];
  busy: boolean;
  reloadAccounts(): Promise<unknown>;
  onAccountConnected(account: ProviderAccount): void;
  onReplace(providerAccountId: string): Promise<unknown>;
}) {
  const providerId = operation.spec.providerId ?? "";
  const candidates = accounts.filter(
    (account) =>
      account.providerId === providerId &&
      account.archivedAt === null &&
      account.authenticationState === "authenticated",
  );
  const preferred = candidates.find((account) => account.isDefault) ?? candidates[0];
  const [selected, setSelected] = useState(preferred?.id ?? "");
  useEffect(() => {
    if (!candidates.some((account) => account.id === selected)) setSelected(preferred?.id ?? "");
  }, [candidates, preferred?.id, selected]);

  if (candidates.length === 0) {
    return (
      <div className={styles.missingAccountRecovery}>
        <span>No active {providerName(providerId)} account</span>
        <InlineAccountConnection
          providerId={providerId}
          account={undefined}
          reloadAccounts={reloadAccounts}
          disabled={busy}
          onConnected={async (connected) => {
            onAccountConnected(connected);
            await onReplace(connected.id);
          }}
        />
      </div>
    );
  }

  return (
    <div className={styles.missingAccountRecovery}>
      <Select
        aria-label={`Replacement account for ${operation.spec.name}`}
        value={selected}
        disabled={busy}
        onChange={(event) => setSelected(event.target.value)}
      >
        {candidates.map((account) => (
          <option key={account.id} value={account.id}>
            {accountName(account)}
          </option>
        ))}
      </Select>
      <Button size="sm" variant="secondary" busy={busy} disabled={!selected} onClick={() => void onReplace(selected)}>
        Use account
      </Button>
    </div>
  );
}

function Recipes({
  recipes,
  squads,
  draft,
  busy,
  disabled,
  onDraft,
  onSave,
  onDelete,
  onLaunch,
}: {
  recipes: readonly SquadRecipe[];
  squads: readonly SquadDefinition[];
  draft: { name: string; squadId: string; goal: string } | null;
  busy: string | null;
  disabled: boolean;
  onDraft(value: { name: string; squadId: string; goal: string } | null): void;
  onSave(value: { name: string; squadId: string; goal: string }): Promise<void>;
  onDelete(id: string): void;
  onLaunch(recipe: SquadRecipe): void;
}) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeading}>
        <div>
          <span className={styles.eyebrow}>MAX · Squad automation</span>
          <h3>Squad recipes</h3>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus aria-hidden="true" />}
          disabled={disabled || squads.length === 0}
          onClick={() => onDraft({ name: "", squadId: squads[0]?.id ?? "", goal: "" })}
        >
          New recipe
        </Button>
      </div>
      {draft ? (
        <form
          className={styles.recipeForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.name.trim() && draft.squadId) void onSave(draft);
          }}
        >
          <TextInput
            aria-label="Recipe name"
            placeholder="Release readiness"
            value={draft.name}
            onChange={(event) => onDraft({ ...draft, name: event.target.value })}
          />
          <Select
            aria-label="Recipe squad"
            value={draft.squadId}
            onChange={(event) => onDraft({ ...draft, squadId: event.target.value })}
          >
            {squads.map((squad) => (
              <option key={squad.id} value={squad.id}>
                {squad.name}
              </option>
            ))}
          </Select>
          <TextInput
            aria-label="Recipe goal override"
            placeholder="Optional goal override"
            value={draft.goal}
            onChange={(event) => onDraft({ ...draft, goal: event.target.value })}
          />
          <Button size="sm" type="submit" icon={<Save aria-hidden="true" />} disabled={disabled || !draft.name.trim()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDraft(null)}>
            Cancel
          </Button>
        </form>
      ) : null}
      {recipes.length > 0 ? (
        <div className={styles.recipeList}>
          {recipes.map((recipe) => {
            const squad = squads.find((candidate) => candidate.id === recipe.squadId);
            return (
              <div key={recipe.id} className={styles.recipeRow}>
                <span className={styles.recipeIcon}>
                  <Route aria-hidden="true" />
                </span>
                <span className={styles.recipeCopy}>
                  <strong>{recipe.name}</strong>
                  <small>
                    {squad?.name ?? "Squad unavailable"}
                    {recipe.goal ? ` · ${recipe.goal}` : ""}
                  </small>
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Play aria-hidden="true" />}
                  busy={busy === `recipe:${recipe.id}`}
                  disabled={disabled || !squad || Boolean(busy)}
                  onClick={() => onLaunch(recipe)}
                >
                  Launch
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete ${recipe.name}`}
                  icon={<Trash2 aria-hidden="true" />}
                  onClick={() => onDelete(recipe.id)}
                />
              </div>
            );
          })}
        </div>
      ) : !draft ? (
        <p className={styles.quietEmpty}>
          MAX Squad recipes save a common team goal for one-action launches and KalVoice.
        </p>
      ) : null}
    </div>
  );
}

function SquadEditor({
  headingId,
  value,
  providers,
  accounts,
  hierarchyVisible,
  catalogLoading,
  catalogError,
  error,
  saving,
  onHierarchy,
  onReloadAccounts,
  onAccountConnected,
  onChange,
  onCancel,
  onSubmit,
}: {
  headingId: string;
  value: SquadDefinition;
  providers: readonly ProviderOption[];
  accounts: readonly ProviderAccount[];
  hierarchyVisible: boolean;
  catalogLoading: boolean;
  catalogError: string | null;
  error: string | null;
  saving: boolean;
  onHierarchy(value: boolean): void;
  onReloadAccounts(): Promise<unknown>;
  onAccountConnected(account: ProviderAccount): void;
  onChange(value: SquadDefinition): void;
  onCancel(): void;
  onSubmit(event: FormEvent): void;
}) {
  const collisions = ownershipCollisions(value.members);
  const missingAccounts = value.members.filter(
    (member) =>
      !accounts.some(
        (account) =>
          account.id === member.providerAccountId &&
          account.providerId === member.providerId &&
          account.archivedAt === null,
      ) && !(catalogError && Boolean(member.providerAccountId.trim())),
  );
  const updateMember = (key: string, change: (member: SquadMemberDefinition) => SquadMemberDefinition) =>
    onChange({ ...value, members: value.members.map((member) => (member.key === key ? change(member) : member)) });
  return (
    <Dialog.Root open onOpenChange={(open) => (!open && !saving ? onCancel() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.editorBackdrop} />
        <Dialog.Content asChild>
          <form className={styles.editor} aria-labelledby={headingId} onSubmit={onSubmit}>
            <header className={styles.editorHeader}>
              <div>
                <span className={styles.eyebrow}>Reusable real agents</span>
                <Dialog.Title asChild>
                  <h2 id={headingId}>{value.name.trim() ? `Edit ${value.name}` : "New squad"}</h2>
                </Dialog.Title>
                <Dialog.Description className={styles.visuallyHidden}>
                  Configure the provider, account, model, work ownership and optional hierarchy for every coding agent.
                </Dialog.Description>
              </div>
              <Button
                size="sm"
                variant="ghost"
                icon={<X aria-hidden="true" />}
                aria-label="Close squad editor"
                onClick={onCancel}
              />
            </header>
            <div className={styles.editorIntro}>
              <Field htmlFor={`${headingId}-name`} label="Squad name">
                <TextInput
                  id={`${headingId}-name`}
                  autoFocus
                  value={value.name}
                  onChange={(event) => onChange({ ...value, name: event.target.value })}
                  placeholder="Orion Release Crew"
                />
              </Field>
              <Field htmlFor={`${headingId}-goal`} label="Shared goal" optional>
                <TextArea
                  id={`${headingId}-goal`}
                  value={value.goal}
                  onChange={(event) => onChange({ ...value, goal: event.target.value })}
                  placeholder="Launch ready for direction, or give everyone a shared outcome"
                  rows={2}
                />
              </Field>
            </div>
            {catalogLoading ? (
              <p className={styles.formWarning} role="status">
                Loading provider accounts and exact model choices…
              </p>
            ) : catalogError ? (
              <p className={styles.formWarning}>{catalogError} Reload or connect accounts before saving.</p>
            ) : null}
            <div className={styles.editorToolbar}>
              <div>
                <h3>Members</h3>
                <p>Each member launches as its own real coding terminal.</p>
              </div>
              <div>
                {hierarchyVisible || value.members.length >= 8 || value.members.some((member) => member.managerKey) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Layers3 aria-hidden="true" />}
                    onClick={() => onHierarchy(!hierarchyVisible)}
                  >
                    {hierarchyVisible ? "Hide managers" : "Use managers"}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Plus aria-hidden="true" />}
                  onClick={() =>
                    onChange({
                      ...value,
                      members: [...value.members, newMember(value.members.length + 1, providers, accounts)],
                    })
                  }
                >
                  Add member
                </Button>
              </div>
            </div>
            <div className={styles.memberEditors}>
              {value.members.map((member, index) => {
                const provider = providers.find((candidate) => candidate.id === member.providerId);
                const providerAccounts = accounts.filter(
                  (candidate) => candidate.providerId === member.providerId && candidate.archivedAt === null,
                );
                const efforts = AGENT_EFFORTS[member.providerId as PaneProviderId] ?? [];
                const selectedAccount = providerAccounts.find((candidate) => candidate.id === member.providerAccountId);
                const persistedAccountUnavailable = Boolean(catalogError && member.providerAccountId.trim());
                return (
                  <fieldset key={member.key} className={styles.memberEditor}>
                    <legend>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      {member.name || "New member"}
                    </legend>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={styles.removeMember}
                      icon={<Trash2 aria-hidden="true" />}
                      aria-label={`Remove ${member.name || `member ${index + 1}`}`}
                      disabled={value.members.length === 1}
                      onClick={() =>
                        onChange({
                          ...value,
                          members: value.members
                            .filter((candidate) => candidate.key !== member.key)
                            .map((candidate) => ({
                              ...candidate,
                              dependsOn: candidate.dependsOn.filter((key) => key !== member.key),
                              managerKey: candidate.managerKey === member.key ? null : candidate.managerKey,
                            })),
                        })
                      }
                    />
                    <div className={styles.memberFields}>
                      <Field htmlFor={`${member.key}-name`} label="Name">
                        <TextInput
                          id={`${member.key}-name`}
                          value={member.name}
                          onChange={(event) =>
                            updateMember(member.key, (current) => ({ ...current, name: event.target.value }))
                          }
                        />
                      </Field>
                      <Field
                        htmlFor={`${member.key}-role`}
                        label="Role"
                        optional
                        hint="Use a template or write your own."
                      >
                        <TextInput
                          id={`${member.key}-role`}
                          list={`${member.key}-role-templates`}
                          value={member.role}
                          onChange={(event) =>
                            updateMember(member.key, (current) => ({ ...current, role: event.target.value }))
                          }
                        />
                        <datalist id={`${member.key}-role-templates`}>
                          {ROLE_TEMPLATES.map((role) => (
                            <option key={role} value={role} />
                          ))}
                        </datalist>
                      </Field>
                      <Field htmlFor={`${member.key}-provider`} label="Provider">
                        <Select
                          id={`${member.key}-provider`}
                          value={member.providerId}
                          onChange={(event) => {
                            const next = providers.find((candidate) => candidate.id === event.target.value);
                            const candidates = accounts.filter(
                              (candidate) =>
                                candidate.providerId === event.target.value && candidate.archivedAt === null,
                            );
                            const nextAccount =
                              candidates.find((candidate) => candidate.isDefault) ??
                              candidates.find((candidate) => candidate.authenticationState === "authenticated") ??
                              candidates[0];
                            updateMember(member.key, (current) => ({
                              ...current,
                              providerId: event.target.value,
                              providerAccountId: nextAccount?.id ?? "",
                              model: next?.models.find((model) => model.isDefault)?.id ?? "",
                              effort: "",
                            }));
                          }}
                        >
                          {providers.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.displayName}
                            </option>
                          ))}
                          {!provider ? (
                            <option value={member.providerId}>{providerName(member.providerId)}</option>
                          ) : null}
                        </Select>
                      </Field>
                      <Field htmlFor={`${member.key}-account`} label="Account">
                        <Select
                          id={`${member.key}-account`}
                          value={member.providerAccountId}
                          disabled={providerAccounts.length === 0}
                          onChange={(event) =>
                            updateMember(member.key, (current) => ({
                              ...current,
                              providerAccountId: event.target.value,
                            }))
                          }
                        >
                          {providerAccounts.length === 0 ? <option value="">No account connected</option> : null}
                          {member.providerAccountId &&
                          !providerAccounts.some((candidate) => candidate.id === member.providerAccountId) ? (
                            <option value={member.providerAccountId}>Unavailable account</option>
                          ) : null}
                          {providerAccounts.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {accountName(candidate)}
                              {candidate.isDefault ? " · Default" : ""}
                            </option>
                          ))}
                        </Select>
                        {!selectedAccount && !persistedAccountUnavailable ? (
                          <div className={styles.accountMissing}>
                            <span>Select an active account before saving.</span>
                            {providerAccounts.length === 0 ? (
                              <InlineAccountConnection
                                providerId={member.providerId}
                                account={undefined}
                                reloadAccounts={onReloadAccounts}
                                disabled={catalogLoading || saving}
                                onConnected={async (connected) => {
                                  onAccountConnected(connected);
                                  updateMember(member.key, (current) => ({
                                    ...current,
                                    providerAccountId: connected.id,
                                  }));
                                }}
                              />
                            ) : null}
                          </div>
                        ) : null}
                        {persistedAccountUnavailable ? (
                          <p className={styles.catalogAccountNote}>
                            Account list unavailable. This saved account will be verified when the Squad launches.
                          </p>
                        ) : null}
                        {selectedAccount?.authenticationState === "not_authenticated" ? (
                          <InlineAccountConnection
                            providerId={member.providerId}
                            account={selectedAccount}
                            reloadAccounts={onReloadAccounts}
                            reconnect
                            disabled={catalogLoading || saving}
                            onConnected={async (connected) => {
                              onAccountConnected(connected);
                              updateMember(member.key, (current) => ({ ...current, providerAccountId: connected.id }));
                            }}
                          />
                        ) : null}
                      </Field>
                      <Field htmlFor={`${member.key}-model`} label="Model">
                        <Select
                          id={`${member.key}-model`}
                          value={member.model}
                          onChange={(event) =>
                            updateMember(member.key, (current) => ({ ...current, model: event.target.value }))
                          }
                        >
                          <option value="">Provider default</option>
                          {provider?.models.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.displayName}
                            </option>
                          ))}
                          {member.model && !provider?.models.some((model) => model.id === member.model) ? (
                            <option value={member.model}>{member.model}</option>
                          ) : null}
                        </Select>
                      </Field>
                      <Field htmlFor={`${member.key}-effort`} label="Effort">
                        <Select
                          id={`${member.key}-effort`}
                          value={member.effort}
                          onChange={(event) =>
                            updateMember(member.key, (current) => ({ ...current, effort: event.target.value }))
                          }
                        >
                          <option value="">Provider default</option>
                          {efforts.map((effort) => (
                            <option key={effort} value={effort}>
                              {effortLabel(effort)}
                            </option>
                          ))}
                          {member.effort && !efforts.includes(member.effort) ? (
                            <option value={member.effort}>{member.effort}</option>
                          ) : null}
                        </Select>
                      </Field>
                      <Field htmlFor={`${member.key}-task`} label="Launch task" optional>
                        <TextArea
                          id={`${member.key}-task`}
                          value={member.task ?? ""}
                          onChange={(event) =>
                            updateMember(member.key, (current) => ({ ...current, task: event.target.value || null }))
                          }
                          placeholder="Start at the provider prompt, or give this agent its first task"
                          rows={2}
                        />
                      </Field>
                      <Field
                        htmlFor={`${member.key}-paths`}
                        label="Owned paths"
                        optional
                        hint="One path per line. KalCode warns before overlapping work."
                      >
                        <TextArea
                          id={`${member.key}-paths`}
                          value={member.ownedPaths.join("\n")}
                          onChange={(event) =>
                            updateMember(member.key, (current) => ({
                              ...current,
                              ownedPaths: event.target.value.split(/\r?\n/),
                            }))
                          }
                          placeholder="apps/desktop/src/updater"
                          rows={2}
                        />
                      </Field>
                    </div>
                    <div className={styles.relationships}>
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={member.worktree}
                          onChange={(event) =>
                            updateMember(member.key, (current) => ({ ...current, worktree: event.target.checked }))
                          }
                        />
                        <GitBranch aria-hidden="true" />
                        <span>
                          <strong>Isolated worktree</strong>
                          <small>Merge compatible work independently</small>
                        </span>
                      </label>
                      {value.members.length > 1 ? (
                        <div className={styles.depends}>
                          <span>Starts after</span>
                          {value.members
                            .filter((candidate) => candidate.key !== member.key)
                            .map((candidate) => (
                              <label key={candidate.key}>
                                <input
                                  type="checkbox"
                                  checked={member.dependsOn.includes(candidate.key)}
                                  onChange={(event) =>
                                    updateMember(member.key, (current) => ({
                                      ...current,
                                      dependsOn: event.target.checked
                                        ? [...current.dependsOn, candidate.key]
                                        : current.dependsOn.filter((key) => key !== candidate.key),
                                    }))
                                  }
                                />
                                {candidate.name || "Unnamed member"}
                              </label>
                            ))}
                        </div>
                      ) : null}
                      {hierarchyVisible && value.members.length > 1 ? (
                        <label className={styles.inlineSelect}>
                          <span>Reports to</span>
                          <select
                            value={member.managerKey ?? ""}
                            onChange={(event) =>
                              updateMember(member.key, (current) => ({
                                ...current,
                                managerKey: event.target.value || null,
                              }))
                            }
                          >
                            <option value="">Lead</option>
                            {value.members
                              .filter((candidate) => candidate.key !== member.key)
                              .map((candidate) => (
                                <option key={candidate.key} value={candidate.key}>
                                  {candidate.name || "Unnamed member"}
                                </option>
                              ))}
                          </select>
                        </label>
                      ) : null}
                    </div>
                  </fieldset>
                );
              })}
            </div>
            {collisions.length > 0 ? (
              <div className={styles.collision} role="status">
                <ShieldAlert aria-hidden="true" />
                <div>
                  <strong>Ownership guidance before launch</strong>
                  {collisions.map((collision) => (
                    <span key={`${collision.path}:${collision.undeclared}`}>
                      <code>{collision.path}</code> ·{" "}
                      {collision.undeclared
                        ? "shared checkout ownership is undeclared; tasks run sequentially"
                        : collision.mode === "shared"
                          ? "KalCode will run these edits sequentially"
                          : "resolve in the merge train"}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {error ? (
              <p className={styles.formError} role="alert">
                {error}
              </p>
            ) : null}
            <footer className={styles.editorFooter}>
              <p>
                <Bot aria-hidden="true" /> {value.members.length} real{" "}
                {value.members.length === 1 ? "terminal" : "terminals"} on every launch
              </p>
              <div>
                <Button variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  icon={<ArrowRight aria-hidden="true" />}
                  busy={saving}
                  disabled={catalogLoading || missingAccounts.length > 0}
                >
                  Save squad
                </Button>
              </div>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SquadsLoading() {
  return (
    <div className={styles.loading} role="status" aria-label="Loading Squads">
      <Skeleton width="12rem" height="2.5rem" />
      <Skeleton width="100%" height="10rem" />
      <Skeleton width="100%" height="14rem" />
    </div>
  );
}
