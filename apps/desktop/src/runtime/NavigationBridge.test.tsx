import { ToastProvider } from "@kalcode/ui/components";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { KalCodeClient } from "../ipc/client.ts";
import { createMemoryTransport } from "../ipc/memoryTransport.ts";
import { NavigationProvider, useNavigation } from "../shell/navigation.tsx";
import { ThreadsIntentProvider } from "../surfaces/threads/intent.tsx";
import { NavigationBridge } from "./NavigationBridge.tsx";
import { RuntimeProvider } from "./RuntimeProvider.tsx";
import { useWorkspaces, WorkspaceProvider } from "./WorkspaceProvider.tsx";

it("Back to the displayed workspace supersedes an older native switch still in flight", async () => {
  const client = new KalCodeClient(createMemoryTransport("code"));
  const boot = await client.boot();
  const settings = await client.getSettings();
  const workspaces = await client.listWorkspaces();
  const original = workspaces[0];
  if (!original) throw new Error("Fixture needs a workspace");
  const away = { ...original, id: "away", name: "Away" };
  let persisted = original;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(client, "listWorkspaces").mockResolvedValue([original, away]);
  vi.spyOn(client, "activeWorkspace").mockImplementation(async () => persisted);
  vi.spyOn(client, "listTerminals").mockResolvedValue([]);
  const activate = vi.spyOn(client, "activateWorkspace").mockImplementation(async (id) => {
    if (id === away.id) await pending;
    persisted = id === away.id ? away : original;
    return persisted;
  });
  const view = renderHook(() => ({ navigation: useNavigation(), workspaces: useWorkspaces() }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ToastProvider>
        <RuntimeProvider client={client} info={boot.info} initialSettings={settings}>
          <NavigationProvider flags={boot.info.flags.surfaces}>
            <WorkspaceProvider>
              <ThreadsIntentProvider>
                <NavigationBridge />
                {children}
              </ThreadsIntentProvider>
            </WorkspaceProvider>
          </NavigationProvider>
        </RuntimeProvider>
      </ToastProvider>
    ),
  });
  await waitFor(() => expect(view.result.current.workspaces.state).toBe("ready"));
  act(() => {
    view.result.current.navigation.navigate("code");
    view.result.current.navigation.recordLocation({ destination: "code", workspaceId: original.id });
    view.result.current.navigation.navigate("settings");
  });
  let older!: Promise<boolean>;
  let back!: Promise<void>;
  act(() => {
    older = view.result.current.workspaces.activate(away.id);
  });
  await waitFor(() => expect(activate).toHaveBeenCalledWith(away.id));
  act(() => {
    back = view.result.current.navigation.back();
  });
  await act(async () => {
    finish();
    await Promise.all([older, back]);
  });
  expect(persisted.id).toBe(original.id);
  expect(view.result.current.navigation.current).toBe("code");
  expect(view.result.current.workspaces.active?.id).toBe(original.id);
  expect(activate.mock.calls.map(([id]) => id)).toEqual([away.id, original.id]);
});
