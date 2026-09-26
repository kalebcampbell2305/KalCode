import type { Workspace } from "@kalcode/protocol";
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useWorkspaces, WorkspaceProvider } from "../../src/runtime/WorkspaceProvider.tsx";

const mocks = vi.hoisted(() => ({ client: {} as Record<string, unknown>, show: vi.fn() }));
vi.mock("../../src/runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({
    client: mocks.client,
    feed: { getSnapshot: () => ({ events: [] }), subscribe: () => () => {} },
  }),
}));
vi.mock("@kalcode/ui/components", () => ({ useToast: () => ({ show: mocks.show }) }));

it("keeps the latest requested workspace when activation completions arrive out of order", async () => {
  const workspace = (id: string): Workspace => ({
    id,
    name: id,
    rootPath: `C:/${id}`,
    displayPath: `C:/${id}`,
    createdAt: "2026-09-25",
    lastOpenedAt: "2026-09-25",
    activeTerminalId: null,
    available: true,
  });
  let active = workspace("initial");
  const complete = new Map<string, () => void>();
  mocks.client = {
    listWorkspaces: async () => [workspace("first"), workspace("second")],
    activeWorkspace: async () => active,
    runningTerminals: async () => [],
    listTerminals: async () => [],
    listShells: async () => [],
    activateWorkspace: (id: string) =>
      new Promise<void>((resolve) => {
        complete.set(id, () => {
          active = workspace(id);
          resolve();
        });
      }),
  };
  const { result } = renderHook(useWorkspaces, { wrapper: WorkspaceProvider });
  await act(async () => {});
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  act(() => {
    first = result.current.activate("first");
  });
  await act(async () => {});
  act(() => {
    second = result.current.activate("second");
  });
  await act(async () => {});
  if (complete.has("second")) {
    // An unqueued implementation permits the older native mutation to finish last.
    await act(async () => {
      complete.get("second")?.();
      await second;
    });
    await act(async () => {
      complete.get("first")?.();
      await first;
    });
  } else {
    // A serialized implementation must finish the dispatched mutation first.
    await act(async () => {
      complete.get("first")?.();
      await first;
    });
    await act(async () => {
      complete.get("second")?.();
      await second;
    });
  }
  expect(result.current.active?.id).toBe("second");
});
