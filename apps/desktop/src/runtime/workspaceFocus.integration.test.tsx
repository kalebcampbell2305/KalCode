import type { Workspace } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { expect, it, vi } from "vitest";
import { KalCodeClient } from "../ipc/client.ts";
import { createMemoryTransport } from "../ipc/memoryTransport.ts";
import { useOpenInPane } from "../shell/panes/useOpenInPane.ts";
import { RuntimeProvider } from "./RuntimeProvider.tsx";
import { useWorkspaces, WorkspaceProvider } from "./WorkspaceProvider.tsx";

const navigation = vi.hoisted(() => ({ navigate: vi.fn(), dispatch: vi.fn() }));
vi.mock("../shell/navigation.tsx", () => ({ useNavigation: () => ({ navigate: navigation.navigate }) }));
vi.mock("../shell/panes/paneCommands.ts", () => ({ dispatchPaneCommand: navigation.dispatch }));

it("a pane intent for the displayed workspace wins over an already-dispatched switch", async () => {
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
  let persisted = current;
  let finishAway!: () => void;
  const pendingAway = new Promise<void>((resolve) => {
    finishAway = resolve;
  });
  const client = new KalCodeClient(createMemoryTransport("default"));
  const boot = await client.boot();
  const settings = await client.getSettings();
  vi.spyOn(client, "listWorkspaces").mockResolvedValue([current, away]);
  vi.spyOn(client, "activeWorkspace").mockImplementation(async () => persisted);
  vi.spyOn(client, "runningTerminals").mockResolvedValue([]);
  vi.spyOn(client, "listTerminals").mockResolvedValue([]);
  const activate = vi.spyOn(client, "activateWorkspace").mockImplementation(async (id) => {
    if (id === "away") await pendingAway;
    persisted = id === "away" ? away : current;
    return persisted;
  });
  navigation.dispatch.mockResolvedValue({ handled: true });
  const view = renderHook(() => ({ workspaces: useWorkspaces(), open: useOpenInPane() }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <ToastProvider>
          <RuntimeProvider client={client} info={boot.info} initialSettings={settings}>
            <WorkspaceProvider>{children}</WorkspaceProvider>
          </RuntimeProvider>
        </ToastProvider>
      </StrictMode>
    ),
  });
  await waitFor(() => expect(view.result.current.workspaces.state).toBe("ready"));
  let older!: Promise<boolean>;
  let latest!: ReturnType<typeof view.result.current.open>;
  act(() => {
    older = view.result.current.workspaces.activate("away");
  });
  await waitFor(() => expect(activate).toHaveBeenCalledWith("away"));
  expect(view.result.current.workspaces.active?.id).toBe("current");
  act(() => {
    latest = view.result.current.open({ kind: "dashboard" }, { workspaceId: "current" });
  });
  await act(async () => {
    finishAway();
    await Promise.all([older, latest]);
  });
  expect(persisted.id).toBe("current");
  expect(view.result.current.workspaces.active?.id).toBe("current");
  expect(activate.mock.calls.map(([id]) => id)).toEqual(["away", "current"]);
  expect(await older).toBe(false);
  expect(await latest).toEqual({ handled: true });
  expect(navigation.dispatch).toHaveBeenCalledExactlyOnceWith(
    { kind: "open", content: { kind: "dashboard" } },
    { queue: true, scope: "current" },
  );
});
