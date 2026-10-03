// @vitest-environment jsdom
import type { Workspace } from "@kalcode/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderPanes } from "./useProviderPanes.ts";

const mocks = vi.hoisted(() => ({
  listThreads: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("../../../runtime/RuntimeProvider.tsx", () => {
  const client = {
    listThreads: mocks.listThreads,
    threadOptions: () => Promise.resolve({ providers: [] }),
    getPermissionSettings: () => Promise.resolve({ defaultMode: "approve" }),
    transport: { invoke: mocks.invoke },
  };
  const feed = { getSnapshot: () => ({ events: [] }), subscribe: () => () => {} };
  const info = { flags: { features: [{ id: "provider_panes", visible: true }] } };
  return { useRuntime: () => ({ client, feed, info }) };
});
vi.mock("../../permissions/PermissionsProvider.tsx", () => ({ usePermissions: () => ({ settings: null }) }));

const workspace = { id: "ws-1", available: true } as Workspace;

describe("provider pane errors", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("clears a failed list read once a later read succeeds", async () => {
    mocks.listThreads.mockRejectedValueOnce(new Error("list failed")).mockResolvedValue([]);
    const { result } = renderHook(() => useProviderPanes(workspace));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    await act(() => result.current.refresh());
    expect(result.current.error).toBeNull();
  });

  it("forgets a refused launch when the launcher is opened again", async () => {
    mocks.listThreads.mockResolvedValue([]);
    mocks.invoke.mockRejectedValue({
      category: "validation",
      code: "provider_launch_refused",
      message: "That account is in use.",
      retryable: false,
    });
    const { result } = renderHook(() => useProviderPanes(workspace));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.create("claude-code");
    });
    expect(result.current.error).toBe("That account is in use.");
    // A background refresh doesn't hide the refusal while the person is reading it.
    await act(() => result.current.refresh());
    expect(result.current.error).toBe("That account is in use.");
    act(() => result.current.clearLaunchError());
    expect(result.current.error).toBeNull();
  });
});
