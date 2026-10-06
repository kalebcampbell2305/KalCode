import type { ThreadSummary } from "@kalcode/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { emptyLayout, makeLeaf } from "../../shell/panes/model.ts";
import type { PaneController } from "../../shell/panes/usePaneController.ts";
import { DeskRecovery } from "./DeskRecovery.tsx";
import type { ProviderPanes } from "./panes/useProviderPanes.ts";

const state = vi.hoisted(() => ({
  automatic: true,
  request: 0,
  continueDesk: vi.fn(),
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
  state.continueDesk.mockImplementation(() => {
    state.request += 1;
  });
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
  expect(state.client.resumeThread).toHaveBeenCalledWith(agent.id, undefined, null, false);
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

it("holds a queued prompt through automatic and generic recovery until its dedicated action", async () => {
  state.automatic = false;
  const queued = { ...agent, id: "queued", resumeHasPendingInput: true };
  const safe = { ...agent, id: "safe" };
  const mixedLayout = {
    ...emptyLayout(),
    root: makeLeaf([
      { kind: "agent", agentId: safe.id },
      { kind: "agent", agentId: queued.id },
    ]),
  };
  const mixedController = { ...controller, layout: mixedLayout } as PaneController;
  panes = {
    ...panes,
    panes: [
      { thread: safe, info: null },
      { thread: queued, info: null },
    ],
  } as ProviderPanes;
  state.client.getThread.mockImplementation(async (id: string) => (id === queued.id ? queued : safe));
  state.client.resumeThread.mockImplementation(async (id: string) => ({
    ...(id === queued.id ? queued : safe),
    status: "idle",
    resumeHasPendingInput: false,
  }));

  render(<DeskRecovery controller={mixedController} panes={panes} active />);
  expect(
    screen.getByText(
      "1 agent has a queued prompt. Automatic restore leaves it unsent. Choose Resume queued task to continue.",
    ),
  ).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Continue where I left off" }));
  await waitFor(() => expect(state.client.resumeThread).toHaveBeenCalledWith(safe.id, undefined, null, false));
  expect(state.client.resumeThread).not.toHaveBeenCalledWith(queued.id, undefined, null, false);
  expect(state.client.resumeThread).not.toHaveBeenCalledWith(queued.id, undefined, null, true);

  fireEvent.click(screen.getByRole("button", { name: "Resume queued task" }));
  await waitFor(() => expect(state.client.resumeThread).toHaveBeenCalledWith(queued.id, undefined, null, true));
  expect(state.client.resumeThread).toHaveBeenCalledTimes(2);
});

it("does not automatically submit a queued prompt", async () => {
  const queued = { ...agent, resumeHasPendingInput: true };
  panes = { ...panes, panes: [{ thread: queued, info: null }] } as ProviderPanes;
  state.client.getThread.mockResolvedValue(queued);

  render(<DeskRecovery controller={controller} panes={panes} active />);
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  expect(screen.getByRole("button", { name: "Resume queued task" })).toBeVisible();
  expect(state.client.resumeThread).not.toHaveBeenCalled();
});

it("confirms a saved-layout reset and explains that live work stays open", async () => {
  const resetSavedLayout = vi.fn().mockResolvedValue(undefined);
  render(
    <DeskRecovery
      controller={
        {
          ...controller,
          loadError: "The saved layout is invalid.",
          retryLoad: vi.fn(),
          resettingSavedLayout: false,
          resetSavedLayout,
        } as PaneController
      }
      panes={panes}
      active
    />,
  );

  expect(screen.getByText(/Your visible desk is still available/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reset saved layout" }));
  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText(/Browser locations/)).toBeInTheDocument();
  expect(within(dialog).getByText(/Running terminals and agents stay open/)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Reset saved layout" }));

  await waitFor(() => expect(resetSavedLayout).toHaveBeenCalledOnce());
});

it("an in-Code Continue click also admits a provider that becomes available later", async () => {
  state.automatic = false;
  const late = { ...agent, id: "late-provider", resumable: false };
  const twoAgentLayout = {
    ...emptyLayout(),
    root: makeLeaf([
      { kind: "agent", agentId: agent.id },
      { kind: "agent", agentId: late.id },
    ]),
  } as const;
  const twoAgentController = { ...controller, layout: twoAgentLayout } as PaneController;
  const initialPanes = {
    ...panes,
    panes: [
      { thread: agent, info: null },
      { thread: late, info: null },
    ],
  } as ProviderPanes;
  state.client.getThread.mockImplementation(async (id: string) => ({ ...agent, id }));

  const view = render(<DeskRecovery controller={twoAgentController} panes={initialPanes} active />);
  fireEvent.click(screen.getByRole("button", { name: "Continue where I left off" }));
  await waitFor(() => expect(state.client.resumeThread).toHaveBeenCalledWith(agent.id, undefined, null, false));
  expect(state.continueDesk).toHaveBeenCalledOnce();
  expect(state.client.resumeThread).not.toHaveBeenCalledWith(late.id, undefined, null, false);

  view.rerender(
    <DeskRecovery
      controller={twoAgentController}
      panes={{
        ...initialPanes,
        panes: [
          { thread: agent, info: null },
          { thread: { ...late, resumable: true }, info: null },
        ],
      }}
      active
    />,
  );
  await waitFor(() => expect(state.client.resumeThread).toHaveBeenCalledWith(late.id, undefined, null, false));
  expect(state.client.resumeThread).toHaveBeenCalledTimes(2);
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

it("automatically admits a saved agent once when provider capability becomes available later", async () => {
  const unavailable = { ...agent, resumable: false };
  const view = render(
    <DeskRecovery controller={controller} panes={{ ...panes, panes: [{ thread: unavailable, info: null }] }} active />,
  );
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(state.client.resumeThread).not.toHaveBeenCalled();

  view.rerender(<DeskRecovery controller={controller} panes={panes} active />);
  await waitFor(() => expect(state.client.resumeThread).toHaveBeenCalledTimes(1));

  view.rerender(<DeskRecovery controller={{ ...controller }} panes={{ ...panes }} active />);
  await waitFor(() => expect(panes.refresh).toHaveBeenCalled());
  expect(state.client.resumeThread).toHaveBeenCalledTimes(1);
});

it("keeps a prior manual Continue intent until a provider capability becomes available", async () => {
  state.automatic = false;
  state.request = 1;
  const unavailable = { ...agent, resumable: false };
  const view = render(
    <DeskRecovery controller={controller} panes={{ ...panes, panes: [{ thread: unavailable, info: null }] }} active />,
  );
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(state.client.resumeThread).not.toHaveBeenCalled();

  view.rerender(<DeskRecovery controller={controller} panes={panes} active />);
  await waitFor(() => expect(state.client.resumeThread).toHaveBeenCalledTimes(1));
});

it("does not let an earlier generic Continue intent submit queued input discovered after provider refresh", async () => {
  state.automatic = false;
  state.request = 1;
  const unavailable = { ...agent, resumable: false, resumeHasPendingInput: true };
  const queued = { ...unavailable, resumable: true };
  state.client.getThread.mockResolvedValue(queued);
  const view = render(
    <DeskRecovery controller={controller} panes={{ ...panes, panes: [{ thread: unavailable, info: null }] }} active />,
  );
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(state.client.resumeThread).not.toHaveBeenCalled();

  view.rerender(
    <DeskRecovery controller={controller} panes={{ ...panes, panes: [{ thread: queued, info: null }] }} active />,
  );
  const resumeQueued = await screen.findByRole("button", { name: "Resume queued task" });
  expect(state.client.resumeThread).not.toHaveBeenCalled();

  fireEvent.click(resumeQueued);
  await waitFor(() => expect(state.client.resumeThread).toHaveBeenCalledWith(queued.id, undefined, null, true));
  expect(state.client.resumeThread).toHaveBeenCalledTimes(1);
});

it("does not recover a late-capability agent in manual mode without a Continue intent", async () => {
  state.automatic = false;
  const unavailable = { ...agent, resumable: false };
  const view = render(
    <DeskRecovery controller={controller} panes={{ ...panes, panes: [{ thread: unavailable, info: null }] }} active />,
  );
  view.rerender(<DeskRecovery controller={controller} panes={panes} active />);
  await waitFor(() => expect(panes.panes[0]?.thread.resumable).toBe(true));
  expect(state.client.resumeThread).not.toHaveBeenCalled();
});

it("does not automatically retry a failed agent when its pane summary is republished", async () => {
  state.client.resumeThread.mockRejectedValue(new Error("Provider session expired"));
  const view = render(<DeskRecovery controller={controller} panes={panes} active />);
  await screen.findByRole("button", { name: "Retry recovery" });

  view.rerender(<DeskRecovery controller={{ ...controller }} panes={{ ...panes }} active />);
  await waitFor(() => expect(panes.refresh).toHaveBeenCalled());
  expect(state.client.resumeThread).toHaveBeenCalledTimes(1);
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
