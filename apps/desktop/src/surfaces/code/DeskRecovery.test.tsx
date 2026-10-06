import type { ThreadSummary } from "@kalcode/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { emptyLayout, makeLeaf } from "../../shell/panes/model.ts";
import type { PaneController } from "../../shell/panes/usePaneController.ts";
import { DeskRecovery } from "./DeskRecovery.tsx";
import type { ProviderPanes } from "./panes/useProviderPanes.ts";

const state = vi.hoisted(() => ({
  automatic: true,
  request: 0,
  client: { getThread: vi.fn(), resumeThread: vi.fn() },
}));
vi.mock("../../runtime/deskRestore.ts", () => ({ useDeskRestore: () => state }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => ({ client: state.client }) }));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => ({ active: { id: "desk" } }) }));
vi.mock("../../shell/navigation.tsx", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));

const agent = {
  id: "returning",
  name: "Saved task",
  runtimeKind: "interactive_pty",
  status: "interrupted",
  archivedAt: null,
  resumable: true,
  restartRecoverable: true,
} as ThreadSummary;
const layout = { ...emptyLayout(), root: makeLeaf([{ kind: "agent", agentId: agent.id }]) };
const controller = { ready: true, layout } as PaneController;
let panes: ProviderPanes;
beforeEach(() => {
  state.automatic = true;
  state.request = 0;
  state.client = {
    getThread: vi.fn().mockResolvedValue(agent),
    resumeThread: vi.fn().mockResolvedValue({ ...agent, status: "idle" }),
  };
  panes = {
    loaded: true,
    panes: [{ thread: agent, info: null }],
    updated: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
  } as unknown as ProviderPanes;
});

it("automatically resumes eligible saved agents exactly once after mounting", async () => {
  const view = render(<DeskRecovery controller={controller} panes={panes} active />);
  await waitFor(() => expect(state.client.resumeThread).toHaveBeenCalledTimes(1));
  view.rerender(<DeskRecovery controller={{ ...controller }} panes={{ ...panes }} active />);
  await waitFor(() => expect(panes.refresh).toHaveBeenCalledTimes(1));
  expect(state.client.resumeThread).toHaveBeenCalledWith(agent.id);
  expect(state.client.resumeThread).toHaveBeenCalledTimes(1);
});

it("manual restore waits for one click and retains the saved layout", async () => {
  state.automatic = false;
  render(<DeskRecovery controller={controller} panes={panes} active />);
  expect(state.client.resumeThread).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Continue where I left off" }));
  await waitFor(() => expect(state.client.resumeThread).toHaveBeenCalledTimes(1));
  expect(controller.layout).toEqual(layout);
});

it("a native explicit stop during restoration wins over the cached eligibility", async () => {
  state.client.getThread.mockResolvedValue({ ...agent, restartRecoverable: false, currentActivity: "Stopped by you" });
  render(<DeskRecovery controller={controller} panes={panes} active />);
  await waitFor(() => expect(panes.refresh).toHaveBeenCalled());
  expect(state.client.resumeThread).not.toHaveBeenCalled();
});

it("isolates failed recovery and offers an explicit retry without a startup loop", async () => {
  state.client.resumeThread.mockRejectedValue(new Error("Provider session expired"));
  render(<DeskRecovery controller={controller} panes={panes} active />);
  await screen.findByRole("button", { name: "Retry recovery" });
  expect(state.client.resumeThread).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry recovery" }));
  await waitFor(() => expect(state.client.resumeThread).toHaveBeenCalledTimes(2));
});

it("does not pretend an unsupported conversation resumed", () => {
  panes = { ...panes, panes: [{ thread: { ...agent, resumable: false }, info: null }] };
  render(<DeskRecovery controller={controller} panes={panes} active />);
  expect(screen.getByText(/Some agents need a fresh start/)).toBeVisible();
  expect(state.client.resumeThread).not.toHaveBeenCalled();
});

it.each(["resumed", "closed"])("clears the recovery warning when the failed agent is %s", async (action) => {
  state.client.resumeThread.mockRejectedValue(new Error("Resume failed"));
  const view = render(<DeskRecovery controller={controller} panes={panes} active />);
  await screen.findByRole("button", { name: "Retry recovery" });
  const nextPanes =
    action === "resumed"
      ? ({
          ...panes,
          panes: [
            {
              thread: { ...agent, status: "idle" as const, restartRecoverable: false },
              info: {
                threadId: agent.id,
                providerId: "codex",
                instanceId: "live",
                hookChannel: "active",
                decisionRouting: "provider_prompt",
                kalcodeAnswersApprovals: false,
                running: true,
                exitCode: null,
              },
            },
          ],
        } as ProviderPanes)
      : panes;
  view.rerender(
    <DeskRecovery
      controller={action === "closed" ? { ...controller, layout: emptyLayout() } : controller}
      panes={nextPanes}
      active
    />,
  );
  expect(screen.queryByRole("region", { name: "Desk recovery" })).not.toBeInTheDocument();
});
