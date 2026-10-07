import type {
  OperationDetail,
  OperationRecord,
  OperationsSnapshot,
  ProviderAccount,
  ThreadOptions,
  ThreadSummary,
} from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountPhase, AccountTier } from "../../ipc/account.ts";
import type { OperationsApi } from "../../ipc/operations.ts";
import type { SquadsApi } from "../../ipc/squads.ts";
import { focusOperationsTarget } from "../../kalvoice/sceneOperations.ts";
import { FAVORITES_STORAGE_KEY } from "../../shell/favorites/store.ts";
import { OperationsPage } from "./OperationsPage.tsx";

const seams = vi.hoisted(() => ({
  refresh: vi.fn(async () => undefined),
  openInPane: vi.fn(async () => ({ handled: true, message: "" })),
  activate: vi.fn(async () => true),
  createTerminal: vi.fn(async () => ({ id: "terminal-created" })),
  snapshot: null as OperationsSnapshot | null,
  navigate: vi.fn(),
  account: null as { snapshot: { phase: AccountPhase; tier: AccountTier | null } } | null,
  agents: [] as ThreadSummary[],
  providerAccounts: [] as ProviderAccount[],
  accountStates: new Map<string, { models?: unknown }>(),
  discoverModels: vi.fn(),
}));

vi.mock("./useOperations.ts", () => ({
  useOperations: () => ({
    snapshot: seams.snapshot,
    observedAt: seams.snapshot?.observedAt ?? null,
    loading: false,
    refreshing: false,
    error: null,
    refresh: seams.refresh,
  }),
}));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useOptionalWorkspaces: () => ({ active: { id: "workspace-1" } }),
  useWorkspaces: () => ({
    state: "ready",
    active: { id: "workspace-1", name: "KalCode" },
    workspaces: [
      { id: "workspace-1", name: "KalCode" },
      { id: "workspace-2", name: "Other" },
    ],
    activate: seams.activate,
    createTerminal: seams.createTerminal,
  }),
}));
vi.mock("../../shell/panes/useOpenInPane.ts", () => ({ useOpenInPane: () => seams.openInPane }));
vi.mock("../../shell/navigation.tsx", () => ({
  useNavigation: () => ({ current: "operations", navigate: seams.navigate }),
}));
vi.mock("../../account/AccountProvider.tsx", () => ({ useOptionalAccount: () => seams.account }));
vi.mock("../dashboard/data/DashboardData.tsx", () => ({
  useCodingAgents: () => ({ state: { status: "ready", data: seams.agents } }),
  useOptionalAllThreads: () => seams.agents,
}));
vi.mock("../providers/ProviderAccountSessions.tsx", () => ({
  useOptionalProviderAccountSessions: () => ({
    accounts: seams.providerAccounts,
    states: seams.accountStates,
    discoverModels: seams.discoverModels,
  }),
}));
vi.mock("../squads/SquadsPanel.tsx", () => ({
  SquadsPanel: ({ workspaceId }: { workspaceId: string }) => <div>Squads for {workspaceId}</div>,
}));

function queued(id: string, position: number): OperationRecord {
  return {
    id,
    spec: {
      name: `Task ${id}`,
      workspaceId: "workspace-1",
      kind: "test",
      command: "pnpm test",
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
    },
    source: "operations",
    status: "queued",
    workspaceName: "KalCode",
    branch: "main",
    version: null,
    accountLabel: null,
    terminalId: null,
    threadId: null,
    createdAt: "2026-09-30T12:00:00Z",
    startedAt: null,
    endedAt: null,
    currentAction: null,
    outcome: null,
    position,
    blockers: [],
  };
}

function baseSnapshot(): OperationsSnapshot {
  return {
    revision: 7,
    paused: true,
    items: [queued("one", 1), queued("two", 2)],
    services: [],
    environments: [],
    activity: [],
    observedAt: "2026-09-30T12:00:00Z",
    warnings: [],
  };
}

const options: ThreadOptions = {
  providers: [
    {
      id: "codex",
      displayName: "Codex",
      accountLabel: null,
      models: [{ id: "gpt-6", displayName: "GPT-6", isDefault: true }],
      supportsResume: true,
      supportsInterrupt: true,
      hostApprovals: true,
      permissionMappings: [],
    },
  ],
  workspaces: [{ id: "workspace-1", name: "KalCode" }],
  permissionModes: ["approve"],
  defaultPermissionMode: "approve",
};

function operations(): OperationsApi {
  return {
    snapshot: vi.fn(),
    detail: vi.fn(),
    history: vi.fn(),
    enqueue: vi.fn(),
    update: vi.fn(),
    reorder: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    hold: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    runNow: vi.fn(async () => undefined),
    serviceAction: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
  } as OperationsApi;
}

function renderPage(client: OperationsApi) {
  return render(page(client));
}

function account(id: string, displayName: string, extra: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id,
    providerId: "codex",
    displayName,
    providerReportedIdentity: null,
    authenticationState: "authenticated",
    isDefault: false,
    createdAt: "2026-09-30T12:00:00Z",
    lastUsedAt: null,
    lastCheckedAt: null,
    lastErrorCode: null,
    archivedAt: null,
    ...extra,
  };
}

function page(client: OperationsApi, squads?: SquadsApi) {
  return (
    <ToastProvider>
      <OperationsPage client={client} squads={squads} threadOptions={async () => options} />
    </ToastProvider>
  );
}

