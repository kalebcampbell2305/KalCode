import type {
  OperationRecord,
  ProviderAccount,
  SquadDefinition,
  SquadLaunch,
  SquadsSnapshot,
  ThreadOptions,
  ThreadSummary,
} from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationsApi } from "../../ipc/operations.ts";
import type { SquadsApi } from "../../ipc/squads.ts";
import { SquadsPanel } from "./SquadsPanel.tsx";

const seams = vi.hoisted(() => ({
  focus: vi.fn(async () => undefined),
  focusOperation: vi.fn(async () => true),
  navigate: vi.fn(),
  agents: [] as ThreadSummary[],
  tier: "max",
  accountStates: new Map<string, unknown>(),
  discoverModels: vi.fn(async () => undefined),
}));

vi.mock("../../account/AccountProvider.tsx", () => ({
  useOptionalAccount: () => ({ snapshot: { phase: "ready", tier: seams.tier } }),
}));
vi.mock("../../runtime/uiIntents.tsx", () => ({ useOptionalUiIntents: () => ({ focus: seams.focus }) }));
vi.mock("../../kalvoice/sceneOperations.ts", () => ({ focusOperationsTarget: seams.focusOperation }));
vi.mock("../../shell/navigation.tsx", () => ({
  useNavigation: () => ({ current: "operations", navigate: seams.navigate }),
}));
vi.mock("../code/useLaunchAgent.ts", () => ({ useLaunchAgent: () => vi.fn() }));
vi.mock("../code/HandOffDialog.tsx", () => ({ HandOffDialog: () => <div>Handoff flow</div> }));
vi.mock("../providers/LaunchAccountPicker.tsx", () => ({
  LaunchSignIn: ({
    providerId,
    account,
    onReload,
    onConnected,
    reconnect,
  }: {
    providerId: string;
    account?: ProviderAccount;
    onReload(): Promise<unknown>;
    onConnected(account: ProviderAccount): Promise<void>;
    reconnect?: boolean;
  }) => (
    <button
      type="button"
      onClick={async () => {
        await onReload();
        await onConnected({
          id: account?.id ?? `connected-${providerId}`,
          providerId: providerId as ProviderAccount["providerId"],
          displayName: account?.displayName ?? "Work",
          providerReportedIdentity: null,
          authenticationState: "authenticated",
          isDefault: true,
          createdAt: "2026-10-05T12:00:00Z",
          lastUsedAt: null,
          lastCheckedAt: null,
          lastErrorCode: null,
          archivedAt: null,
        });
      }}
    >
      {reconnect ? `Reconnect ${account?.displayName}` : `Add ${providerId} account`}
    </button>
  ),
}));
vi.mock("../providers/ProviderAccountSessions.tsx", () => ({
  useOptionalProviderAccountSessions: () => ({
    states: seams.accountStates,
    discoverModels: seams.discoverModels,
  }),
}));
vi.mock("../dashboard/data/DashboardData.tsx", () => ({
  useCodingAgents: () => ({ state: { status: "ready", data: seams.agents }, reload: vi.fn() }),
}));
vi.mock("../dashboard/fleet/useAgentOverlaps.ts", () => ({
  useAgentOverlaps: () => ({ overlaps: [], byAgent: new Map() }),
}));
vi.mock("../dashboard/outcome/AgentOutcome.tsx", () => ({ AgentOutcome: () => <div>Observed outcome</div> }));

const squad: SquadDefinition = {
  id: "squad-orion",
  name: "Orion Release Crew",
  goal: "Ship the updater reliability pass",
  members: [
    {
      key: "lead",
      name: "Lead",
      providerId: "codex",
      providerAccountId: "codex-work",
      model: "gpt-6.1-sol",
      effort: "high",
      role: "implementation",
      task: "Implement the updater repair",
      worktree: true,
      dependsOn: [],
      managerKey: null,
      ownedPaths: ["apps/desktop/src/updater"],
    },
    {
      key: "tests",
      name: "Tests",
      providerId: "claude-code",
      providerAccountId: "claude-work",
      model: "claude-opus-4-6",
      effort: "high",
      role: "test",
      task: "Prove restart recovery",
      worktree: true,
      dependsOn: ["lead"],
      managerKey: "lead",
      ownedPaths: ["apps/desktop/tests/updater"],
    },
  ],
};

