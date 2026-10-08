import type {
  GitStatusSummary,
  OperationRecord,
  OperationsSnapshot,
  ProviderAccount,
  ThreadSummary,
} from "@kalcode/protocol";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DOCK_SURFACE_META, DockSurface } from "./DockSurfaces.tsx";

const mocks = vi.hoisted(() => ({
  deck: {
    operations: { data: null as OperationsSnapshot | null, failed: false },
    health: { data: null, failed: false },
    git: { data: null as GitStatusSummary | null, failed: false, loaded: true },
  },
  navigate: vi.fn(),
  focusOperationsTarget: vi.fn(() => Promise.resolve(true)),
  threads: [] as ThreadSummary[],
  sessions: null as {
    accounts: ProviderAccount[];
    states: Map<string, { health: { state: string; label: string; tone: string; usable: boolean } }>;
    usage: Map<
      string,
      {
        accountId: string;
        status: "fresh" | "stale" | "checking" | "unavailable" | "not_checked";
        windows: { id: string; label: string; remainingPercent: number; resetsAt: string | null }[];
        checkedAt: string | null;
        reason: string | null;
        plan?: string | null;
      }
    >;
  } | null,
  workspaces: {
    active: { id: "workspace-a", name: "Alpha" },
    workspaces: [{ id: "workspace-a", name: "Alpha" }],
  },
}));

vi.mock("./DeckData.tsx", () => ({ useDeckData: () => mocks.deck }));
vi.mock("../navigation.tsx", () => ({ useNavigation: () => ({ navigate: mocks.navigate }) }));
vi.mock("../../runtime/actions.ts", () => ({
  useKalActions: () => ({ open: vi.fn(), openInbox: vi.fn() }),
}));
vi.mock("../attention/useAttention.ts", () => ({
  useAttention: () => ({ items: [], ready: true }),
}));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => mocks.workspaces }));
vi.mock("../../surfaces/dashboard/data/DashboardData.tsx", () => ({
  useCodingAgents: () => ({ state: { status: "ready", data: mocks.threads } }),
  useOptionalAllThreads: () => mocks.threads,
}));
vi.mock("../../surfaces/providers/ProviderAccountSessions.tsx", () => ({
  useOptionalProviderAccountSessions: () => mocks.sessions,
}));
vi.mock("../../kalvoice/sceneOperations.ts", () => ({
  focusOperationsTarget: mocks.focusOperationsTarget,
}));

const run = (id: string, workspaceId: string, name: string): OperationRecord => ({
  id,
  spec: {
    name,
    workspaceId,
    kind: "test" as const,
    command: null,
    prompt: null,
    providerId: null,
    providerAccountId: null,
    model: null,
    effort: null,
    dependencies: [],
    priority: 0,
    lane: "next" as const,
    environment: "local" as const,
    urls: [],
    envKeys: [],
  },
  source: "operations",
  status: "running" as const,
  workspaceName: name,
  branch: "main",
  version: null,
  accountLabel: null,
  terminalId: null,
  threadId: null,
  createdAt: "2026-10-06T12:00:00.000Z",
  startedAt: "2026-10-06T12:00:01.000Z",
  endedAt: null,
  currentAction: "Running tests",
  outcome: null,
  position: 0,
  blockers: [],
});

function account(
  id: string,
  displayName: string,
  authenticationState: ProviderAccount["authenticationState"] = "authenticated",
  providerId: ProviderAccount["providerId"] = "codex",
) {
  return {
    id,
    providerId,
    displayName,
    providerReportedIdentity: null,
    authenticationState,
    isDefault: false,
    createdAt: "2026-10-06T12:00:00.000Z",
    lastUsedAt: null,
    lastCheckedAt: null,
    lastErrorCode: null,
    archivedAt: null,
  } satisfies ProviderAccount;
}

function sessionState(accountId: string, state: "connected" | "checking" | "expired" | "error" | "not_checked") {
  const label = {
    connected: "Connected",
    checking: "Checking",
    expired: "Expired",
    error: "Error",
    not_checked: "Not checked",
  }[state];
  return [accountId, { health: { state, label, tone: "idle", usable: state !== "expired" } }] as const;
}

function usage(accountId: string, weekly: number, rolling: number) {
  return {
    accountId,
    status: "fresh" as const,
    windows: [
      { id: "five_hour", label: "5-hour", remainingPercent: rolling, resetsAt: null },
      { id: "weekly", label: "Weekly", remainingPercent: weekly, resetsAt: null },
    ],
    checkedAt: "2026-10-06T12:00:00.000Z",
    reason: null,
  };
}

beforeEach(() => {
  mocks.navigate.mockClear();
  mocks.focusOperationsTarget.mockClear();
  mocks.threads = [];
  mocks.sessions = null;
  mocks.deck.operations = { data: null, failed: false };
  mocks.deck.git = { data: null, failed: false, loaded: true };
});

