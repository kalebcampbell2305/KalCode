import type { TerminalInfo, Workspace } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { KalCodeClient } from "../../../ipc/client.ts";
import { createMemoryTransport } from "../../../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../../../runtime/RuntimeProvider.tsx";
import { useWorkspaces, WorkspaceProvider, type WorkspaceValue } from "../../../runtime/WorkspaceProvider.tsx";
import { DashboardDataProvider } from "../../../surfaces/dashboard/data/DashboardData.tsx";
import { TerminalsWidget } from "./TerminalsWidget.tsx";

const navigation = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../../navigation.tsx", () => ({ useNavigation: () => navigation }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => navigation.navigate.mockReset());

async function mount() {
  const current: Workspace = {
    id: "current",
    name: "Current",
    rootPath: "/projects/current",
    displayPath: "/projects/current",
    createdAt: "2026-09-25T00:00:00Z",
    lastOpenedAt: "2026-09-25T00:00:00Z",
    activeTerminalId: null,
    available: true,
  };
  const away = { ...current, id: "away", name: "Away" };
  const terminal: TerminalInfo = {
    id: "terminal-current",
    workspaceId: current.id,
    shellId: "sh",
    title: "Shell",
    position: 0,
    status: "running",
    startedAt: null,
    endedAt: null,
    exitCode: null,
  };
  let persisted = current;
  const client = new KalCodeClient(createMemoryTransport("default"));
  const boot = await client.boot();
  const settings = await client.getSettings();
  vi.spyOn(client, "listWorkspaces").mockResolvedValue([current, away]);
  vi.spyOn(client, "activeWorkspace").mockImplementation(async () => persisted);
  vi.spyOn(client, "runningTerminals").mockResolvedValue([terminal]);
  vi.spyOn(client, "listTerminals").mockImplementation(async (id) => (id === current.id ? [terminal] : []));
  vi.spyOn(client, "listThreads").mockResolvedValue([]);
  const select = vi.spyOn(client, "setActiveTerminal").mockResolvedValue(undefined);
  const activate = vi.spyOn(client, "activateWorkspace").mockImplementation(async (id) => {
    persisted = id === away.id ? away : current;
    return persisted;
  });
  let state!: WorkspaceValue;
  function Observer() {
    state = useWorkspaces();
    return <TerminalsWidget />;
  }
  render(
    <StrictMode>
      <ToastProvider>
        <RuntimeProvider client={client} info={boot.info} initialSettings={settings}>
          <WorkspaceProvider>
            <DashboardDataProvider>
              <Observer />
            </DashboardDataProvider>
          </WorkspaceProvider>
        </RuntimeProvider>
      </ToastProvider>
    </StrictMode>,
  );
  await waitFor(() => expect(state.state).toBe("ready"));
  const show = await screen.findByRole("button", { name: "Show Shell in Current" });
  return {
    current,
    away,
    activate,
    select,
    show,
    state: () => state,
    persisted: () => persisted,
    persist: (workspace: Workspace) => {
      persisted = workspace;
    },
  };
}

it("Show for the displayed workspace wins over a pending switch before navigating or selecting", async () => {
  const view = await mount();
  const gate = deferred();
  view.activate.mockImplementationOnce(async () => {
    await gate.promise;
    view.persist(view.away);
    return view.away;
  });
  let older!: Promise<boolean>;
  act(() => {
    older = view.state().activate("away");
  });
  await waitFor(() => expect(view.activate).toHaveBeenCalledWith("away"));
  expect(view.state().active?.id).toBe("current");
  fireEvent.click(view.show);
  expect(navigation.navigate).not.toHaveBeenCalled();
  expect(view.select).not.toHaveBeenCalled();
  await act(async () => {
    gate.resolve();
    await older;
  });
  await waitFor(() => expect(view.select).toHaveBeenCalledWith("current", "terminal-current"));
  expect(view.persisted().id).toBe("current");
  expect(view.state().active?.id).toBe("current");
  expect(view.activate.mock.calls.map(([id]) => id)).toEqual(["away", "current"]);
  expect(await older).toBe(false);
  expect(navigation.navigate).toHaveBeenCalledExactlyOnceWith("code");
  expect(view.state().focusRequest.terminalId).toBe("terminal-current");
});

it("shows a terminal of the displayed workspace at once and still reports a failed native activation", async () => {
  const view = await mount();
  view.activate.mockRejectedValueOnce(new Error("Workspace unavailable"));
  fireEvent.click(view.show);
  await waitFor(() => expect(navigation.navigate).toHaveBeenCalledExactlyOnceWith("code"));
  expect(view.select).toHaveBeenCalledWith("current", "terminal-current");
  await screen.findByText("Couldn't switch workspace");
});

it("lets a later workspace intent win after Show of the displayed workspace", async () => {
  const view = await mount();
  const gate = deferred();
  view.activate.mockImplementationOnce(async () => {
    await gate.promise;
    view.persist(view.current);
    return view.current;
  });
  fireEvent.click(view.show);
  // The displayed workspace needs no switch: Show doesn't wait for its native write.
  await waitFor(() => expect(navigation.navigate).toHaveBeenCalledExactlyOnceWith("code"));
  expect(view.select).toHaveBeenCalledWith("current", "terminal-current");
  let latest!: Promise<boolean>;
  act(() => {
    latest = view.state().activate("away");
  });
  await act(async () => {
    gate.resolve();
    expect(await latest).toBe(true);
  });
  expect(view.activate.mock.calls.map(([id]) => id)).toEqual(["current", "away"]);
  expect(view.persisted().id).toBe("away");
  expect(view.state().active?.id).toBe("away");
});