const launch: SquadLaunch = {
  id: "launch-orion",
  squadId: squad.id,
  name: squad.name,
  goal: squad.goal,
  workspaceId: "workspace",
  createdAt: "2026-10-05T12:00:00Z",
  members: [
    { key: "lead", role: "implementation", managerKey: null, operationId: "operation-lead", ownedPaths: [] },
    { key: "tests", role: "test", managerKey: "lead", operationId: "operation-tests", ownedPaths: [] },
  ],
};

function operation(
  id: string,
  status: OperationRecord["status"],
  patch: Partial<OperationRecord> & { attentionReason?: string } = {},
): OperationRecord {
  return {
    id,
    spec: {
      name: id === "operation-lead" ? "Lead" : id === "operation-tests" ? "Tests" : id,
      workspaceId: "workspace",
      kind: "agent",
      command: null,
      prompt: "Work",
      providerId: "codex",
      providerAccountId: "codex-work",
      model: "gpt-6.1-sol",
      effort: "high",
      dependencies: [],
      priority: 50,
      lane: "next",
      environment: "local",
      urls: [],
      envKeys: [],
    },
    source: "operations",
    status,
    workspaceName: "KalCode",
    branch: "feat/squads",
    version: null,
    accountLabel: "Work",
    terminalId: null,
    threadId: null,
    createdAt: "2026-10-05T12:00:00Z",
    startedAt: null,
    endedAt: null,
    currentAction: null,
    outcome: null,
    position: 0,
    blockers: [],
    ...patch,
  };
}

function agent(id: string, name: string): ThreadSummary {
  return {
    id,
    name,
    providerId: "codex",
    providerName: "Codex",
    model: "gpt-6.1-sol",
    effort: "high",
    providerAccountId: "codex-work",
    accountLabel: "Work",
    workspaceId: "workspace",
    workspaceName: "KalCode",
    permissionMode: "approve",
    status: "active",
    currentActivity: "Implementing",
    createdAt: "2026-10-05T12:00:00Z",
    lastActivityAt: "2026-10-05T12:01:00Z",
    pendingApprovals: 0,
    unreadMessages: 0,
    filesChanged: 1,
    branch: "feat/squads",
    error: null,
    archivedAt: null,
    resumable: true,
    permissionProfileId: null,
    runtimeKind: "interactive_pty",
    terminalId: `terminal-${id}`,
    worktreeId: `worktree-${id}`,
  };
}

function snapshot(): SquadsSnapshot {
  return {
    squads: [squad],
    recipes: [{ id: "recipe-release", name: "Release readiness", squadId: squad.id, goal: null }],
    launches: [launch],
    operations: [
      operation("operation-lead", "running", { threadId: "thread-lead", terminalId: "terminal-thread-lead" }),
      operation("operation-tests", "paused", {
        attentionReason: "The Claude Code account needs to sign in again.",
      }),
    ],
  };
}

const options: ThreadOptions = {
  providers: [
    {
      id: "codex",
      displayName: "Codex",
      accountLabel: null,
      models: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1", isDefault: true }],
      supportsResume: true,
      supportsInterrupt: true,
      hostApprovals: true,
      permissionMappings: [],
    },
  ],
  workspaces: [{ id: "workspace", name: "KalCode" }],
  permissionModes: ["approve"],
  defaultPermissionMode: "approve",
};

function connectedAccount(
  id: string,
  providerId: ProviderAccount["providerId"] = "codex",
  displayName = id,
): ProviderAccount {
  return {
    id,
    providerId,
    displayName,
    providerReportedIdentity: null,
    authenticationState: "authenticated",
    isDefault: id.endsWith("work"),
    createdAt: "2026-10-05T12:00:00Z",
    lastUsedAt: null,
    lastCheckedAt: null,
    lastErrorCode: null,
    archivedAt: null,
  };
}

function operations(): OperationsApi {
  return {
    snapshot: vi.fn(),
    detail: vi.fn(),
    history: vi.fn(),
    enqueue: vi.fn(),
    update: vi.fn(),
    reorder: vi.fn(),
    pause: vi.fn(),
    hold: vi.fn(),
    cancel: vi.fn(async () => undefined),
    runNow: vi.fn(async () => undefined),
    serviceAction: vi.fn(),
    openUrl: vi.fn(),
  } as OperationsApi;
}

