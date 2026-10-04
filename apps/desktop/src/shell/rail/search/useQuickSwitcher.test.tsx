import type { FileEntry } from "@kalcode/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuickSwitcher } from "./useQuickSwitcher.ts";

const fixture = vi.hoisted(() => ({
  client: {
    listProviderAccounts: vi.fn(),
    listThreads: vi.fn(),
    listProviders: vi.fn(),
    listFiles: vi.fn(),
    updaterStatus: vi.fn(),
  },
  events: [] as { type: string; seq: number; correlation: { workspaceId: string } }[],
  active: { id: "one", name: "Project", available: true, displayPath: "C:/project" },
}));
vi.mock("../../../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({
    client: fixture.client,
    info: { version: "1.0", flags: { surfaces: [{ id: "threads", visible: true }], features: [] } },
  }),
  useEvents: () => ({ events: fixture.events }),
}));
vi.mock("../../../runtime/WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => ({ active: fixture.active, workspaces: [fixture.active], terminals: [], running: [] }),
}));
const file = (path: string): FileEntry => ({
  file: { handle: { id: path }, workspaceId: "one", displayPath: path },
  isDir: false,
  ignored: false,
  bytes: 12,
});

beforeEach(() => {
  vi.resetAllMocks();
  fixture.events = [];
  fixture.client.listProviderAccounts.mockResolvedValue([]);
  fixture.client.listThreads.mockResolvedValue([]);
  fixture.client.listProviders.mockResolvedValue([]);
  fixture.client.listFiles.mockResolvedValue({ items: [], nextCursor: null });
  fixture.client.updaterStatus.mockResolvedValue({ availableVersion: "1.1" });
});

describe("warm universal search", () => {
  it("searches cached account metadata immediately while provider refresh is pending or fails", async () => {
    fixture.client.listProviderAccounts.mockResolvedValue([
      {
        id: "account",
        providerId: "codex",
        displayName: "Research",
        authenticationState: "authenticated",
        archivedAt: null,
      },
    ]);
    fixture.client.listProviders.mockReturnValue(new Promise(() => {}));
    const { result, rerender } = renderHook(({ open }) => useQuickSwitcher(open, "Research"), {
      initialProps: { open: false },
    });
    await waitFor(() => expect(result.current.results[0]?.id).toBe("account:account"));
    fixture.client.listProviderAccounts.mockRejectedValue(new Error("offline"));
    rerender({ open: true });
    expect(result.current.results[0]?.id).toBe("account:account");
    await act(async () => {});
    expect(result.current.results[0]?.metadata).toBe("Signed in");
  });

  it("indexes later file pages and replaces stale files when a file event arrives", async () => {
    fixture.client.listFiles.mockImplementation(async (_workspace, _dir, _limit, cursor) =>
      cursor ? { items: [file("src/second.ts")], nextCursor: null } : { items: [file("first.ts")], nextCursor: "next" },
    );
    const { result, rerender } = renderHook(({ query }) => useQuickSwitcher(false, query), {
      initialProps: { query: "second.ts" },
    });
    await waitFor(() => expect(result.current.results[0]?.id).toBe("file:one:src/second.ts"));
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    fixture.client.listFiles.mockResolvedValue({ items: [file("replacement.ts")], nextCursor: null });
    fixture.events = [{ seq: 1, type: "file.deleted", correlation: { workspaceId: "one" } }];
    rerender({ query: "second.ts" });
    await waitFor(() => expect(result.current.results).toEqual([]));
    rerender({ query: "replacement.ts" });
    expect(result.current.results[0]?.id).toBe("file:one:replacement.ts");
  });

  it("preserves indexed files on transient root listing failure and lists an available release", async () => {
    fixture.client.listFiles.mockResolvedValue({ items: [file("cached.ts")], nextCursor: null });
    const { result, rerender } = renderHook(({ query }) => useQuickSwitcher(false, query), {
      initialProps: { query: "cached.ts" },
    });
    await waitFor(() => expect(result.current.results[0]?.id).toBe("file:one:cached.ts"));
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    fixture.client.listFiles.mockRejectedValue(new Error("temporarily unavailable"));
    fixture.events = [{ seq: 2, type: "file.modified", correlation: { workspaceId: "one" } }];
    rerender({ query: "cached.ts" });
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.results[0]?.id).toBe("file:one:cached.ts");
    rerender({ query: "1.1" });
    expect(result.current.results[0]?.target).toEqual({ kind: "release", section: "updates" });
  });
});
