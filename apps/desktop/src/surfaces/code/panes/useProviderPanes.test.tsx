// @vitest-environment jsdom
import type { ThreadSummary, Workspace } from "@kalcode/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useProviderPanes } from "./useProviderPanes.ts";

const state = vi.hoisted(() => {
  const client = { listThreads: vi.fn(), threadOptions: vi.fn(), transport: { invoke: vi.fn() } };
  return {
    client,
    feed: { getSnapshot: () => ({ events: [] }), subscribe: () => () => undefined },
  };
});
vi.mock("../../../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({ ...state, info: { flags: { features: [{ id: "provider_panes", visible: true }] } } }),
}));
vi.mock("../../permissions/PermissionsProvider.tsx", () => ({ usePermissions: () => ({ settings: null }) }));

const workspace = { id: "workspace", available: true } as Workspace;
const agent = {
  id: "fresh-agent",
  providerId: "claude-code",
  runtimeKind: "interactive_pty",
  createdAt: "2026-10-03",
} as ThreadSummary;
const info = { threadId: agent.id, running: true, hookChannel: "active" };

beforeEach(() => {
  vi.resetAllMocks();
  state.client.listThreads.mockResolvedValue([]);
  state.client.threadOptions.mockResolvedValue({ providers: [] });
  state.client.transport.invoke.mockImplementation(async (command: string) =>
    command === "provider_pane_create" ? agent : info,
  );
});

it("registers the created terminal directly even when the list snapshot lags behind creation", async () => {
  const view = renderHook(() => useProviderPanes(workspace));
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  await act(async () => {
    await view.result.current.create("claude-code");
  });
  expect(view.result.current.panes.map((pane) => pane.thread.id)).toEqual([agent.id]);
});

it("keeps a known terminal during a transient pane-info read failure", async () => {
  state.client.listThreads.mockResolvedValue([agent]);
  const view = renderHook(() => useProviderPanes(workspace));
  await waitFor(() => expect(view.result.current.panes).toHaveLength(1));
  state.client.transport.invoke.mockRejectedValue(new Error("IPC temporarily unavailable"));
  await act(async () => {
    await view.result.current.refresh();
  });
  expect(view.result.current.panes.map((pane) => pane.thread.id)).toEqual([agent.id]);
});

it("keeps a successfully created session when its first info read fails, without launching another", async () => {
  const view = renderHook(() => useProviderPanes(workspace));
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  state.client.transport.invoke.mockImplementation(async (command: string) => {
    if (command === "provider_pane_create") return agent;
    throw { category: "internal", code: "unavailable", message: "Temporarily unavailable", retryable: true };
  });
  let created: ThreadSummary | null = null;
  await act(async () => {
    created = await view.result.current.create();
  });
  expect(created).toBe(agent);
  expect(view.result.current.panes).toEqual([{ thread: agent, info: null }]);
  expect(
    state.client.transport.invoke.mock.calls.filter(([command]) => command === "provider_pane_create"),
  ).toHaveLength(1);
});

it("retains restored terminal identity when pane metadata is initially unavailable", async () => {
  state.client.listThreads.mockResolvedValue([agent]);
  state.client.transport.invoke.mockResolvedValue(null);
  const view = renderHook(() => useProviderPanes(workspace));
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  expect(view.result.current.panes).toEqual([{ thread: agent, info: null }]);
});