it("publishes the compact canonical surfaces expected by the dock frame", () => {
  expect(DOCK_SURFACE_META.map(({ id }) => id)).toEqual([
    "dashboard",
    "needs-you",
    "runs",
    "queue",
    "services",
    "environments",
    "activity",
    "provider-usage",
    "kalvoice",
    "git",
    "tests",
  ]);
  expect(DOCK_SURFACE_META.find(({ id }) => id === "tests")?.label).toBe("Tests / Build");
});

it("reads Runs from DeckData, filters by workspace, and opens the canonical Operations target", () => {
  mocks.deck.operations = {
    data: {
      revision: 3,
      paused: false,
      items: [run("run-a", "workspace-a", "Alpha tests"), run("run-b", "workspace-b", "Other tests")],
      services: [],
      environments: [],
      activity: [],
      observedAt: "2026-10-06T12:00:02.000Z",
      warnings: [],
    },
    failed: false,
  };

  render(<DockSurface id="runs" workspaceId="workspace-a" onOpenBrowser={vi.fn()} />);

  expect(screen.getByText("Alpha tests")).toBeInTheDocument();
  expect(screen.queryByText("Other tests")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Alpha tests/ }));
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("operations");
  expect(mocks.focusOperationsTarget).toHaveBeenCalledExactlyOnceWith({
    kind: "run",
    tab: "runs",
    runId: "run-a",
    workspaceId: "workspace-a",
    label: "Alpha tests",
  });
});

it("shows a completed run's bounded observed identity instead of a reused thread's current identity", () => {
  const historical = run("run-history", "workspace-a", "Historical review");
  historical.status = "succeeded";
  historical.endedAt = "2026-10-06T12:01:00.000Z";
  historical.threadId = "thread-reused";
  historical.spec = {
    ...historical.spec,
    kind: "agent",
    providerId: "codex",
    providerAccountId: "configured-account",
    model: "configured/model",
    effort: "medium",
  };
  historical.observedProviderId = "codex";
  historical.observedProviderAccountId = "historical-account";
  historical.observedAccountLabel = "Old historical name";
  historical.observedModel = "provider/model-a";
  historical.observedEffort = "high";
  mocks.threads = [
    {
      id: "thread-reused",
      providerId: "codex",
      providerName: "Codex",
      providerAccountId: "current-account",
      accountLabel: "Current",
      model: "configured/model-b",
      effort: "ultra",
      activeModel: "provider/model-b",
      activeEffort: "ultra",
    } as ThreadSummary,
  ];
  const historicalAccount = account("historical-account", "Renamed historical account");
  const configuredAccount = account("configured-account", "Configured account");
  mocks.sessions = {
    accounts: [historicalAccount, configuredAccount],
    states: new Map([sessionState(historicalAccount.id, "connected"), sessionState(configuredAccount.id, "connected")]),
    usage: new Map(),
  };
  mocks.deck.operations = {
    data: {
      revision: 4,
      paused: false,
      items: [historical],
      services: [],
      environments: [],
      activity: [],
      observedAt: "2026-10-06T12:02:00.000Z",
      warnings: [],
    },
    failed: false,
  };

  render(<DockSurface id="runs" workspaceId="workspace-a" onOpenBrowser={vi.fn()} />);

  const row = screen.getByRole("button", { name: /Historical review/ });
  expect(within(row).getByText("Historical review")).toBeVisible();
  expect(row).toHaveTextContent("Codex · Renamed historical account · provider/model-a · high");
  expect(row).not.toHaveTextContent("provider/model-b");
  expect(row).not.toHaveTextContent("Configured account");
});

it("shows queued launch identity as selected while keeping the task title primary", () => {
  const queued = run("queue-exact", "workspace-a", "Review exact selector");
  queued.status = "queued";
  queued.startedAt = null;
  queued.spec = {
    ...queued.spec,
    kind: "agent",
    providerId: "codex",
    providerAccountId: "work-account",
    model: "future/model-exact",
    effort: "turbo-next",
  };
  const work = account("work-account", "Work renamed");
  mocks.sessions = {
    accounts: [work],
    states: new Map([sessionState(work.id, "connected")]),
    usage: new Map(),
  };
  mocks.deck.operations = {
    data: {
      revision: 5,
      paused: false,
      items: [queued],
      services: [],
      environments: [],
      activity: [],
      observedAt: "2026-10-06T12:02:00.000Z",
      warnings: [],
    },
    failed: false,
  };

  render(<DockSurface id="queue" workspaceId="workspace-a" onOpenBrowser={vi.fn()} />);

  const row = screen.getByRole("button", { name: /Review exact selector/ });
  expect(within(row).getByText("Review exact selector")).toBeVisible();
  expect(row).toHaveTextContent("Codex · Work renamed · future/model-exact (selected) · turbo-next (selected)");
});

