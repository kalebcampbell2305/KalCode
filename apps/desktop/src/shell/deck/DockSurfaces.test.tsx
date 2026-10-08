import type { GitStatusSummary, OperationsSnapshot } from "@kalcode/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
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
  workspaces: {
    active: { id: "workspace-a", name: "Alpha" },
    workspaces: [{ id: "workspace-a", name: "Alpha" }],
  },
}));

vi.mock("./DeckData.tsx", () => ({ useDeckData: () => mocks.deck }));
vi.mock("../navigation.tsx", () => ({ useNavigation: () => ({ navigate: mocks.navigate }) }));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => mocks.workspaces }));
vi.mock("../../kalvoice/sceneOperations.ts", () => ({
  focusOperationsTarget: mocks.focusOperationsTarget,
}));

const run = (id: string, workspaceId: string, name: string) => ({
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

beforeEach(() => {
  mocks.navigate.mockClear();
  mocks.focusOperationsTarget.mockClear();
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