describe("OperationsPage", () => {
  it("opens the unified Squads view against the active workspace", async () => {
    seams.snapshot = baseSnapshot();
    const squads = {} as SquadsApi;
    render(page(operations(), squads));

    await userEvent.setup().click(screen.getByRole("tab", { name: "Squads" }));
    expect(screen.getByText("Squads for workspace-1")).toBeVisible();
  });

  it("favorites a run from its row and context menu without opening or running it", async () => {
    localStorage.removeItem(FAVORITES_STORAGE_KEY);
    const client = operations();
    const run = { ...queued("favorite", 1), status: "succeeded" as const };
    seams.snapshot = { ...baseSnapshot(), items: [run] };
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Runs" }));
    const favorite = screen.getByRole("button", { name: "Add Favorite: Task favorite" });
    await user.click(favorite);
    expect(JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) ?? "{}").entries).toEqual([
      expect.objectContaining({
        target: { kind: "run", id: "favorite", workspaceId: "workspace-1" },
        scopeId: "workspace-1",
      }),
    ]);
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Task favorite.*No current action/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove Favorite" }));
    expect(JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) ?? "{}").entries).toEqual([]);
    expect(client.detail).not.toHaveBeenCalled();
    expect(client.runNow).not.toHaveBeenCalled();
    expect(client.cancel).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    seams.snapshot = baseSnapshot();
    seams.account = null;
    seams.agents = [];
    seams.providerAccounts = [];
    seams.accountStates = new Map();
    seams.discoverModels.mockClear();
    vi.clearAllMocks();
  });

  it("shows a live run's provider-reported selector and current exact account nickname", async () => {
    const run = queued("live-identity", 1);
    run.status = "running";
    run.startedAt = run.createdAt;
    run.threadId = "thread-live-identity";
    run.accountLabel = "Old nickname";
    run.spec = {
      ...run.spec,
      kind: "agent",
      providerId: "codex",
      providerAccountId: "codex-work",
      model: "configured/model-v1",
      effort: "high",
    };
    seams.snapshot = { ...baseSnapshot(), items: [run] };
    seams.providerAccounts = [account("codex-work", "Current nickname")];
    seams.agents = [
      {
        id: run.threadId,
        name: "Live identity",
        providerId: "codex",
        providerName: "Codex",
        providerAccountId: "codex-work",
        accountLabel: "Old nickname",
        model: "configured/model-v1",
        effort: "high",
        activeModel: "provider/model-v2",
        activeEffort: "ultra",
      } as ThreadSummary & { activeModel: string; activeEffort: string },
    ];
    const client = operations();
    vi.mocked(client.detail).mockResolvedValue({
      run,
      timeline: [],
      logs: null,
      files: [],
      artifacts: [],
      tests: [],
      relatedServices: [],
      relatedDeployments: [],
      notes: [],
    });

    renderPage(client);
    await userEvent.setup().click(screen.getByRole("button", { name: /^Task live-identity/ }));
    const detail = await screen.findByRole("complementary", { name: "Run details" });
    expect(within(detail).getByText("Runtime")).toBeVisible();
    expect(within(detail).getByText("Codex · Current nickname · provider/model-v2 · ultra")).toBeVisible();
    expect(within(detail).getByText("Codex · Current nickname · provider/model-v2 · ultra")).toHaveAttribute(
      "title",
      expect.stringContaining("Selected model: configured/model-v1"),
    );
  });

  it("labels a queued or historical run's unconfirmed launch selectors as selected", async () => {
    const run = queued("configured-identity", 1);
    run.status = "succeeded";
    run.startedAt = run.createdAt;
    run.endedAt = run.createdAt;
    run.accountLabel = "Work";
    run.spec = {
      ...run.spec,
      kind: "agent",
      providerId: "codex",
      providerAccountId: "codex-work",
      model: "configured/model-v1",
      effort: "high",
    };
    seams.snapshot = { ...baseSnapshot(), items: [run] };
    const client = operations();
    vi.mocked(client.detail).mockResolvedValue({
      run,
      timeline: [],
      logs: null,
      files: [],
      artifacts: [],
      tests: [],
      relatedServices: [],
      relatedDeployments: [],
      notes: [],
    });

    renderPage(client);
    await userEvent.setup().click(screen.getByRole("button", { name: /^Task configured-identity/ }));
    const detail = await screen.findByRole("complementary", { name: "Run details" });
    expect(within(detail).getByText("Launch settings")).toBeVisible();
    expect(within(detail).getByText("Codex · Work · configured/model-v1 (selected) · high (selected)")).toBeVisible();
  });

  it("keeps a completed run's observed selector when its thread is reused by a later run", async () => {
    const run = queued("historical-identity", 1) as OperationRecord & {
      observedProviderId?: string | null;
      observedProviderAccountId?: string | null;
      observedAccountLabel?: string | null;
      observedModel?: string | null;
      observedEffort?: string | null;
    };
    run.status = "succeeded";
    run.startedAt = run.createdAt;
    run.endedAt = run.createdAt;
    run.threadId = "thread-reused";
    run.observedProviderId = "codex";
    run.observedProviderAccountId = "codex-history";
    run.observedAccountLabel = "Old historical nickname";
    run.observedModel = "provider/model-a";
    run.observedEffort = "high";
    run.spec = {
      ...run.spec,
      kind: "agent",
      providerId: "codex",
      providerAccountId: "codex-work",
      model: "configured/model-v1",
      effort: "medium",
    };
    seams.snapshot = { ...baseSnapshot(), items: [run] };
    seams.providerAccounts = [account("codex-history", "Current historical nickname"), account("codex-work", "Work")];
    seams.agents = [
      {
        id: run.threadId,
        name: "Later run",
        providerId: "codex",
        providerName: "Codex",
        providerAccountId: "codex-work",
        accountLabel: "Work",
        model: "configured/model-v2",
        effort: "ultra",
        activeModel: "provider/model-b",
        activeEffort: "ultra",
      } as ThreadSummary & { activeModel: string; activeEffort: string },
    ];
    const client = operations();
    vi.mocked(client.detail).mockResolvedValue({
      run,
      timeline: [],
      logs: null,
      files: [],
      artifacts: [],
      tests: [],
      relatedServices: [],
      relatedDeployments: [],
      notes: [],
    });

    renderPage(client);
    expect(screen.getByRole("button", { name: /^Task historical-identity/ })).toHaveTextContent(
      "provider/model-a · high",
    );
    expect(screen.getByRole("button", { name: /^Task historical-identity/ })).not.toHaveTextContent("provider/model-b");
    await userEvent.setup().click(screen.getByRole("button", { name: /^Task historical-identity/ }));
    const detail = await screen.findByRole("complementary", { name: "Run details" });
    expect(within(detail).getByText("Observed runtime")).toBeVisible();
    expect(within(detail).getByText("Codex · Current historical nickname · provider/model-a · high")).toBeVisible();
  });

  it("does not revive an earlier observed selector after the live thread resets it to unknown", () => {
    const run = queued("reset-live-identity", 1);
    run.status = "running";
    run.startedAt = run.createdAt;
    run.threadId = "thread-reset";
    run.observedProviderId = "codex";
    run.observedProviderAccountId = "codex-old";
    run.observedModel = "provider/model-old";
    run.observedEffort = "high";
    run.spec = {
      ...run.spec,
      kind: "agent",
      providerId: "codex",
      providerAccountId: "codex-old",
      model: "configured/model-old",
      effort: "high",
    };
    seams.snapshot = { ...baseSnapshot(), items: [run] };
    seams.providerAccounts = [account("codex-new", "Current account")];
    seams.agents = [
      {
        id: run.threadId,
        name: "Reset live identity",
        providerId: "codex",
        providerName: "Codex",
        providerAccountId: "codex-new",
        accountLabel: "Current account",
        model: "configured/model-new",
        effort: "medium",
        activeModel: null,
        activeEffort: null,
      } as ThreadSummary & { activeModel: null; activeEffort: null },
    ];

    renderPage(operations());
    const row = screen.getByRole("button", { name: /^Task reset-live-identity/ });
    expect(row).toHaveTextContent("Codex · Current account · configured/model-new (selected) · medium (selected)");
    expect(row).not.toHaveTextContent("provider/model-old");
  });

  it("preserves a historically observed unbound account instead of borrowing the configured account", () => {
    const run = queued("historical-unbound", 1);
    run.status = "succeeded";
    run.startedAt = run.createdAt;
    run.endedAt = run.createdAt;
    run.observedProviderId = "codex";
    run.observedModel = "provider/model-a";
    run.spec = {
      ...run.spec,
      kind: "agent",
      providerId: "codex",
      providerAccountId: "codex-configured",
      model: "configured/model-v1",
    };
    seams.snapshot = { ...baseSnapshot(), items: [run] };
    seams.providerAccounts = [account("codex-configured", "Configured account")];

    renderPage(operations());
    const row = screen.getByRole("button", { name: /^Task historical-unbound/ });
    expect(row).toHaveTextContent("Codex · Account unavailable · provider/model-a");
    expect(row).not.toHaveTextContent("Configured account");
  });

  it("keeps durable identity on an unresolved historical turn when the thread later reports another run", () => {
    const run = queued("unresolved-history", 1);
    run.source = "thread";
    run.status = "unknown";
    run.startedAt = run.createdAt;
    run.endedAt = null;
    run.threadId = "thread-reused-unknown";
    run.observedProviderId = "codex";
    run.observedProviderAccountId = "codex-history";
    run.observedAccountLabel = "Historical";
    run.observedModel = "provider/model-a";
    run.observedEffort = "high";
    run.spec = { ...run.spec, kind: "agent", providerId: "codex" };
    seams.snapshot = { ...baseSnapshot(), items: [run] };
    seams.providerAccounts = [account("codex-history", "Historical")];
    seams.agents = [
      {
        id: run.threadId,
        name: "Later run",
        providerId: "codex",
        providerName: "Codex",
        providerAccountId: "codex-later",
        accountLabel: "Later",
        model: "configured/model-b",
        effort: "ultra",
        activeModel: "provider/model-b",
        activeEffort: "ultra",
      } as ThreadSummary & { activeModel: string; activeEffort: string },
    ];

    renderPage(operations());
    const row = screen.getByRole("button", { name: /^Task unresolved-history/ });
    expect(row).toHaveTextContent("Codex · Historical · provider/model-a · high");
    expect(row).not.toHaveTextContent("provider/model-b");
  });

  it("resumes a paused queue from its header badge", async () => {
    const client = operations();
    renderPage(client);
    await userEvent.click(await screen.findByRole("button", { name: "Queue paused · Resume" }));
    expect(client.pause).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("acknowledges voice focus only after the requested Operations tab is focused", async () => {
    const client = operations();
    renderPage(client);
    let pending!: Promise<boolean>;
    act(() => {
      pending = focusOperationsTarget({ kind: "tab", tab: "services" }, { timeoutMs: 500 });
    });
    const focused = await pending;
    expect(focused).toBe(true);
    const tab = screen.getByRole("tab", { name: "Services" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveAttribute("data-kalvoice-focused", "true");
    expect(tab).toHaveFocus();
  });

  it("registers the focus handoff when the live Operations snapshot arrives after mount", async () => {
    seams.snapshot = null;
    const client = operations();
    const view = renderPage(client);
    let pending!: Promise<boolean>;
    act(() => {
      pending = focusOperationsTarget({ kind: "tab", tab: "services" }, { timeoutMs: 500 });
    });
    seams.snapshot = baseSnapshot();
    view.rerender(page(client));
    await expect(pending).resolves.toBe(true);
    const tab = screen.getByRole("tab", { name: "Services" });
    expect(tab).toHaveAttribute("data-kalvoice-focused", "true");
    expect(tab).toHaveFocus();
  });

  it("switches workspace before acknowledging a cross-workspace run target", async () => {
    const crossWorkspace = queued("cross-workspace", 1);
    crossWorkspace.spec.workspaceId = "workspace-2";
    crossWorkspace.workspaceName = "Other";
    crossWorkspace.status = "failed";
    crossWorkspace.startedAt = crossWorkspace.createdAt;
    crossWorkspace.endedAt = crossWorkspace.createdAt;
    seams.snapshot = { ...baseSnapshot(), items: [...baseSnapshot().items, crossWorkspace] };
    const client = operations();
    vi.mocked(client.detail).mockResolvedValue({
      run: crossWorkspace,
      timeline: [],
      logs: null,
      files: [],
      artifacts: [],
      tests: [],
      relatedServices: [],
      relatedDeployments: [],
      notes: [],
    });
    renderPage(client);
    let pending!: Promise<boolean>;
    act(() => {
      pending = focusOperationsTarget(
        {
          kind: "run",
          tab: "runs",
          runId: crossWorkspace.id,
          workspaceId: "workspace-2",
          label: crossWorkspace.spec.name,
        },
        { timeoutMs: 500 },
      );
    });
    const focused = await pending;
    expect(focused).toBe(true);
    expect(screen.getByRole("combobox", { name: "Workspace" })).toHaveValue("workspace-2");
    const row = screen.getByRole("button", { name: /^Task cross-workspace/ });
    expect(row).toHaveAttribute("data-kalvoice-focused", "true");
    expect(row).toHaveFocus();
  });

  it("returns false when a stale target has no canonical rendered row", async () => {
    const client = operations();
    vi.mocked(client.detail).mockRejectedValue(new Error("Run not found"));
    renderPage(client);
    let pending!: Promise<boolean>;
    act(() => {
      pending = focusOperationsTarget(
        { kind: "run", tab: "runs", runId: "missing", workspaceId: "workspace-1", label: "Missing" },
        { timeoutMs: 500 },
      );
    });
    const focused = await pending;
    expect(focused).toBe(false);
    expect(screen.queryByRole("button", { name: /Missing/ })).not.toBeInTheDocument();
  });

  it("opens the same queued identity from Now after execution starts", async () => {
    const run = queued("queue-to-run", 1);
    const client = operations();
    vi.mocked(client.detail).mockResolvedValue({
      run,
      timeline: [],
      logs: null,
      files: [],
      artifacts: [],
      tests: [],
      relatedServices: [],
      relatedDeployments: [],
      notes: [],
    });
    seams.snapshot = { ...baseSnapshot(), items: [run] };
    const user = userEvent.setup();
    const view = renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "Run now" }));
    expect(client.runNow).toHaveBeenCalledWith(run.id);
    run.status = "running";
    run.startedAt = run.createdAt;
    seams.snapshot = { ...seams.snapshot, revision: 8, items: [run] };
    view.rerender(page(client));
    expect(screen.queryByRole("list", { name: "Pending tasks" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open run Task queue-to-run" }));
    expect(client.detail).toHaveBeenCalledWith(run.id);
    expect(await screen.findByRole("complementary", { name: "Run details" })).toHaveTextContent(run.spec.name);
  });

  it("projects a run's services, deployment and activity from the shared snapshot and refreshes them", async () => {
    const run = queued("connected", 1);
    run.status = "succeeded";
    run.startedAt = run.createdAt;
    run.endedAt = run.createdAt;
    run.spec.kind = "deploy";
    run.spec.environment = "preview";
    const service = {
      id: "service-connected",
      runId: run.id,
      name: "Linked server",
      status: "running",
      pid: 123,
      processName: "node",
      uptimeSeconds: 10,
      ports: [3000],
      urls: [],
      workspaceId: "workspace-1",
      workspaceName: "KalCode",
      terminalId: null,
      canStop: false,
      canRestart: false,
      actionReason: null,
    };
    const environment = {
      workspaceId: "workspace-1",
      kind: "preview" as const,
      branch: "main",
      version: "revision-one",
      urls: [],
      deploymentStatus: "deployed_unverified",
      health: "not_probed",
      platform: null,
      lastDeploy: run.endedAt,
      runId: run.id,
      variables: [],
      observedAt: run.createdAt,
      notes: ["A newer deployment failed; the preceding deployment remains shown."],
    };
    seams.snapshot = {
      ...baseSnapshot(),
      items: [run],
      services: [
        service,
        { ...service, id: "unrelated", runId: "other", name: "Unrelated server" },
        { ...service, id: "foreign", workspaceId: "workspace-2", name: "Foreign workspace server" },
      ],
      environments: [environment],
      activity: [
        {
          id: "event-connected",
          at: run.createdAt,
          kind: "deploy",
          name: "Deployment completed",
          area: "Environments",
          workspaceId: "workspace-1",
          runId: run.id,
        },
      ],
    };
    const client = operations();
    vi.mocked(client.detail).mockResolvedValue({
      run,
      timeline: [],
      logs: null,
      files: [],
      artifacts: [{ name: "Build bundle", location: "dist/app.zip", kind: "reported_file" }],
      tests: [],
      relatedServices: [],
      relatedDeployments: [],
      notes: [],
    });
    const user = userEvent.setup();
    const view = renderPage(client);
    await user.selectOptions(screen.getByLabelText("Workspace"), "");
    await user.click(screen.getByRole("button", { name: /^Task connected/ }));
    const detail = await screen.findByRole("complementary", { name: "Run details" });
    expect(await within(detail).findByText("Linked server")).toBeInTheDocument();
    expect(within(detail).queryByText("Unrelated server")).not.toBeInTheDocument();
    expect(within(detail).queryByText("Foreign workspace server")).not.toBeInTheDocument();
    expect(within(detail).getByText("Deployed Unverified")).toBeInTheDocument();
    expect(
      within(detail).getByText("A newer deployment failed; the preceding deployment remains shown."),
    ).toBeInTheDocument();
    expect(within(detail).getByText("Deployment completed")).toBeInTheDocument();
    await user.click(within(detail).getByRole("tab", { name: "Artifacts" }));
    expect(within(detail).getByText("Build bundle")).toBeInTheDocument();
    expect(within(detail).getByText(/Reported File/)).toBeInTheDocument();
    expect(within(detail).getByText("dist/app.zip")).toBeInTheDocument();
    await user.click(within(detail).getByRole("tab", { name: "Overview" }));
    seams.snapshot = {
      ...seams.snapshot,
      services: [],
      environments: [{ ...environment, runId: "new-deploy" }],
      activity: [],
    };
    view.rerender(page(client));
    expect(within(detail).queryByText("Linked server")).not.toBeInTheDocument();
    expect(within(detail).queryByText("Deployed Unverified")).not.toBeInTheDocument();
    expect(within(detail).queryByText("Deployment completed")).not.toBeInTheDocument();
  });

  it("keeps all active runs reachable from Now when the four service slots and foreground slot are occupied", async () => {
    const runs = Array.from({ length: 5 }, (_, index) => ({
      ...queued(`active-${index}`, index),
      status: "running" as const,
      startedAt: "2026-09-30T12:00:00Z",
    }));
    seams.snapshot = { ...baseSnapshot(), items: runs };
    const client = operations();
    const fifth = runs[4];
    if (!fifth) throw new Error("Expected five active fixture runs");
    vi.mocked(client.detail).mockResolvedValue({
      run: fifth,
      timeline: [],
      logs: null,
      files: [],
      artifacts: [],
      tests: [],
      relatedServices: [],
      relatedDeployments: [],
      notes: [],
    });
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "Open run Task active-4" }));
    expect(client.detail).toHaveBeenCalledWith("active-4");
  });

  it("retains superseded deployment evidence without presenting it as the current environment", async () => {
    const run = queued("old-deployment", 1);
    run.spec = { ...run.spec, kind: "deploy", environment: "preview" };
    run.status = "succeeded";
    run.startedAt = run.createdAt;
    run.endedAt = run.createdAt;
    seams.snapshot = { ...baseSnapshot(), items: [run] };
    const client = operations();
    vi.mocked(client.detail).mockResolvedValue({
      run,
      timeline: [],
      logs: null,
      files: [],
      artifacts: [],
      tests: [],
      notes: [],
      relatedServices: [],
      relatedDeployments: [
        {
          isCurrent: false,
          environment: {
            workspaceId: run.spec.workspaceId,
            kind: "preview",
            runId: run.id,
            branch: "previous-branch",
            version: "previous-revision",
            urls: [],
            deploymentStatus: "deployed_unverified",
            health: "not_probed",
            platform: null,
            lastDeploy: run.endedAt,
            variables: [],
            observedAt: run.endedAt,
            notes: [],
          },
        },
      ],
    });
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("button", { name: /^Task old-deployment/ }));
    const detail = await screen.findByRole("complementary", { name: "Run details" });
    expect(
      await within(detail).findByText("Recorded deployment outcome · not current environment state"),
    ).toBeVisible();
    expect(within(detail).getByText("previous-branch · previous-revision")).toBeVisible();
    expect(within(detail).queryByText("Current environment")).not.toBeInTheDocument();
  });

  it.each(["test", "agent"] as const)("cancels an active Operations %s through native authority", async (kind) => {
    const run = queued("active-cancel", 1);
    run.spec.kind = kind;
    run.status = "running";
    run.startedAt = run.createdAt;
    seams.snapshot = { ...baseSnapshot(), items: [run] };
    const client = operations();
    vi.mocked(client.detail).mockResolvedValue({
      run,
      timeline: [],
      logs: "",
      files: [],
      artifacts: [],
      tests: [],
      relatedServices: [],
      relatedDeployments: [],
      notes: [],
    });
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("button", { name: /^Task active-cancel/ }));
    await user.click(await screen.findByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(client.cancel).toHaveBeenCalledWith(run.id));
    expect(seams.refresh).toHaveBeenCalled();
  });

  it("closes the active run detail when changing workspace scope", async () => {
    const run = queued("workspace-active", 1);
    run.status = "running";
    run.startedAt = run.createdAt;
    seams.snapshot = { ...baseSnapshot(), items: [run] };
    const client = operations();
    vi.mocked(client.detail).mockResolvedValue({
      run,
      timeline: [],
      logs: "",
      files: [],
      artifacts: [],
      tests: [],
      relatedServices: [],
      relatedDeployments: [],
      notes: [],
    });
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("button", { name: /^Task workspace-active/ }));
    await screen.findByRole("button", { name: "Cancel run" });
    await user.selectOptions(screen.getByLabelText("Workspace"), "workspace-2");
    expect(screen.queryByRole("complementary", { name: "Run details" })).not.toBeInTheDocument();
    expect(client.cancel).not.toHaveBeenCalled();
  });

  it("keeps observed active runs read-only", async () => {
    const run = queued("observed-active", 1);
    run.source = "thread";
    run.status = "running";
    run.startedAt = run.createdAt;
    seams.snapshot = { ...baseSnapshot(), items: [run] };
    const client = operations();
    vi.mocked(client.detail).mockResolvedValue({
      run,
      timeline: [],
      logs: "",
      files: [],
      artifacts: [],
      tests: [],
      relatedServices: [],
      relatedDeployments: [],
      notes: [],
    });
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("button", { name: /^Task observed-active/ }));
    await screen.findByRole("heading", { name: "Task observed-active" });
    expect(screen.queryByRole("button", { name: "Cancel run" })).not.toBeInTheDocument();
    expect(client.cancel).not.toHaveBeenCalled();
  });

  it("loads older workspace history when its recent snapshot is empty", async () => {
    const other = queued("other-workspace", 1);
    other.spec.workspaceId = "workspace-2";
    other.status = "succeeded";
    other.startedAt = other.createdAt;
    const older = queued("older-workspace-run", 2);
    older.status = "succeeded";
    older.startedAt = "2026-09-29T12:00:00Z";
    seams.snapshot = { ...baseSnapshot(), items: [other] };
    const client = operations();
    vi.mocked(client.history).mockResolvedValue({ items: [older], nextCursor: null });
    const user = userEvent.setup();
    renderPage(client);
    expect(screen.getByText("No runs recorded")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByRole("button", { name: /^Task older-workspace-run/ })).toBeVisible();
    expect(client.history).toHaveBeenCalledWith(null);
  });

  it("offers keyboard-accessible queue reordering against the current revision", async () => {
    const client = operations();
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "Move Task one down" }));
    await waitFor(() => expect(client.reorder).toHaveBeenCalledWith(["two", "one"], 7));
  });

  it("offers Run now, not Resume, for a paused Squad member", async () => {
    const member = { ...queued("member", 0), status: "paused" as const };
    member.spec = { ...member.spec, name: "Squad reviewer" };
    const ordinary = { ...queued("ordinary", 1), status: "paused" as const };
    ordinary.spec = { ...ordinary.spec, name: "Held build" };
    seams.snapshot = { ...baseSnapshot(), items: [member, ordinary] };
    const squads = {
      snapshot: vi.fn(async () => ({
        squads: [],
        recipes: [],
        operations: [],
        launches: [
          {
            id: "launch-1",
            squadId: "squad-1",
            name: "Crew",
            goal: "Review",
            workspaceId: "workspace-1",
            createdAt: "2026-10-06T12:00:00Z",
            members: [{ key: "reviewer", role: "review", managerKey: null, operationId: member.id, ownedPaths: [] }],
          },
        ],
      })),
    } as unknown as SquadsApi;
    const client = operations();
    const user = userEvent.setup();
    render(page(client, squads));
    await user.click(screen.getByRole("tab", { name: "Queue" }));

    const row = (id: string) => document.querySelector(`[data-operations-queue-id="${id}"]`) as HTMLElement;
    await waitFor(() => expect(within(row(member.id)).queryByRole("button", { name: "Resume" })).toBeNull());
    await user.click(within(row(member.id)).getByRole("button", { name: "Run now" }));
    expect(client.runNow).toHaveBeenCalledExactlyOnceWith(member.id);
    expect(within(row(ordinary.id)).getByRole("button", { name: "Resume" })).toBeVisible();
  });

  it("names dependency blockers without changing an explicitly Later dependency", async () => {
    const later = queued("later-dependency", 2);
    later.spec = { ...later.spec, name: "Prepare artifacts", lane: "later" };
    const next = queued("next-dependent", 1);
    next.spec = {
      ...next.spec,
      name: "Publish preview",
      lane: "next",
      dependencies: [later.id, "missing-dependency"],
    };
    next.status = "blocked";
    next.blockers = [later.id, "missing-dependency", "Run now to authorize this task."];
    seams.snapshot = { ...baseSnapshot(), items: [next, later] };
    const client = operations();
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Queue" }));

    expect(screen.getByText(/Blocked: Prepare artifacts \(Later\).*Unavailable dependency/)).toBeVisible();
    expect(screen.getByText(/Run now to authorize this task\./)).toBeVisible();
    const nextColumn = screen.getByRole("heading", { name: "Next" }).closest("section");
    const laterColumn = screen.getByRole("heading", { name: "Later" }).closest("section");
    expect(within(nextColumn as HTMLElement).getByText("Publish preview")).toBeVisible();
    expect(within(laterColumn as HTMLElement).getByText("Prepare artifacts")).toBeVisible();
    expect(client.update).not.toHaveBeenCalled();
    expect(client.reorder).not.toHaveBeenCalled();
  });

  it("shows unobserved environments honestly and visually distinguishes Production", async () => {
    const client = operations();
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Environments" }));
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(screen.getAllByText("Not observed").length).toBeGreaterThanOrEqual(4);
    const production = screen.getByRole("article", { name: "Production environment" });
    expect(within(production).getByText(/production changes use native admission/i)).toBeVisible();
    expect(screen.queryByText(/^Live$/)).not.toBeInTheDocument();
  });

  it("routes service restart through native Operations authority", async () => {
    seams.snapshot = {
      ...baseSnapshot(),
      services: [
        {
          id: "service-1",
          runId: "run-1",
          name: "Web",
          status: "running",
          pid: 3100,
          processName: "node",
          uptimeSeconds: 90,
          ports: [3000],
          urls: ["http://localhost:3000"],
          workspaceId: "workspace-1",
          workspaceName: "KalCode",
          terminalId: "terminal-1",
          canStop: true,
          canRestart: true,
          actionReason: null,
        },
      ],
    };
    const client = operations();
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Services" }));
    await user.click(screen.getByRole("button", { name: /restart/i }));
    await waitFor(() => expect(client.serviceAction).toHaveBeenCalledWith("service-1", "restart"));
  });

  it("admits only one service mutation before its busy state renders", async () => {
    seams.snapshot = {
      ...baseSnapshot(),
      services: [
        {
          id: "service-once",
          runId: "run-1",
          name: "Web",
          status: "running",
          pid: 3100,
          processName: "node",
          uptimeSeconds: 90,
          ports: [3000],
          urls: ["http://localhost:3000"],
          workspaceId: "workspace-1",
          workspaceName: "KalCode",
          terminalId: "terminal-1",
          canStop: true,
          canRestart: true,
          actionReason: null,
        },
      ],
    };
    let finish!: () => void;
    const client = operations();
    vi.mocked(client.serviceAction).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Services" }));
    const restart = screen.getByRole("button", { name: /restart/i });

    act(() => {
      fireEvent.click(restart);
      fireEvent.click(restart);
    });
    expect(client.serviceAction).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    await waitFor(() => expect(restart).not.toBeDisabled());
  });

  it("creates and opens a terminal in the service workspace when no terminal is retained", async () => {
    seams.snapshot = {
      ...baseSnapshot(),
      services: [
        {
          id: "service-observed",
          runId: null,
          name: "API",
          status: "running",
          pid: 3200,
          processName: "node",
          uptimeSeconds: 40,
          ports: [4000],
          urls: ["http://localhost:4000"],
          workspaceId: "workspace-2",
          workspaceName: "Other",
          terminalId: null,
          canStop: false,
          canRestart: false,
          actionReason: "Observed outside Operations.",
        },
      ],
    };
    const client = operations();
    const user = userEvent.setup();
    renderPage(client);
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace" }), "");
    await user.click(screen.getByRole("tab", { name: "Services" }));
    await user.click(screen.getByRole("button", { name: "Open terminal" }));

    await waitFor(() => expect(seams.activate).toHaveBeenCalledWith("workspace-2"));
    expect(seams.createTerminal).toHaveBeenCalledWith(null, "workspace-2");
    expect(seams.openInPane).toHaveBeenCalledWith(
      { kind: "terminal", terminalId: "terminal-created" },
      { workspaceId: "workspace-2" },
    );
  });

  it("opens a retained service terminal without creating a replacement", async () => {
    seams.snapshot = {
      ...baseSnapshot(),
      services: [
        {
          id: "service-managed",
          runId: "run-service",
          name: "Frontend",
          status: "running",
          pid: 3300,
          processName: "node",
          uptimeSeconds: 80,
          ports: [3000],
          urls: ["http://localhost:3000"],
          workspaceId: "workspace-1",
          workspaceName: "KalCode",
          terminalId: "terminal-retained",
          canStop: true,
          canRestart: true,
          actionReason: null,
        },
      ],
    };
    const client = operations();
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Services" }));
    await user.click(screen.getByRole("button", { name: "Open terminal" }));

    expect(seams.createTerminal).not.toHaveBeenCalled();
    expect(seams.openInPane).toHaveBeenCalledWith(
      { kind: "terminal", terminalId: "terminal-retained" },
      { workspaceId: "workspace-1" },
    );
  });

  it("refreshes active run logs when observedAt advances without a revision change", async () => {
    const active = queued("active", 1);
    active.status = "running";
    active.startedAt = "2026-09-30T12:00:00Z";
    seams.snapshot = { ...baseSnapshot(), items: [active] };
    const client = operations();
    vi.mocked(client.detail)
      .mockResolvedValueOnce({
        run: active,
        timeline: [],
        logs: "first log frame",
        files: [],
        artifacts: [],
        tests: [],
        relatedServices: [],
        relatedDeployments: [],
        notes: [],
      })
      .mockResolvedValueOnce({
        run: active,
        timeline: [],
        logs: "second log frame",
        files: [],
        artifacts: [],
        tests: [],
        relatedServices: [],
        relatedDeployments: [],
        notes: [],
      });
    const user = userEvent.setup();
    const view = renderPage(client);
    await user.click(screen.getByRole("button", { name: /^Task active/i }));
    await waitFor(() => expect(client.detail).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("tab", { name: "Logs" }));
    expect(screen.getByText("first log frame")).toBeVisible();

    seams.snapshot = {
      ...baseSnapshot(),
      items: [active],
      revision: 7,
      observedAt: "2026-09-30T12:00:03Z",
    };
    view.rerender(page(client));
    await waitFor(() => expect(client.detail).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("second log frame")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
  });

  it("loads run details through the Strict Mode effect replay", async () => {
    const active = queued("strict-active", 1);
    active.status = "running";
    active.startedAt = "2026-09-30T12:00:00Z";
    seams.snapshot = { ...baseSnapshot(), items: [active] };
    const client = operations();
    vi.mocked(client.detail).mockResolvedValue({
      run: active,
      timeline: [],
      logs: "strict mode evidence",
      files: [],
      artifacts: [],
      tests: [],
      relatedServices: [],
      relatedDeployments: [],
      notes: [],
    });
    const user = userEvent.setup();
    render(<StrictMode>{page(client)}</StrictMode>);
    await user.click(screen.getByRole("button", { name: /^Task strict-active/i }));

    expect(await screen.findByRole("heading", { name: "Task strict-active" })).toBeVisible();
    expect(client.detail).toHaveBeenCalledTimes(1);
  });

  it("coalesces active detail refreshes behind one in-flight request", async () => {
    const active = queued("active", 1);
    active.status = "running";
    active.startedAt = "2026-09-30T12:00:00Z";
    seams.snapshot = { ...baseSnapshot(), items: [active] };
    const client = operations();
    let resolveFirst!: (value: OperationDetail) => void;
    vi.mocked(client.detail)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValue({
        run: active,
        timeline: [],
        logs: "latest frame",
        files: [],
        artifacts: [],
        tests: [],
        relatedServices: [],
        relatedDeployments: [],
        notes: [],
      });
    const user = userEvent.setup();
    const view = renderPage(client);
    await user.click(screen.getByRole("button", { name: /^Task active/i }));
    await waitFor(() => expect(client.detail).toHaveBeenCalledTimes(1));

    seams.snapshot = { ...baseSnapshot(), items: [active], observedAt: "2026-09-30T12:00:03Z" };
    view.rerender(page(client));
    seams.snapshot = { ...baseSnapshot(), items: [active], observedAt: "2026-09-30T12:00:06Z" };
    view.rerender(page(client));
    expect(client.detail).toHaveBeenCalledTimes(1);

    resolveFirst({
      run: active,
      timeline: [],
      logs: "first frame",
      files: [],
      artifacts: [],
      tests: [],
      relatedServices: [],
      relatedDeployments: [],
      notes: [],
    });
    await waitFor(() => expect(client.detail).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("tab", { name: "Logs" }));
    expect(await screen.findByText("latest frame")).toBeVisible();
  });

  it("keeps a started paused agent in Runs and Now without pending task actions", async () => {
    const pausedAgent = queued("paused-agent", 1);
    pausedAgent.status = "paused";
    pausedAgent.startedAt = "2026-09-30T12:00:00Z";
    pausedAgent.spec = {
      ...pausedAgent.spec,
      name: "Paused provider turn",
      kind: "agent",
      command: null,
      prompt: "Continue the implementation",
      providerId: "codex",
      model: "gpt-6",
    };
    seams.snapshot = { ...baseSnapshot(), items: [pausedAgent] };
    const client = operations();
    const user = userEvent.setup();
    renderPage(client);

    expect(screen.getByRole("button", { name: /^Paused provider turn/i })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Queue" }));
    const now = screen.getByRole("heading", { name: "Now" }).closest("section");
    expect(now).not.toBeNull();
    expect(within(now as HTMLElement).getByText("Paused provider turn")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Pending tasks" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move Paused provider turn/ })).not.toBeInTheDocument();
    expect(client.runNow).not.toHaveBeenCalled();
    expect(client.reorder).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
  });

  it("extends run history without replacing fresher snapshot status", async () => {
    const current = queued("current", 0);
    current.status = "succeeded";
    current.startedAt = "2026-09-30T12:00:00Z";
    current.endedAt = "2026-09-30T12:02:00Z";
    current.outcome = "Fresh snapshot result";
    const stale = { ...current, status: "failed" as const, outcome: "Stale history result" };
    const older = queued("older", 0);
    older.spec = { ...older.spec, name: "Older regression run" };
    older.status = "succeeded";
    older.createdAt = "2026-09-29T12:00:00Z";
    older.startedAt = "2026-09-29T12:00:00Z";
    older.endedAt = "2026-09-29T12:03:00Z";
    seams.snapshot = { ...baseSnapshot(), items: [current] };
    const client = operations();
    vi.mocked(client.history).mockResolvedValue({ items: [stale, older], nextCursor: null });
    const user = userEvent.setup();
    renderPage(client);

    await user.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByText("Older regression run")).toBeVisible();
    expect(screen.getByText("Fresh snapshot result")).toBeVisible();
    expect(screen.queryByText("Stale history result")).not.toBeInTheDocument();
    expect(client.history).toHaveBeenCalledWith(null);
  });

  it("keeps unknown historical evidence reachable without presenting it as active or complete", async () => {
    const current = queued("current", 0);
    current.status = "succeeded";
    current.startedAt = "2026-09-30T12:00:00Z";
    current.endedAt = "2026-09-30T12:01:00Z";
    const unknown = queued("historical", 0);
    unknown.spec = { ...unknown.spec, name: "Historical agent turn" };
    unknown.source = "agent";
    unknown.status = "unknown";
    unknown.createdAt = "2026-09-29T12:00:00Z";
    unknown.startedAt = "2026-09-29T12:00:00Z";
    const older = queued("older", 0);
    older.spec = { ...older.spec, name: "Earlier verified run" };
    older.status = "succeeded";
    older.createdAt = "2026-09-28T12:00:00Z";
    older.startedAt = "2026-09-28T12:00:00Z";
    older.endedAt = "2026-09-28T12:01:00Z";
    seams.snapshot = { ...baseSnapshot(), items: [current] };
    const client = operations();
    vi.mocked(client.history)
      .mockResolvedValueOnce({ items: [unknown], nextCursor: "opaque:page-2" })
      .mockResolvedValueOnce({ items: [older], nextCursor: null });
    vi.mocked(client.detail).mockResolvedValue({
      run: unknown,
      logs: "",
      timeline: [],
      files: [],
      artifacts: [],
      tests: [],
      relatedServices: [],
      relatedDeployments: [],
      notes: [],
    });
    const user = userEvent.setup();
    renderPage(client);

    await user.click(screen.getByRole("button", { name: "Load older" }));
    const historical = await screen.findByRole("button", { name: /^Historical agent turn/ });
    expect(historical).toHaveTextContent("Unknown");
    expect(historical).toHaveTextContent("Unavailable");
    await user.click(historical);
    const detail = await screen.findByRole("complementary", { name: "Run details" });
    expect(within(detail).getByText("Current action unavailable.")).toBeVisible();
    expect(within(detail).getByText("Completion evidence unavailable.")).toBeVisible();
    await user.click(within(detail).getByRole("button", { name: "Close run details" }));
    await user.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByText("Earlier verified run")).toBeVisible();
    expect(vi.mocked(client.history).mock.calls).toEqual([[null], ["opaque:page-2"]]);

    await user.click(screen.getByRole("tab", { name: "Queue" }));
    expect(screen.queryByText("Historical agent turn")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move Historical agent turn/ })).not.toBeInTheDocument();
  });

  it("clears provider-only fields when an agent task changes to a command", async () => {
    const client = operations();
    vi.mocked(client.enqueue).mockResolvedValue(queued("created", 3));
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Inspect runtime");
    await user.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "agent");
    await user.selectOptions(await screen.findByRole("combobox", { name: "Provider" }), "codex");
    await user.selectOptions(screen.getByRole("combobox", { name: "Model" }), "gpt-6");
    await user.type(screen.getByRole("textbox", { name: "Prompt" }), "Inspect the runtime");
    await user.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "script");
    await user.type(screen.getByRole("textbox", { name: "Command" }), "pnpm inspect");
    await user.click(screen.getByRole("button", { name: "Add to queue" }));

    await waitFor(() => expect(client.enqueue).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.enqueue).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        kind: "script",
        command: "pnpm inspect",
        prompt: null,
        providerId: null,
        providerAccountId: null,
        model: null,
        effort: null,
      }),
    );
  });

  it("fences an older-history response after the workspace changes", async () => {
    const current = queued("current", 0);
    current.status = "succeeded";
    current.startedAt = "2026-09-30T12:00:00Z";
    seams.snapshot = { ...baseSnapshot(), items: [current] };
    const client = operations();
    let resolveHistory!: (value: { items: OperationRecord[]; nextCursor: string | null }) => void;
    vi.mocked(client.history).mockReturnValue(
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
    );
    const stale = queued("stale", 0);
    stale.spec = { ...stale.spec, name: "Wrong workspace history", workspaceId: "workspace-2" };
    stale.workspaceName = "Other";
    stale.status = "succeeded";
    stale.startedAt = "2026-09-29T12:00:00Z";
    const user = userEvent.setup();
    renderPage(client);

    await user.click(screen.getByRole("button", { name: "Load older" }));
    await user.selectOptions(screen.getByLabelText("Workspace"), "workspace-2");
    expect(await screen.findByText("No runs recorded")).toBeVisible();
    await act(async () => resolveHistory({ items: [stale], nextCursor: null }));
    expect(screen.queryByText("Wrong workspace history")).not.toBeInTheDocument();
  });

  it("names the saved permission mode agent tasks actually start in", async () => {
    // Native starts operation agents in the saved startable default (the same value
    // `thread_options` reports), so the notice must not promise Auto to a Plan or Approve user.
    const user = userEvent.setup();
    renderPage(operations());
    await user.click(screen.getByRole("tab", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "agent");
    await screen.findByRole("combobox", { name: "Provider" });
    const notice = screen.getByText(/Agent tasks start in/);
    expect(notice).toHaveTextContent("Agent tasks start in Approve");
    expect(notice).not.toHaveTextContent("Auto");
  });

  it("lists a provider's accounts default first in natural order, with sign-in state", async () => {
    const accounts = [
      account("c10", "Codex 10"),
      account("c2", "Codex 2", { authenticationState: "not_authenticated" }),
      account("c3", "Codex 3", { isDefault: true }),
      account("c1", "Codex 1", { authenticationState: "unknown" }),
      account("old", "Codex Old", { archivedAt: "2026-09-30T12:00:00Z" }),
      account("claude", "Claude 1", { providerId: "claude-code" }),
    ];
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <OperationsPage
          client={operations()}
          threadOptions={async () => options}
          providerAccounts={async () => accounts}
        />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("tab", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "agent");
    await user.selectOptions(await screen.findByRole("combobox", { name: "Provider" }), "codex");
    const select = screen.getByRole("combobox", { name: "Account" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Provider default", "Codex 3 · Default", "Codex 1 · Not checked", "Codex 2 · Signed out", "Codex 10"]);
  });

  it("uses the selected account's runtime model catalog instead of provider-wide defaults", async () => {
    const selected = account("codex-work", "Work");
    seams.accountStates = new Map([
      [
        selected.id,
        {
          models: {
            status: "available",
            source: "runtime",
            observedAt: Date.now(),
            reason: null,
            items: [
              {
                id: "account/model-v2",
                displayName: "Account Model V2",
                isDefault: true,
                defaultEffort: null,
                supportedEfforts: [],
              },
            ],
          },
        },
      ],
    ]);
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <OperationsPage
          client={operations()}
          threadOptions={async () => options}
          providerAccounts={async () => [selected]}
        />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "agent");
    await user.selectOptions(await screen.findByRole("combobox", { name: "Provider" }), "codex");
    await user.selectOptions(screen.getByRole("combobox", { name: "Account" }), selected.id);
    const model = screen.getByRole("combobox", { name: "Model" });
    expect(within(model).getByRole("option", { name: "Account Model V2 · account/model-v2" })).toBeVisible();
    expect(within(model).queryByRole("option", { name: "GPT-6" })).toBeNull();
  });

  it("describes provider default as provider-controlled when account discovery fails", async () => {
    const selected = account("codex-work", "Work");
    seams.accountStates = new Map([
      [
        selected.id,
        {
          models: {
            status: "unavailable",
            source: "runtime",
            observedAt: null,
            reason: null,
            items: [],
          },
        },
      ],
    ]);
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <OperationsPage
          client={operations()}
          threadOptions={async () => options}
          providerAccounts={async () => [selected]}
        />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "agent");
    await user.selectOptions(await screen.findByRole("combobox", { name: "Provider" }), "codex");
    await user.selectOptions(screen.getByRole("combobox", { name: "Account" }), selected.id);
    expect(screen.getByText("Exact models are unavailable. Provider default lets the provider choose.")).toBeVisible();
    expect(screen.queryByText(/Provider default remains available/i)).not.toBeInTheDocument();
  });

  it("persists the exact account model and effort selected for an agent task", async () => {
    const selected = account("codex-work", "Work");
    seams.accountStates = new Map([
      [
        selected.id,
        {
          models: {
            status: "available",
            source: "runtime",
            observedAt: Date.now(),
            reason: null,
            supportedEfforts: ["medium", "high"],
            items: [
              {
                id: "account/model-v2",
                displayName: "Account Model V2",
                isDefault: true,
                defaultEffort: "medium",
                supportedEfforts: ["medium", "high"],
              },
            ],
          },
        },
      ],
    ]);
    const client = operations();
    vi.mocked(client.enqueue).mockResolvedValue(queued("created", 3));
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <OperationsPage client={client} threadOptions={async () => options} providerAccounts={async () => [selected]} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Inspect runtime");
    await user.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "agent");
    await user.selectOptions(await screen.findByRole("combobox", { name: "Provider" }), "codex");
    await user.selectOptions(screen.getByRole("combobox", { name: "Account" }), selected.id);
    const model = screen.getByRole("combobox", { name: "Model" });
    expect(within(model).getByRole("option", { name: "Account Model V2 · account/model-v2" })).toBeVisible();
    await user.selectOptions(model, "account/model-v2");
    const effort = screen.getByRole("combobox", { name: "Effort" });
    expect(effort).toHaveValue("medium");
    await user.selectOptions(effort, "high");
    await user.type(screen.getByRole("textbox", { name: "Prompt" }), "Inspect the runtime");
    await user.click(screen.getByRole("button", { name: "Add to queue" }));

    await waitFor(() => expect(client.enqueue).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.enqueue).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        providerId: "codex",
        providerAccountId: selected.id,
        model: "account/model-v2",
        effort: "high",
      }),
    );
  });

  it("preserves a saved exact effort while account model metadata is stale", async () => {
    const selected = account("codex-work", "Work");
    const pending = queued("stale-effort", 1);
    pending.spec = {
      ...pending.spec,
      kind: "agent",
      prompt: "Continue",
      command: null,
      providerId: "codex",
      providerAccountId: selected.id,
      model: "saved/model-v1",
      effort: "future-fast",
    };
    seams.snapshot = { ...baseSnapshot(), items: [pending] };
    seams.accountStates = new Map([
      [
        selected.id,
        {
          models: {
            status: "stale",
            source: "runtime",
            observedAt: 1,
            reason: "Model availability may have changed. Refresh models to check.",
            supportedEfforts: [],
            items: [],
          },
        },
      ],
    ]);
    const client = operations();
    vi.mocked(client.update).mockResolvedValue(pending);
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <OperationsPage client={client} threadOptions={async () => options} providerAccounts={async () => [selected]} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const effort = await screen.findByRole("combobox", { name: "Effort" });
    expect(effort).toBeEnabled();
    expect(effort).toHaveValue("future-fast");
    await user.click(screen.getByRole("button", { name: "Save task" }));

    await waitFor(() => expect(client.update).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.update).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ model: "saved/model-v1", effort: "future-fast" }),
    );
  });

  it("blocks only an effort that fresh runtime metadata proves unavailable", async () => {
    const selected = account("codex-work", "Work");
    const pending = queued("missing-effort", 1);
    pending.spec = {
      ...pending.spec,
      kind: "agent",
      prompt: "Continue",
      command: null,
      providerId: "codex",
      providerAccountId: selected.id,
      model: "account/model-v2",
      effort: "future-fast",
    };
    seams.snapshot = { ...baseSnapshot(), items: [pending] };
    seams.accountStates = new Map([
      [
        selected.id,
        {
          models: {
            status: "available",
            source: "runtime",
            observedAt: Date.now(),
            reason: null,
            supportedEfforts: [],
            items: [
              {
                id: "account/model-v2",
                displayName: "Account Model V2",
                isDefault: true,
                defaultEffort: null,
                supportedEfforts: [],
              },
            ],
          },
        },
      ],
    ]);
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <OperationsPage
          client={operations()}
          threadOptions={async () => options}
          providerAccounts={async () => [selected]}
        />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      await screen.findByText(/This effort is unavailable for Account Model V2 · account\/model-v2/i),
    ).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Effort" })).toHaveValue("future-fast");
    expect(screen.getByRole("button", { name: "Save task" })).toBeDisabled();
  });

  it("keeps a stale exact model visible and refreshes only when its selector is focused", async () => {
    const selected = account("codex-work", "Work");
    const pending = queued("stale-model", 1);
    pending.spec = {
      ...pending.spec,
      kind: "agent",
      prompt: "Continue",
      command: null,
      providerId: "codex",
      providerAccountId: selected.id,
      model: "saved/model-v1",
    };
    pending.accountLabel = "Work";
    seams.snapshot = { ...baseSnapshot(), items: [pending] };
    seams.accountStates = new Map([
      [
        selected.id,
        {
          models: {
            status: "stale",
            source: "runtime",
            observedAt: 1,
            reason: "Model availability may have changed. Refresh models to check.",
            items: [],
          },
        },
      ],
    ]);
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <OperationsPage
          client={operations()}
          threadOptions={async () => options}
          providerAccounts={async () => [selected]}
        />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const model = await screen.findByRole("combobox", { name: "Model" });
    expect(model).toHaveValue("saved/model-v1");
    expect(within(model).getByRole("option", { name: "saved/model-v1" })).toBeVisible();
    expect(screen.getByText(/Model availability may have changed/)).toBeVisible();
    expect(seams.discoverModels).not.toHaveBeenCalled();
    fireEvent.focus(model);
    expect(seams.discoverModels).toHaveBeenCalledExactlyOnceWith(selected.id);
  });

  it("requires a compatible choice only when fresh runtime discovery disproves the saved model", async () => {
    const selected = account("codex-work", "Work");
    const pending = queued("missing-model", 1);
    pending.spec = {
      ...pending.spec,
      kind: "agent",
      prompt: "Continue",
      command: null,
      providerId: "codex",
      providerAccountId: selected.id,
      model: "saved/model-v1",
    };
    pending.accountLabel = "Work";
    seams.snapshot = { ...baseSnapshot(), items: [pending] };
    seams.accountStates = new Map([
      [
        selected.id,
        {
          models: {
            status: "available",
            source: "runtime",
            observedAt: Date.now(),
            reason: null,
            items: [
              {
                id: "account/model-v2",
                displayName: "Account Model V2",
                isDefault: true,
                defaultEffort: null,
                supportedEfforts: [],
              },
            ],
          },
        },
      ],
    ]);
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <OperationsPage
          client={operations()}
          threadOptions={async () => options}
          providerAccounts={async () => [selected]}
        />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByText(/exact model is unavailable for the selected account/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save task" })).toBeDisabled();
  });

  it("names a bound account as provider and account in Queue and Runs", async () => {
    const pending = queued("bound", 1);
    pending.spec = {
      ...pending.spec,
      kind: "agent",
      providerId: "claude-code",
      providerAccountId: "a-work",
      model: "claude-opus-4-1",
      effort: "high",
    };
    pending.accountLabel = "Work";
    const run = queued("bound-run", 2);
    run.status = "succeeded";
    run.startedAt = "2026-09-30T12:00:00Z";
    run.spec = {
      ...run.spec,
      name: "Bound run",
      kind: "agent",
      providerId: "codex",
      providerAccountId: "a-2",
      model: "gpt-6.1-sol",
      effort: "xhigh",
    };
    run.accountLabel = "Codex 2";
    seams.snapshot = { ...baseSnapshot(), items: [pending, run] };
    seams.providerAccounts = [
      account("a-work", "Current work", { providerId: "claude-code" }),
      account("a-2", "Current 2"),
    ];
    const client = operations();
    vi.mocked(client.detail).mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    renderPage(client);

    expect(screen.getByRole("button", { name: /^Bound run/ })).toHaveTextContent(
      "KalCode · main · Codex · Current 2 · gpt-6.1-sol (selected) · xhigh (selected)",
    );
    await user.click(screen.getByRole("tab", { name: "Queue" }));
    const pendingList = screen.getByRole("list", { name: "Pending tasks" });
    expect(
      within(pendingList).getByText(
        "Agent · KalCode · Claude Code · Current work · claude-opus-4-1 (selected) · high (selected) · Priority 0",
      ),
    ).toBeVisible();
  });
});