it("keeps weekly usage isolated by account and labels unknown authentication truthfully", () => {
  const work = account("work-account", "Work");
  const unknown = account("unknown-account", "Research", "unknown");
  mocks.sessions = {
    accounts: [work, unknown],
    states: new Map([sessionState(work.id, "connected"), sessionState(unknown.id, "not_checked")]),
    usage: new Map([
      [work.id, usage(work.id, 73, 4)],
      [unknown.id, usage(unknown.id, 41, 96)],
    ]),
  };

  render(<DockSurface id="provider-usage" workspaceId="workspace-a" onOpenBrowser={vi.fn()} />);

  const workRow = screen.getByRole("button", { name: /Work/ });
  expect(workRow).toHaveTextContent("73% left");
  expect(workRow).not.toHaveTextContent("4% left");
  const unknownRow = screen.getByRole("button", { name: /Research/ });
  expect(unknownRow).toHaveTextContent("Not checked");
  expect(unknownRow).toHaveTextContent("41% left");
  expect(unknownRow).not.toHaveTextContent("Signed out");
  expect(unknownRow).not.toHaveTextContent("73% left");
});

it("does not let a remembered plan mask unchecked or expired account health", () => {
  const unknown = account("unknown-account", "Research", "unknown");
  const expired = account("expired-account", "Former work", "not_authenticated");
  mocks.sessions = {
    accounts: [unknown, expired],
    states: new Map([sessionState(unknown.id, "not_checked"), sessionState(expired.id, "expired")]),
    usage: new Map([
      [unknown.id, { ...usage(unknown.id, 41, 96), plan: "Pro" }],
      [expired.id, { ...usage(expired.id, 18, 7), plan: "Max" }],
    ]),
  };

  render(<DockSurface id="provider-usage" workspaceId="workspace-a" onOpenBrowser={vi.fn()} />);

  const unknownRow = screen.getByRole("button", { name: /Research/ });
  expect(unknownRow).toHaveTextContent("Not checked");
  expect(unknownRow).not.toHaveTextContent("Pro");
  const expiredRow = screen.getByRole("button", { name: /Former work/ });
  expect(expiredRow).toHaveTextContent("Expired");
  expect(expiredRow).not.toHaveTextContent("Max");
});

it("shows provider and account together when different providers share a nickname", () => {
  const claude = account("claude-work", "Work", "authenticated", "claude-code");
  const codex = account("codex-work", "Work");
  mocks.sessions = {
    accounts: [claude, codex],
    states: new Map([sessionState(claude.id, "connected"), sessionState(codex.id, "connected")]),
    usage: new Map([
      [claude.id, usage(claude.id, 72, 30)],
      [codex.id, usage(codex.id, 54, 20)],
    ]),
  };

  render(<DockSurface id="provider-usage" workspaceId="workspace-a" onOpenBrowser={vi.fn()} />);

  expect(screen.getByText("Claude Code · Work").tagName).toBe("STRONG");
  expect(screen.getByText("Codex · Work").tagName).toBe("STRONG");
});

it("uses canonical account health instead of calling an unchecked account signed out or healthy", () => {
  const unknown = account("unknown-account", "Research", "unknown");
  mocks.sessions = {
    accounts: [unknown],
    states: new Map([sessionState(unknown.id, "not_checked")]),
    usage: new Map(),
  };
  mocks.deck.operations = {
    data: {
      revision: 6,
      paused: false,
      items: [],
      services: [],
      environments: [],
      activity: [],
      observedAt: "2026-10-06T12:02:00.000Z",
      warnings: [],
    },
    failed: false,
  };

  render(<DockSurface id="dashboard" workspaceId="workspace-a" onOpenBrowser={vi.fn()} />);

  const health = screen.getByRole("button", { name: /Research · Not checked/ });
  expect(health).toHaveTextContent("Research · Not checked");
  expect(health).toHaveTextContent("Not checked");
  expect(health).not.toHaveTextContent("Sign-in needed");
  expect(health).not.toHaveTextContent("Healthy");
});

it("renders Git from the shared DeckData feed without starting a second status poll", () => {
  mocks.deck.git = {
    data: {
      workspaceId: "workspace-a",
      branch: "feature/workspace-dock",
      head: "1234567890",
      changed: 2,
      untracked: 1,
      ahead: 4,
      behind: 0,
    },
    failed: false,
    loaded: true,
  };

  render(<DockSurface id="git" workspaceId="workspace-a" onOpenBrowser={vi.fn()} />);

  expect(screen.getByRole("heading", { name: "feature/workspace-dock" })).toBeInTheDocument();
  expect(screen.getByText("Dirty")).toBeInTheDocument();
  expect(screen.getByText("changed").previousElementSibling).toHaveTextContent("2");
  expect(screen.getByText("untracked").previousElementSibling).toHaveTextContent("1");
});
