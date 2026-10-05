// @vitest-environment jsdom
import type { ThreadSummary, Workspace } from "@kalcode/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useProviderPanes } from "./useProviderPanes.ts";

const state = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let events: { seq: number; type: string; correlation: { threadId: string | null; workspaceId: string | null } }[] =
    [];
  const client = {
    getPermissionSettings: vi.fn(),
    listThreads: vi.fn(),
    threadOptions: vi.fn(),
    transport: { invoke: vi.fn() },
  };
  return {
    client,
    feed: {
      getSnapshot: () => ({ events }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(threadId: string | null, workspaceId: string | null = null) {
      events = [
        { seq: (events[0]?.seq ?? 0) + 1, type: "thread.status_changed", correlation: { threadId, workspaceId } },
        ...events,
      ];
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("../../../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({ ...state, info: { flags: { features: [{ id: "provider_panes", visible: true }] } } }),
}));
vi.mock("../../permissions/PermissionsProvider.tsx", () => ({ usePermissions: () => ({ settings: null }) }));

const workspace = { id: "workspace", available: true } as Workspace;
const thread = (id: string, createdAt: string) =>
  ({ id, providerId: "claude-code", runtimeKind: "interactive_pty", createdAt, name: id }) as ThreadSummary;
const agents = [thread("a", "2026-10-01"), thread("b", "2026-10-02"), thread("c", "2026-10-03")];
const infoReads = () =>
  state.client.transport.invoke.mock.calls
    .filter(([command]) => command === "provider_pane_info")
    .map(([, args]) => args);

beforeEach(() => {
  vi.resetAllMocks();
  state.client.getPermissionSettings.mockResolvedValue({ defaultMode: "auto" });
  state.client.listThreads.mockResolvedValue(agents);
  state.client.threadOptions.mockResolvedValue({ providers: [] });
  state.client.transport.invoke.mockImplementation(async (command: string, args: { threadId: string }) =>
    command === "provider_pane_info" ? { threadId: args.threadId, running: true, hookChannel: "active" } : null,
  );
});

it("an event naming one agent re-reads only that agent's pane", async () => {
  const view = renderHook(() => useProviderPanes(workspace));
  await waitFor(() => expect(view.result.current.panes).toHaveLength(3));
  const before = view.result.current.panes;
  state.client.transport.invoke.mockClear();
  act(() => state.emit("b"));
  await waitFor(() => expect(infoReads()).toHaveLength(1));
  expect(infoReads()[0]).toMatchObject({ threadId: "b" });
  // Nothing changed: the same entries (and list) keep their identity.
  await waitFor(() => expect(state.client.listThreads).toHaveBeenCalledTimes(2));
  expect(view.result.current.panes).toBe(before);
});

it("a workspace-wide event still re-reads every pane", async () => {
  const view = renderHook(() => useProviderPanes(workspace));
  await waitFor(() => expect(view.result.current.panes).toHaveLength(3));
  state.client.transport.invoke.mockClear();
  act(() => state.emit(null, workspace.id));
  await waitFor(() => expect(infoReads()).toHaveLength(3));
});

it("launches several agents as fresh sessions in one list update, keeping started ones after a refusal", async () => {
  state.client.listThreads.mockResolvedValue([]);
  let created = 0;
  state.client.transport.invoke.mockImplementation(async (command: string, args: { threadId: string }) => {
    if (command === "provider_pane_create") {
      created += 1;
      if (created === 4)
        throw { category: "provider", code: "limit", message: "Account limit reached.", retryable: false };
      return thread(`fresh-${created}`, `2026-10-04T00:00:0${created}`);
    }
    return { threadId: args.threadId, running: true, hookChannel: "active" };
  });
  const view = renderHook(() => useProviderPanes(workspace));
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  let started: ThreadSummary[] = [];
  await act(async () => {
    started = await view.result.current.createMany("claude-code", {}, 6);
  });
  // Each start is its own session; the refusal stops further starts, and none is retried.
  const creates = state.client.transport.invoke.mock.calls.filter(([command]) => command === "provider_pane_create");
  expect(creates.length).toBeGreaterThanOrEqual(4);
  expect(creates.length).toBeLessThanOrEqual(6);
  expect(started.map((t) => t.id)).toEqual(started.map((t) => t.id).sort());
  expect(started).toHaveLength(creates.length - 1);
  expect(view.result.current.panes.map((p) => p.thread.id)).toEqual(started.map((t) => t.id));
  expect(view.result.current.error).toBe("Account limit reached.");
});