describe("OperationsPage Run history plan limit", () => {
  /** Twelve finished runs, `done-01` the most recent, plus one run still working that started first. */
  function historySnapshot(): OperationsSnapshot {
    const finished = Array.from({ length: 12 }, (_, index) => {
      const run = queued(`done-${String(index + 1).padStart(2, "0")}`, 0);
      const minute = String(59 - index).padStart(2, "0");
      run.status = "succeeded";
      run.startedAt = `2026-09-30T11:${minute}:00Z`;
      run.endedAt = `2026-09-30T11:${minute}:30Z`;
      return run;
    });
    const active = queued("still-running", 0);
    active.status = "running";
    active.startedAt = "2026-09-30T10:00:00Z";
    return { ...baseSnapshot(), items: [...finished, active] };
  }

  function shownRunIds(): string[] {
    const history = screen.getByRole("region", { name: "Execution history" });
    return [...history.querySelectorAll<HTMLElement>("[data-operations-run-id]")].map(
      (row) => row.dataset.operationsRunId ?? "",
    );
  }

  const allFinished = Array.from({ length: 12 }, (_, index) => `done-${String(index + 1).padStart(2, "0")}`);

  beforeEach(() => {
    seams.snapshot = historySnapshot();
    seams.account = null;
    vi.clearAllMocks();
  });

  it("shows Free its 10 most recent finished runs, keeps active runs, and points to the plans", async () => {
    const user = userEvent.setup();
    renderPage(operations());
    expect(shownRunIds()).toEqual([...allFinished.slice(0, 10), "still-running"]);
    expect(
      screen.getByText("Free shows your 10 most recent runs. Upgrade for longer Operations history."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View plans" }));
    expect(seams.navigate).toHaveBeenCalledWith("settings");
  });

  it("treats an account without an active verified plan as Free", () => {
    seams.account = { snapshot: { phase: "authenticated_unactivated", tier: null } };
    renderPage(operations());
    expect(shownRunIds()).toHaveLength(11);
    expect(screen.getByText(/Free shows your 10 most recent runs/)).toBeVisible();
  });

  it("never hides a run that is still active, however old", () => {
    const snapshot = historySnapshot();
    const blocked = queued("old-blocked", 0);
    blocked.status = "paused";
    blocked.startedAt = "2026-09-29T09:00:00Z";
    seams.snapshot = { ...snapshot, items: [...snapshot.items, blocked] };
    renderPage(operations());
    expect(shownRunIds()).toEqual([...allFinished.slice(0, 10), "still-running", "old-blocked"]);
  });

  it("still opens a finished run beyond the limit when it is requested explicitly", async () => {
    const client = operations();
    const hidden = seams.snapshot?.items.find((item) => item.id === "done-12");
    if (!hidden) throw new Error("fixture");
    vi.mocked(client.detail).mockResolvedValue({
      run: hidden,
      timeline: [],
      logs: null,
      files: [],
      artifacts: [],
      tests: [],
      relatedServices: [],
      relatedDeployments: [],
      notes: [],
    });
    renderPage(client);
    expect(shownRunIds()).not.toContain("done-12");
    let pending!: Promise<boolean>;
    act(() => {
      pending = focusOperationsTarget(
        { kind: "run", tab: "runs", runId: "done-12", workspaceId: "workspace-1", label: "Task done-12" },
        { timeoutMs: 500 },
      );
    });
    await expect(pending).resolves.toBe(true);
    expect(shownRunIds()).toContain("done-12");
    expect(await screen.findByRole("heading", { name: "Task done-12" })).toBeVisible();
  });

  it.each([
    ["Pro", { phase: "ready", tier: "pro" }],
    ["MAX", { phase: "ready", tier: "max" }],
    ["MAX 2X", { phase: "offline_grace", tier: "max2x" }],
    ["Owner", { phase: "ready", tier: "owner" }],
  ] as const)("shows %s the full run history without a plan note", (_name, snapshot) => {
    seams.account = { snapshot };
    renderPage(operations());
    expect(shownRunIds()).toEqual([...allFinished, "still-running"]);
    expect(screen.queryByText(/most recent runs/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View plans" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load older" })).toBeVisible();
  });
});