function squads(value = snapshot()): SquadsApi {
  return {
    snapshot: vi.fn(async () => value),
    save: vi.fn(),
    delete: vi.fn(),
    saveRecipe: vi.fn(),
    deleteRecipe: vi.fn(),
    launch: vi.fn(async () => launch),
    launchRecipe: vi.fn(async () => launch),
    reassignManager: vi.fn(async () => launch),
  } as SquadsApi;
}

function view(
  client: SquadsApi,
  operationClient: OperationsApi,
  providerAccounts?: () => Promise<ProviderAccount[]>,
  threadOptions: () => Promise<ThreadOptions> = async () => options,
) {
  return render(
    <ToastProvider>
      <SquadsPanel
        client={client}
        operations={operationClient}
        workspaceId="workspace"
        threadOptions={threadOptions}
        providerAccounts={providerAccounts}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  seams.focus.mockClear();
  seams.focusOperation.mockClear();
  seams.navigate.mockClear();
  seams.agents = [agent("thread-lead", "Lead")];
  seams.tier = "max";
  seams.accountStates = new Map();
  seams.discoverModels.mockClear();
});

describe("SquadsPanel", () => {
  it("shows one shared truth and opens the exact real coding terminal", async () => {
    const client = squads();
    const operationClient = operations();
    view(client, operationClient);

    expect((await screen.findAllByRole("heading", { name: "Orion Release Crew" }))[0]).toBeVisible();
    expect(screen.getByText("The Claude Code account needs to sign in again.")).toBeVisible();
    expect(screen.getByTitle(/Lead · implementation · Codex · Work · gpt-6\.1-sol · High effort/)).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Open terminal" }));
    expect(seams.focus).toHaveBeenCalledWith({ kind: "agent", agentId: "thread-lead", workspaceId: "workspace" });
  });

  it("never saves a fake provider-default account and opens the canonical connect flow", async () => {
    const user = userEvent.setup();
    view(squads(), operations());
    await screen.findAllByRole("heading", { name: "Orion Release Crew" });

    await user.click(screen.getByRole("button", { name: "New squad" }));
    const dialog = screen.getByRole("dialog", { name: "New squad" });
    expect(within(dialog).queryByRole("button", { name: "Use managers" })).toBeNull();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save squad" })).toBeDisabled());
    expect(within(dialog).getAllByLabelText("Account")).toHaveLength(2);
    expect(
      within(dialog)
        .getAllByLabelText("Account")
        .every((select) => select.hasAttribute("disabled")),
    ).toBe(true);
    expect(within(dialog).getAllByText("Select an active account before saving.")).toHaveLength(2);

    await user.click(within(dialog).getAllByRole("button", { name: "Add codex account" })[0] as HTMLElement);
    expect(seams.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "New squad" })).toBeVisible();
    const accounts = within(dialog).getAllByLabelText("Account");
    await user.selectOptions(accounts[1] as HTMLElement, "connected-codex");
    await user.type(within(dialog).getByLabelText("Squad name"), "Atlas");
    expect(within(dialog).getByRole("button", { name: "Save squad" })).toBeEnabled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "New squad" })).toBeNull();
  });

  it("reveals optional managers only when a team reaches the scale that benefits", async () => {
    const account: ProviderAccount = {
      id: "codex-work",
      providerId: "codex",
      displayName: "Work",
      providerReportedIdentity: null,
      authenticationState: "authenticated",
      isDefault: true,
      createdAt: "2026-10-05T12:00:00Z",
      lastUsedAt: null,
      lastCheckedAt: null,
      lastErrorCode: null,
      archivedAt: null,
    };
    const user = userEvent.setup();
    view(squads(), operations(), async () => [account]);
    await screen.findAllByRole("heading", { name: "Orion Release Crew" });
    await user.click(screen.getByRole("button", { name: "New squad" }));
    const dialog = screen.getByRole("dialog", { name: "New squad" });
    await waitFor(() => expect(within(dialog).getAllByLabelText("Account")[0]).toHaveValue(account.id));

    expect(within(dialog).queryByRole("button", { name: "Use managers" })).toBeNull();
    for (let index = 0; index < 6; index += 1) {
      await user.click(within(dialog).getByRole("button", { name: "Add member" }));
    }
    expect(within(dialog).getByRole("button", { name: "Use managers" })).toBeVisible();
  });

  it("prefills new members from a usable provider account without provider-specific defaults", async () => {
    const account: ProviderAccount = {
      id: "codex-ready",
      providerId: "codex",
      displayName: "Ready",
      providerReportedIdentity: null,
      authenticationState: "authenticated",
      isDefault: true,
      createdAt: "2026-10-05T12:00:00Z",
      lastUsedAt: null,
      lastCheckedAt: null,
      lastErrorCode: null,
      archivedAt: null,
    };
    const codexProvider = options.providers[0];
    if (!codexProvider) throw new Error("Missing Codex provider fixture");
    const mixedOptions: ThreadOptions = {
      ...options,
      providers: [
        {
          ...codexProvider,
          id: "claude-code",
          displayName: "Claude Code",
          models: [{ id: "claude-opus-4-6", displayName: "Opus 4.6", isDefault: true }],
        },
        codexProvider,
      ],
    };
    const user = userEvent.setup();
    view(
      squads(),
      operations(),
      async () => [account],
      async () => mixedOptions,
    );
    await screen.findAllByRole("heading", { name: "Orion Release Crew" });
    await user.click(screen.getByRole("button", { name: "New squad" }));
    const dialog = screen.getByRole("dialog", { name: "New squad" });

    await waitFor(() =>
      expect((within(dialog).getAllByLabelText("Provider")[0] as HTMLSelectElement).value).toBe("codex"),
    );
    expect(
      within(dialog)
        .getAllByLabelText("Provider")
        .map((select) => (select as HTMLSelectElement).value),
    ).toEqual(["codex", "codex"]);
    expect(
      within(dialog)
        .getAllByLabelText("Account")
        .map((select) => (select as HTMLSelectElement).value),
    ).toEqual([account.id, account.id]);
  });

  it("uses the canonical account model catalog and resets an explicit model change to its declared effort", async () => {
    const codex = connectedAccount("codex-work", "codex", "Personal");
    const claude = connectedAccount("claude-work", "claude-code", "Work");
    const codexProvider = options.providers[0];
    if (!codexProvider) throw new Error("Missing Codex provider fixture");
    const accountOptions: ThreadOptions = {
      ...options,
      providers: [
        { ...codexProvider, models: [] },
        { ...codexProvider, id: "claude-code", displayName: "Claude Code", models: [] },
      ],
    };
    seams.accountStates = new Map([
      [
        codex.id,
        {
          models: {
            status: "available",
            reason: null,
            items: [
              {
                id: "gpt-6.1-sol",
                displayName: "Model A",
                isDefault: true,
                defaultEffort: "high",
                supportedEfforts: ["high"],
              },
              {
                id: "gpt-6.1-fast",
                displayName: "Model B",
                isDefault: false,
                defaultEffort: "medium",
                supportedEfforts: ["medium", "xhigh"],
              },
            ],
          },
        },
      ],
      [
        claude.id,
        {
          models: {
            status: "available",
            reason: null,
            items: [
              {
                id: "claude-opus-4-6",
                displayName: "Opus",
                isDefault: true,
                defaultEffort: "high",
                supportedEfforts: ["high"],
              },
            ],
          },
        },
      ],
    ]);
    const client = squads();
    const user = userEvent.setup();
    view(
      client,
      operations(),
      async () => [codex, claude],
      async () => accountOptions,
    );
    await screen.findAllByRole("heading", { name: "Orion Release Crew" });
    const library = document.querySelector<HTMLElement>(`[data-squad-id="${squad.id}"]`);
    expect(library).not.toBeNull();
    await user.click(within(library as HTMLElement).getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Orion Release Crew" });
    const model = within(dialog).getAllByLabelText("Model")[0] as HTMLSelectElement;
    const effort = within(dialog).getAllByLabelText("Effort")[0] as HTMLSelectElement;

    expect(within(model).getByRole("option", { name: "Model B" })).toBeVisible();
    expect(model).toHaveValue("gpt-6.1-sol");
    expect(effort).toHaveValue("high");
    await user.selectOptions(model, "");
    expect(effort).toHaveValue("");
    await user.selectOptions(model, "gpt-6.1-fast");
    expect(effort).toHaveValue("medium");
    expect(within(effort).queryByRole("option", { name: "High" })).toBeNull();
    expect(within(effort).getByRole("option", { name: "Extra high" })).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Save squad" }));

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        expect.objectContaining({
          members: expect.arrayContaining([
            expect.objectContaining({ key: "lead", model: "gpt-6.1-fast", effort: "medium" }),
          ]),
        }),
      ),
    );
    expect(seams.discoverModels).not.toHaveBeenCalled();
  });

  it("keeps an unavailable saved exact model visible and blocks silent replacement", async () => {
    const codex = connectedAccount("codex-work", "codex", "Personal");
    const claude = connectedAccount("claude-work", "claude-code", "Work");
    seams.accountStates = new Map([
      [
        codex.id,
        {
          models: {
            status: "available",
            reason: null,
            items: [
              {
                id: "current-model",
                displayName: "Current model",
                isDefault: true,
                defaultEffort: "medium",
                supportedEfforts: ["medium"],
              },
            ],
          },
        },
      ],
      [
        claude.id,
        {
          models: {
            status: "available",
            reason: null,
            items: [
              {
                id: "claude-opus-4-6",
                displayName: "Opus",
                isDefault: true,
                defaultEffort: "high",
                supportedEfforts: ["high"],
              },
            ],
          },
        },
      ],
    ]);
    const client = squads();
    const user = userEvent.setup();
    view(client, operations(), async () => [codex, claude]);
    await screen.findAllByRole("heading", { name: "Orion Release Crew" });
    const library = document.querySelector<HTMLElement>(`[data-squad-id="${squad.id}"]`);
    expect(library).not.toBeNull();
    await user.click(within(library as HTMLElement).getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Orion Release Crew" });
    const model = within(dialog).getAllByLabelText("Model")[0] as HTMLSelectElement;
    expect(model).toHaveValue("gpt-6.1-sol");
    expect(within(model).getByRole("option", { name: "gpt-6.1-sol" })).toBeVisible();
    expect(within(dialog).getByText(/This exact model is unavailable/)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Save squad" }));
    expect(client.save).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/Lead's exact model is unavailable/);
  });

  it("discovers models lazily for one focused member instead of probing a 100-account Squad", async () => {
    const accounts = Array.from({ length: 100 }, (_, index) => connectedAccount(`codex-${index}`));
    const template = squad.members[0];
    if (!template) throw new Error("Missing Squad member fixture");
    const members: SquadDefinition["members"] = accounts.map((account, index) => ({
      ...template,
      key: `member-${index}`,
      name: `Member ${index}`,
      providerAccountId: account.id,
      model: "",
      effort: "",
      managerKey: null,
    }));
    const largeSquad: SquadDefinition = { id: "squad-hundred", name: "Hundred", goal: "", members };
    const value: SquadsSnapshot = { squads: [largeSquad], recipes: [], launches: [], operations: [] };
    const user = userEvent.setup();
    view(squads(value), operations(), async () => accounts);
    const card = await screen.findByText("Hundred");
    const library = card.closest<HTMLElement>("[data-squad-id]");
    expect(library).not.toBeNull();
    await user.click(within(library as HTMLElement).getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Hundred" });
    await waitFor(() => expect(within(dialog).getAllByLabelText("Account")).toHaveLength(100));

    expect(seams.discoverModels).not.toHaveBeenCalled();
    fireEvent.focus(within(dialog).getAllByLabelText("Model")[42] as HTMLElement);
    expect(seams.discoverModels).toHaveBeenCalledExactlyOnceWith("codex-42");
  });

  it("keeps every create entry disabled when Squads are unavailable on the current plan", async () => {
    seams.tier = "free";
    const value: SquadsSnapshot = { squads: [], recipes: [], launches: [], operations: [] };
    view(squads(value), operations());
    await screen.findByRole("heading", { name: "Build your first squad" });

    expect(screen.getByRole("button", { name: "New squad" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create a squad" })).toBeDisabled();
  });

  it("labels and gates delivered recipes as MAX Squad recipes", async () => {
    seams.tier = "free";
    view(squads(), operations());
    await screen.findAllByRole("heading", { name: "Orion Release Crew" });

    expect(screen.getByRole("heading", { name: "Squad recipes" })).toBeVisible();
    expect(screen.getByText("MAX · Squad automation")).toBeVisible();
    expect(screen.getByRole("button", { name: "New recipe" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Launch" }).every((button) => button.hasAttribute("disabled"))).toBe(
      true,
    );
  });

  it("recovers one member and the whole affected squad through canonical Operations", async () => {
    const client = squads();
    const operationClient = operations();
    const user = userEvent.setup();
    view(client, operationClient);
    await screen.findAllByRole("heading", { name: "Orion Release Crew" });

    await user.click(screen.getByRole("button", { name: "Resume member" }));
    expect(operationClient.runNow).toHaveBeenCalledWith("operation-tests");

    await user.click(screen.getByRole("button", { name: "Resume squad" }));
    await waitFor(() => expect(operationClient.runNow).toHaveBeenCalledTimes(2));
    expect(operationClient.runNow).toHaveBeenLastCalledWith("operation-tests");
  });

  it("reconnects an unavailable exact account inline, then resumes only that member", async () => {
    const account: ProviderAccount = {
      id: "codex-work",
      providerId: "codex",
      displayName: "Work",
      providerReportedIdentity: null,
      authenticationState: "not_authenticated",
      isDefault: true,
      createdAt: "2026-10-05T12:00:00Z",
      lastUsedAt: null,
      lastCheckedAt: null,
      lastErrorCode: "signed_out",
      archivedAt: null,
    };
    const operationClient = operations();
    const user = userEvent.setup();
    view(squads(), operationClient, async () => [account]);
    await screen.findAllByRole("heading", { name: "Orion Release Crew" });

    const reconnect = await screen.findByRole("button", { name: "Reconnect Work" });
    expect(screen.queryByRole("button", { name: "Resume member" })).toBeNull();
    await user.click(reconnect);
    await waitFor(() => expect(operationClient.runNow).toHaveBeenCalledWith("operation-tests"));
    expect(operationClient.runNow).toHaveBeenCalledTimes(1);
  });

  it("reassigns a held member from an archived account through canonical Operations before resuming", async () => {
    const value = snapshot();
    const held = value.operations.find((candidate) => candidate.id === "operation-tests");
    if (!held) throw new Error("Missing held operation fixture");
    held.spec.providerAccountId = "codex-archived";
    held.accountLabel = "Former Work";
    const archived: ProviderAccount = {
      id: "codex-archived",
      providerId: "codex",
      displayName: "Former Work",
      providerReportedIdentity: null,
      authenticationState: "not_authenticated",
      isDefault: false,
      createdAt: "2026-10-01T12:00:00Z",
      lastUsedAt: null,
      lastCheckedAt: null,
      lastErrorCode: "account_removed",
      archivedAt: "2026-10-05T11:00:00Z",
    };
    const backup: ProviderAccount = {
      ...archived,
      id: "codex-backup",
      displayName: "Backup",
      authenticationState: "authenticated",
      isDefault: true,
      lastErrorCode: null,
      archivedAt: null,
    };
    const operationClient = operations();
    vi.mocked(operationClient.snapshot).mockResolvedValue({
      revision: 7,
      paused: false,
      items: value.operations,
      services: [],
      environments: [],
      activity: [],
      observedAt: "2026-10-05T12:05:00Z",
      warnings: [],
    });
    const user = userEvent.setup();
    view(squads(value), operationClient, async () => [archived, backup]);
    const replacement = await screen.findByRole("combobox", { name: "Replacement account for Tests" });

    expect(screen.queryByRole("button", { name: "Resume member" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume squad" })).toBeNull();
    await user.selectOptions(replacement, backup.id);
    await user.click(screen.getByRole("button", { name: "Use account" }));

    await waitFor(() =>
      expect(operationClient.update).toHaveBeenCalledWith(held.id, { ...held.spec, providerAccountId: backup.id }, 7),
    );
    expect(operationClient.runNow).toHaveBeenCalledWith(held.id);
  });

  it("keeps a prepared terminal's account identity immutable when its account disappears", async () => {
    const value = snapshot();
    const prepared = value.operations.find((candidate) => candidate.id === "operation-tests");
    if (!prepared) throw new Error("Missing prepared operation fixture");
    prepared.spec.providerAccountId = "codex-deleted";
    prepared.threadId = "thread-tests";
    prepared.terminalId = "terminal-thread-tests";
    seams.agents = [...seams.agents, agent("thread-tests", "Tests")];
    const backup: ProviderAccount = {
      id: "codex-backup",
      providerId: "codex",
      displayName: "Backup",
      providerReportedIdentity: null,
      authenticationState: "authenticated",
      isDefault: true,
      createdAt: "2026-10-05T12:00:00Z",
      lastUsedAt: null,
      lastCheckedAt: null,
      lastErrorCode: null,
      archivedAt: null,
    };
    const operationClient = operations();
    view(squads(value), operationClient, async () => [backup]);
    await screen.findAllByRole("heading", { name: "Orion Release Crew" });
    const row = document.querySelector<HTMLElement>('[data-squad-member-key="tests"]');
    expect(row).not.toBeNull();

    expect(within(row as HTMLElement).queryByRole("button", { name: "Resume member" })).toBeNull();
    expect(within(row as HTMLElement).queryByRole("combobox", { name: "Replacement account for Tests" })).toBeNull();
    expect(within(row as HTMLElement).getByRole("button", { name: "Open terminal" })).toBeVisible();
    expect(operationClient.update).not.toHaveBeenCalled();
  });

  it("stops all active or pending members and keeps the launch relation", async () => {
    const client = squads();
    const operationClient = operations();
    view(client, operationClient);
    await screen.findAllByRole("heading", { name: "Orion Release Crew" });

    await userEvent.setup().click(screen.getByRole("button", { name: "Stop squad" }));
    await waitFor(() => expect(operationClient.cancel).toHaveBeenCalledTimes(2));
    expect(operationClient.cancel).toHaveBeenCalledWith("operation-lead");
    expect(operationClient.cancel).toHaveBeenCalledWith("operation-tests");
    expect(client.snapshot).toHaveBeenCalled();
  });

  it("reports a partial Squad stop while preserving each canonical member result", async () => {
    const client = squads();
    const operationClient = operations();
    vi.mocked(operationClient.cancel)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Provider process did not stop"));
    view(client, operationClient);
    await screen.findAllByRole("heading", { name: "Orion Release Crew" });

    await userEvent.setup().click(screen.getByRole("button", { name: "Stop squad" }));
    expect(await screen.findByText("1 member could not stop")).toBeVisible();
    expect(operationClient.cancel).toHaveBeenCalledTimes(2);
    expect(client.snapshot).toHaveBeenCalledTimes(2);
  });

  it("reuses only a failed launch request identity and gives a deliberate later launch a new one", async () => {
    const client = squads();
    vi.mocked(client.launch)
      .mockRejectedValueOnce(new Error("The native runtime was reconnecting"))
      .mockResolvedValue(launch);
    const user = userEvent.setup();
    view(client, operations());
    await screen.findAllByRole("heading", { name: "Orion Release Crew" });
    const library = document.querySelector<HTMLElement>(`[data-squad-id="${squad.id}"]`);
    expect(library).not.toBeNull();
    const launchButton = within(library as HTMLElement).getByRole("button", { name: "Launch" });

    await user.click(launchButton);
    await screen.findByText("Launch needs attention");
    await user.click(launchButton);
    await waitFor(() => expect(client.launch).toHaveBeenCalledTimes(2));
    const firstRequest = vi.mocked(client.launch).mock.calls[0]?.[2];
    const retriedRequest = vi.mocked(client.launch).mock.calls[1]?.[2];
    expect(retriedRequest).toBe(firstRequest);

    await user.click(launchButton);
    await waitFor(() => expect(client.launch).toHaveBeenCalledTimes(3));
    expect(vi.mocked(client.launch).mock.calls[2]?.[2]).not.toBe(firstRequest);
  });

  it("keeps a Recipe draft intact when the durable save fails", async () => {
    const client = squads();
    vi.mocked(client.saveRecipe).mockRejectedValue(new Error("Store temporarily unavailable"));
    const user = userEvent.setup();
    view(client, operations());
    await screen.findAllByRole("heading", { name: "Orion Release Crew" });

    await user.click(screen.getByRole("button", { name: "New recipe" }));
    await user.type(screen.getByLabelText("Recipe name"), "Nightly confidence");
    await user.type(screen.getByLabelText("Recipe goal override"), "Verify updater recovery");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(await screen.findByText("Squad action failed")).toBeVisible();
    expect(screen.getByLabelText("Recipe name")).toHaveValue("Nightly confidence");
    expect(screen.getByLabelText("Recipe goal override")).toHaveValue("Verify updater recovery");
  });

  it("launches a saved Squad with a request identity and can reassign a manager without replacing workers", async () => {
    const client = squads();
    const operationClient = operations();
    const user = userEvent.setup();
    view(client, operationClient);
    await screen.findAllByRole("heading", { name: "Orion Release Crew" });

    const library = document.querySelector<HTMLElement>(`[data-squad-id="${squad.id}"]`);
    expect(library).not.toBeNull();
    await user.click(within(library as HTMLElement).getByRole("button", { name: "Launch" }));
    expect(client.launch).toHaveBeenCalledWith(squad.id, "workspace", expect.stringMatching(/^launch-request-/));

    await user.click(screen.getByRole("button", { name: "Reassign manager for Tests" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Manager for Tests" }), "");
    await waitFor(() => expect(client.reassignManager).toHaveBeenCalledWith(launch.id, "tests", null));
  });

  it("never offers a dead terminal retry and opens failed no-session work in canonical run details", async () => {
    const value = snapshot();
    value.operations = [
      operation("operation-lead", "failed", {
        threadId: "thread-lead",
        terminalId: "terminal-thread-lead",
        outcome: "Provider exited with code 1.",
      }),
      operation("operation-tests", "failed", { outcome: "Authentication failed before a terminal started." }),
    ];
    const user = userEvent.setup();
    view(squads(value), operations());
    await screen.findAllByRole("heading", { name: "Orion Release Crew" });
    await user.click(screen.getByRole("button", { name: "Show details" }));

    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByText("Provider exited with code 1.")).toBeVisible();
    expect(screen.getByText("Authentication failed before a terminal started.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open terminal" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Hand off" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Inspect run" }));
    expect(seams.focusOperation).toHaveBeenCalledWith({
      kind: "run",
      tab: "runs",
      runId: "operation-tests",
      workspaceId: "workspace",
      label: "Tests",
    });
  });

  it("prioritizes attention in a large Squad and expands the full roster accessibly", async () => {
    const members = Array.from({ length: 12 }, (_, index) => ({
      key: `member-${index + 1}`,
      name: `Agent ${index + 1}`,
      providerId: "codex",
      providerAccountId: "codex-work",
      model: "gpt-6.1-sol",
      effort: "high",
      role: index === 11 ? "release" : "implementation",
      task: null,
      worktree: true,
      dependsOn: [],
      managerKey: index > 0 ? "member-1" : null,
      ownedPaths: [],
    }));
    const largeSquad: SquadDefinition = { id: "squad-atlas", name: "Atlas Twelve", goal: "", members };
    const largeLaunch: SquadLaunch = {
      id: "launch-atlas",
      squadId: largeSquad.id,
      name: largeSquad.name,
      goal: "",
      workspaceId: "workspace",
      createdAt: "2026-10-05T13:00:00Z",
      members: members.map((member) => ({
        key: member.key,
        role: member.role,
        managerKey: member.managerKey,
        operationId: `operation-${member.key}`,
        ownedPaths: [],
      })),
    };
    const value: SquadsSnapshot = {
      squads: [largeSquad],
      recipes: [],
      launches: [largeLaunch],
      operations: members.map((member, index) =>
        operation(`operation-${member.key}`, index === 11 ? "paused" : "running", {
          attentionReason: index === 11 ? "Choose the release target." : undefined,
        }),
      ),
    };
    const user = userEvent.setup();
    view(squads(value), operations());

    const run = await screen.findByText("Ready for direction");
    const launchCard = run.closest<HTMLElement>("[data-squad-launch-id]");
    expect(launchCard).not.toBeNull();
    expect(within(launchCard as HTMLElement).getAllByTestId("squad-member-row")).toHaveLength(8);
    expect(within(launchCard as HTMLElement).getByText("Choose the release target.")).toBeVisible();
    expect(within(launchCard as HTMLElement).queryByRole("combobox")).toBeNull();

    await user.click(within(launchCard as HTMLElement).getByRole("button", { name: "Show all 12 members" }));
    expect(within(launchCard as HTMLElement).getAllByTestId("squad-member-row")).toHaveLength(12);
    expect(within(launchCard as HTMLElement).getByRole("button", { name: "Show priority members" })).toBeVisible();
  });

  it("explains conservative sequencing when shared-checkout ownership is undeclared", async () => {
    const value = snapshot();
    value.squads = [
      {
        ...squad,
        members: squad.members.map((member) => ({ ...member, worktree: false, ownedPaths: [] })),
      },
    ];
    view(squads(value), operations());

    expect(
      await screen.findByText("Shared checkout with undeclared ownership. KalCode will run those tasks sequentially."),
    ).toBeVisible();
  });
});
