import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type FavoriteTarget, favoriteKey } from "./model.ts";
import { useFavoriteResolver } from "./useOpenFavorite.ts";

const mocks = vi.hoisted(() => ({
  active: { id: "actual", available: true } as { id: string; available: boolean } | null,
  surfaces: ["code", "threads", "providers", "operations"].map((id) => ({ id, state: "available", visible: true })),
  features: [{ id: "workspace_home", visible: true, state: "available" }],
  client: {
    transport: { invoke: vi.fn() },
    listWorkspaces: vi.fn(),
    listTerminals: vi.fn(),
    getThread: vi.fn(),
    listProviderAccounts: vi.fn(),
    listFiles: vi.fn(),
  },
  activate: vi.fn(),
  navigate: vi.fn(),
  threadOpen: vi.fn(),
  palette: vi.fn(),
  dispatch: vi.fn(),
  account: vi.fn(),
  focusOperation: vi.fn(),
  detail: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({
    client: mocks.client,
    info: {
      flags: {
        surfaces: mocks.surfaces,
        features: mocks.features,
      },
    },
  }),
}));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => ({ active: mocks.active, activate: mocks.activate }),
}));
vi.mock("../navigation.tsx", async (original) => ({
  ...(await original<typeof import("../navigation.tsx")>()),
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../surfaces/threads/intent.tsx", () => ({ useThreadsIntent: () => ({ request: mocks.threadOpen }) }));
vi.mock("../rail/search/SearchProvider.tsx", () => ({ useOptionalSearchActions: () => ({ openWith: mocks.palette }) }));
vi.mock("../panes/paneCommands.ts", () => ({ dispatchPaneCommand: mocks.dispatch }));
vi.mock("../../surfaces/providers/providersTab.ts", () => ({ openProviderAccounts: mocks.account }));
vi.mock("../../kalvoice/sceneOperations.ts", () => ({ focusOperationsTarget: mocks.focusOperation }));
vi.mock("../../ipc/operations.ts", () => ({
  OperationsClient: class {
    detail = mocks.detail;
    snapshot = mocks.snapshot;
  },
}));

const target = (kind: FavoriteTarget["kind"], id: string, workspaceId: string | null = "saved"): FavoriteTarget => ({
  kind,
  id,
  workspaceId,
});
const entry = (saved: FavoriteTarget) => ({
  key: favoriteKey(saved, null),
  target: saved,
  title: "Saved destination",
  scopeId: null,
});
const workspace = { id: "actual", available: true };

describe("favorite navigation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.active = { id: "actual", available: true };
    mocks.surfaces = ["code", "threads", "providers", "operations"].map((id) => ({
      id,
      state: "available",
      visible: true,
    }));
    mocks.features = [{ id: "workspace_home", visible: true, state: "available" }];
    mocks.client.listWorkspaces.mockResolvedValue([workspace]);
    mocks.activate.mockResolvedValue(true);
    mocks.dispatch.mockReturnValue({ handled: true });
    mocks.focusOperation.mockResolvedValue(true);
  });

  it("opens an ended agent by exact identity and its current workspace without a resume/start call", async () => {
    mocks.client.getThread.mockResolvedValue({
      id: "agent-id",
      workspaceId: "actual",
      runtimeKind: "interactive_pty",
      archivedAt: null,
      status: "completed",
    });
    const { result } = renderHook(useFavoriteResolver);
    await act(async () =>
      expect(await result.current.open(entry(target("thread", "agent-id")))).toEqual({ opened: true }),
    );
    expect(mocks.activate).toHaveBeenCalledWith("actual");
    expect(mocks.dispatch).toHaveBeenCalledWith(
      { kind: "open", content: { kind: "agent", agentId: "agent-id" } },
      { queue: true, scope: "actual" },
    );
    expect(mocks.client.transport.invoke).not.toHaveBeenCalled();
  });

  it("opens an unassigned chat in Threads even if saved as an agent", async () => {
    mocks.client.getThread.mockResolvedValue({
      id: "chat",
      workspaceId: null,
      runtimeKind: "headless",
      archivedAt: null,
    });
    const { result } = renderHook(useFavoriteResolver);
    await act(async () => expect(await result.current.open(entry(target("agent", "chat")))).toEqual({ opened: true }));
    expect(mocks.navigate).toHaveBeenCalledWith("threads");
    expect(mocks.threadOpen).toHaveBeenCalledWith("open", "chat");
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("reports a closed terminal before navigation and never creates a replacement", async () => {
    mocks.client.listTerminals.mockResolvedValue([]);
    const { result } = renderHook(useFavoriteResolver);
    expect(await result.current.check(target("terminal", "closed", "actual"))).toContain("closed");
    await act(async () =>
      expect((await result.current.open(entry(target("terminal", "closed", "actual")))).opened).toBe(false),
    );
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("opens the exact selected account without rebinding anything", async () => {
    mocks.client.listProviderAccounts.mockResolvedValue([{ id: "account-2", providerId: "codex", archivedAt: null }]);
    const { result } = renderHook(useFavoriteResolver);
    await act(async () =>
      expect((await result.current.open(entry(target("account", "account-2", null)))).opened).toBe(true),
    );
    expect(mocks.account).toHaveBeenCalledWith({ providerId: "codex", accountId: "account-2" });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.client.transport.invoke).not.toHaveBeenCalled();
  });

  it("shows a saved command in the palette without executing it", async () => {
    const { result } = renderHook(useFavoriteResolver);
    await act(async () =>
      expect((await result.current.open(entry(target("command", "terminal:new", null)))).opened).toBe(true),
    );
    expect(mocks.palette).toHaveBeenCalledWith("New terminal");
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.client.transport.invoke).not.toHaveBeenCalled();
  });

  it("queues a dedicated browser with exact query and fragment after workspace activation", async () => {
    const url = "https://example.com/search?q=favorites#results";
    const { result } = renderHook(useFavoriteResolver);
    await act(async () =>
      expect((await result.current.open(entry(target("browser", url, "actual")))).opened).toBe(true),
    );
    expect(mocks.dispatch).toHaveBeenCalledWith(
      { kind: "browser-control", command: { kind: "open", url, newPane: true } },
      { queue: true, scope: "actual" },
    );
  });

  it("resolves fresh native file handles through directories without persisting or reading content", async () => {
    mocks.client.listFiles
      .mockResolvedValueOnce({
        items: [{ isDir: true, file: { workspaceId: "actual", displayPath: "src", handle: { id: "fresh-dir" } } }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        items: [
          { isDir: false, file: { workspaceId: "actual", displayPath: "src/app.ts", handle: { id: "fresh-file" } } },
        ],
        nextCursor: null,
      });
    const { result } = renderHook(useFavoriteResolver);
    await act(async () =>
      expect((await result.current.open(entry(target("file", "src/app.ts", "actual")))).opened).toBe(true),
    );
    expect(result.current.preview?.handle).toEqual({ id: "fresh-file" });
    expect(mocks.client.listFiles).toHaveBeenLastCalledWith("actual", { id: "fresh-dir" }, 200, null);
  });

  it("focuses exact run detail without starting or restarting it", async () => {
    mocks.detail.mockResolvedValue({ run: { id: "run-1", spec: { workspaceId: "actual", name: "Build" } } });
    const { result } = renderHook(useFavoriteResolver);
    await act(async () => expect((await result.current.open(entry(target("run", "run-1")))).opened).toBe(true));
    expect(mocks.focusOperation).toHaveBeenCalledWith(
      { kind: "run", tab: "runs", runId: "run-1", workspaceId: "actual", label: "Build" },
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.client.transport.invoke).not.toHaveBeenCalled();
  });

  it("cancels a pending pane navigation when a newer favorite is chosen", async () => {
    let activate!: (value: boolean) => void;
    mocks.activate.mockImplementationOnce(
      () =>
        new Promise<boolean>((done) => {
          activate = done;
        }),
    );
    mocks.client.listTerminals.mockResolvedValue([{ id: "terminal" }]);
    const { result } = renderHook(useFavoriteResolver);
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.open(entry(target("terminal", "terminal", "actual")));
    });
    await act(async () => {
      await result.current.open(entry(target("command", "terminal:new", null)));
      activate(true);
      await pending;
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("retains an archived session with an actionable unavailable reason", async () => {
    mocks.client.getThread.mockResolvedValue({ id: "archived", archivedAt: "2026-10-04" });
    const { result } = renderHook(useFavoriteResolver);
    expect(await result.current.check(target("thread", "archived"))).toContain("Restore it");
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("cancels pending lookup when the favorites UI unmounts", async () => {
    let resolve!: (value: unknown) => void;
    mocks.client.listProviderAccounts.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { result, unmount } = renderHook(useFavoriteResolver);
    let pending!: ReturnType<typeof result.current.open>;
    act(() => {
      pending = result.current.open(entry(target("account", "account-2", null)));
    });
    unmount();
    resolve([{ id: "account-2", providerId: "codex", archivedAt: null }]);
    expect((await pending).opened).toBe(false);
    expect(mocks.account).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("reports a moved/deleted workspace without activating another workspace", async () => {
    mocks.client.listWorkspaces.mockResolvedValue([{ id: "actual", available: false }]);
    const { result } = renderHook(useFavoriteResolver);
    expect(await result.current.check(target("workspace", "actual"))).toContain("Reconnect");
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it.each(["navigate:threads", "thread:new", "thread:search"])(
    "marks gated command %s unavailable instead of opening an empty palette",
    async (id) => {
      mocks.surfaces = mocks.surfaces.map((surface) =>
        surface.id === "threads" ? { ...surface, state: "gated" } : surface,
      );
      const { result } = renderHook(useFavoriteResolver);
      expect(await result.current.check(target("command", id, null))).toContain("isn't available");
      await act(async () => expect((await result.current.open(entry(target("command", id, null)))).opened).toBe(false));
      expect(mocks.palette).not.toHaveBeenCalled();
    },
  );

  it.each(["agent:new", "browser:open", "workspace:open", "terminal:new"])(
    "requires available Code for %s",
    async (id) => {
      mocks.surfaces = mocks.surfaces.map((surface) =>
        surface.id === "code" ? { ...surface, visible: false } : surface,
      );
      const { result } = renderHook(useFavoriteResolver);
      expect(await result.current.check(target("command", id, null))).toContain("isn't available");
      expect(mocks.palette).not.toHaveBeenCalled();
    },
  );

  it("checks view feature visibility and unknown command IDs", async () => {
    const { result, rerender } = renderHook(useFavoriteResolver);
    expect(await result.current.check(target("command", "navigate:home", null))).toBeNull();
    mocks.features = [];
    rerender();
    expect(await result.current.check(target("command", "navigate:home", null))).toContain("isn't available");
    expect(await result.current.check(target("command", "removed:command", null))).toContain("no longer available");
  });

  it("rechecks a global New terminal favorite against current workspace without switching it", async () => {
    mocks.active = null;
    const { result, rerender } = renderHook(useFavoriteResolver);
    const saved = target("command", "terminal:new", null);
    expect(await result.current.check(saved)).toContain("Open an available workspace");
    mocks.active = { id: "actual", available: true };
    rerender();
    expect(await result.current.check(saved)).toBeNull();
    mocks.client.listWorkspaces.mockResolvedValue([{ id: "actual", available: false }]);
    expect(await result.current.check(saved)).toContain("Reconnect");
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.palette).not.toHaveBeenCalled();
  });
});
