// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOpenInPane } from "./useOpenInPane.ts";

const mocks = vi.hoisted(() => ({ activate: vi.fn(), navigate: vi.fn(), dispatch: vi.fn() }));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => ({ active: { id: "workspace-current" }, activate: mocks.activate }),
}));
vi.mock("../navigation.tsx", () => ({ useNavigation: () => ({ navigate: mocks.navigate }) }));
vi.mock("./paneCommands.ts", () => ({ dispatchPaneCommand: mocks.dispatch }));

describe("pane workspace activation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.dispatch.mockResolvedValue({ handled: true });
  });

  it.each([undefined, "workspace-current"])(
    "confirms the displayed workspace before opening (target %s)",
    async (workspaceId) => {
      let resolve!: (value: boolean) => void;
      mocks.activate.mockReturnValue(
        new Promise<boolean>((done) => {
          resolve = done;
        }),
      );
      const { result } = renderHook(useOpenInPane);
      let opened!: ReturnType<typeof result.current>;
      act(() => {
        opened = result.current({ kind: "dashboard" }, { workspaceId });
      });
      expect(mocks.activate).toHaveBeenCalledWith("workspace-current");
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(mocks.dispatch).not.toHaveBeenCalled();
      await act(async () => {
        resolve(true);
        await opened;
      });
      expect(mocks.navigate).toHaveBeenCalledWith("code");
      expect(mocks.dispatch).toHaveBeenCalledWith(
        { kind: "open", content: { kind: "dashboard" } },
        { queue: true, scope: "workspace-current" },
      );
    },
  );

  it("does not dispatch when the displayed workspace activation is superseded", async () => {
    mocks.activate.mockResolvedValue(false);
    const { result } = renderHook(useOpenInPane);
    let opened!: Awaited<ReturnType<typeof result.current>>;
    await act(async () => {
      opened = await result.current({ kind: "dashboard" });
    });
    expect(opened.handled).toBe(false);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
