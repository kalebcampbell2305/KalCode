import type { ThreadSummary } from "@kalcode/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { CodingAgentContextMenu } from "./CodingAgentContextMenu.tsx";

const state = vi.hoisted(() => ({
  invoke: vi.fn(),
  stopThread: vi.fn(),
  renameThread: vi.fn(),
  rebindThreadAccount: vi.fn(),
  focus: vi.fn(),
  show: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("../../runtime/RuntimeProvider.tsx", () => {
  const client = {
    transport: { invoke: state.invoke },
    stopThread: state.stopThread,
    renameThread: state.renameThread,
    rebindThreadAccount: state.rebindThreadAccount,
  };
  return { useRuntime: () => ({ client }) };
});
vi.mock("../../runtime/uiIntents.tsx", () => ({ useUiIntents: () => ({ focus: state.focus }) }));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useOptionalWorkspaces: () => ({ active: { id: "elsewhere" } }),
  useWorkspaces: () => ({ active: { id: "elsewhere" }, workspaces: [{ id: "clicked-workspace", available: true }] }),
}));
vi.mock("../../shell/panes/paneCommands.ts", () => ({ dispatchPaneCommand: state.dispatch }));
vi.mock("../providers/ProviderAccountSessions.tsx", () => ({
  useOptionalProviderAccountSessions: () => ({
    accounts: [
      {
        id: "other",
        providerId: "codex",
        archivedAt: null,
        authenticationState: "authenticated",
        displayName: "Other account",
      },
    ],
  }),
}));
vi.mock("@kalcode/ui/components", async (load) => ({
  ...(await load<typeof import("@kalcode/ui/components")>()),
  useToast: () => ({ show: state.show }),
}));

const thread = {
  id: "clicked-agent",
  name: "Review",
  providerId: "codex",
  providerAccountId: "account",
  workspaceId: "clicked-workspace",
  model: "exact-model",
  effort: "high",
  permissionMode: "plan",
  status: "idle",
  pendingApprovals: 0,
  archivedAt: null,
  runtimeKind: "interactive_pty",
} as ThreadSummary;

beforeEach(() => {
  vi.clearAllMocks();
  state.invoke.mockImplementation(async (command: string) =>
    command === "provider_pane_create" ? { ...thread, id: "duplicate" } : { running: true },
  );
  state.stopThread.mockResolvedValue({ ...thread, status: "interrupted" });
  state.focus.mockResolvedValue(undefined);
});

async function open() {
  render(
    <CodingAgentContextMenu thread={thread}>
      <button type="button">Clicked agent</button>
    </CodingAgentContextMenu>,
  );
  await waitFor(() => expect(state.invoke).toHaveBeenCalledWith("provider_pane_info", { threadId: "clicked-agent" }));
  fireEvent.contextMenu(screen.getByRole("button", { name: "Clicked agent" }));
}

it("stops the clicked coding agent directly and never offers account rebinding for its live CLI", async () => {
  await open();
  const stop = await screen.findByRole("menuitem", { name: "Stop agent" });
  expect(screen.queryByRole("menuitem", { name: "Change account" })).not.toBeInTheDocument();
  fireEvent.click(stop);
  await waitFor(() => expect(state.stopThread).toHaveBeenCalledWith("clicked-agent"));
  expect(state.focus).not.toHaveBeenCalled();
});

it("duplicates a real coding pane with the clicked agent's exact launch settings", async () => {
  await open();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate agent" }));
  await waitFor(() =>
    expect(state.invoke).toHaveBeenCalledWith(
      "provider_pane_create",
      expect.objectContaining({
        providerId: "codex",
        providerAccountId: "account",
        workspaceId: "clicked-workspace",
        model: "exact-model",
        effort: "high",
        permissionMode: "plan",
        name: null,
      }),
    ),
  );
  expect(state.focus).toHaveBeenCalledWith({ kind: "agent", agentId: "duplicate", workspaceId: "clicked-workspace" });
});

it("opens Browser beside the exact clicked agent, scoped to its workspace", async () => {
  await open();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Open Browser beside" }));
  await waitFor(() =>
    expect(state.dispatch).toHaveBeenCalledWith(
      { kind: "agent-browser-beside", threadId: "clicked-agent" },
      expect.objectContaining({ scope: "clicked-workspace", queue: true }),
    ),
  );
  expect(state.focus).toHaveBeenCalledWith({
    kind: "agent",
    agentId: "clicked-agent",
    workspaceId: "clicked-workspace",
  });
});

it("focuses the clicked agent's own terminal through the agent intent, never the Threads fallback", async () => {
  await open();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Focus" }));
  await waitFor(() =>
    expect(state.focus).toHaveBeenCalledExactlyOnceWith({
      kind: "agent",
      agentId: "clicked-agent",
      workspaceId: "clicked-workspace",
    }),
  );
});
