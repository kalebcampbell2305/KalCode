import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAVORITES_STORAGE_KEY } from "../../shell/favorites/store.ts";
import { FileTree } from "./FileTree.tsx";

const mocks = vi.hoisted(() => ({ listFiles: vi.fn(), readWorkspaceFile: vi.fn(), toast: vi.fn() }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => ({ client: mocks }) }));
vi.mock("../dashboard/data/DashboardData.tsx", () => ({
  useCodingAgents: () => ({ state: { status: "ready", data: [] } }),
}));
vi.mock("../../runtime/uiIntents.tsx", () => ({ useUiIntents: () => ({ focus: vi.fn() }) }));
vi.mock("@kalcode/ui/components", async (original) => ({
  ...(await original<typeof import("@kalcode/ui/components")>()),
  useToast: () => ({ show: mocks.toast }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listFiles.mockResolvedValue({
    items: ["one.ts", "two.ts"].map((name) => ({
      file: { displayPath: name, workspaceId: "workspace", handle: { id: name } },
      isDir: false,
      bytes: 4,
      ignored: false,
    })),
    nextCursor: null,
  });
  mocks.readWorkspaceFile.mockResolvedValue({ text: "export const clicked = true;", truncated: false });
});

describe("file context menu", () => {
  it("saves a stable file path without reading the file or storing its handle", async () => {
    localStorage.removeItem(FAVORITES_STORAGE_KEY);
    render(<FileTree workspaceId="workspace" />);
    const row = await screen.findByRole("treeitem", { name: "one.ts" });
    fireEvent.click(screen.getByRole("button", { name: "Pin globally: one.ts" }));
    expect(row).toHaveAttribute("aria-selected", "false");
    expect(mocks.readWorkspaceFile).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) ?? "{}").entries).toEqual([
      expect.objectContaining({ target: { kind: "file", id: "one.ts", workspaceId: "workspace" }, scopeId: null }),
    ]);
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin globally" }));
    expect(JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) ?? "{}").entries).toEqual([]);
    expect(mocks.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("opens the exact right-clicked file through its opaque handle, without changing selection first", async () => {
    render(<FileTree workspaceId="workspace" />);
    fireEvent.click(await screen.findByRole("treeitem", { name: "one.ts" }));
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "two.ts" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(await screen.findByRole("dialog", { name: "two.ts" })).toBeInTheDocument();
    expect(mocks.readWorkspaceFile).toHaveBeenCalledWith("workspace", { id: "two.ts" });
    expect(await screen.findByText("export const clicked = true;")).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "one.ts", hidden: true })).toHaveAttribute("aria-selected", "true");
  });
});
