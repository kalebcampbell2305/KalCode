import type { FileEntry, FileHandle, Page } from "@kalcode/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTree } from "./FileTree.tsx";

vi.mock("../../shell/context/ContentContextMenu.tsx", () => ({
  ContentContextMenu: ({ children }: { children: React.ReactNode }) => children,
}));

const runtime = vi.hoisted(() => ({ client: { listFiles: vi.fn() } }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => runtime }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function entry(displayPath: string, workspaceId = "A", isDir = false): FileEntry {
  return {
    file: { displayPath, workspaceId, handle: { id: `${workspaceId}:${displayPath}` } },
    isDir,
    bytes: isDir ? null : 32,
    ignored: false,
  };
}
function page(...items: FileEntry[]): Page<FileEntry> {
  return { items, nextCursor: null, totalEstimate: items.length };
}
function tree(workspaceId: string) {
  return (
    <StrictMode>
      <FileTree workspaceId={workspaceId} />
    </StrictMode>
  );
}
beforeEach(() => {
  runtime.client = { listFiles: vi.fn(async () => page()) };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("file tree lifetime", () => {
  it("rejects an earlier workspace root after the current workspace has loaded", async () => {
    const old = deferred<Page<FileEntry>>();
    runtime.client.listFiles.mockImplementation((workspace: string) =>
      workspace === "A" ? old.promise : Promise.resolve(page(entry("current.txt", "B"))),
    );
    const { rerender } = render(tree("A"));
    rerender(tree("B"));
    await screen.findByRole("treeitem", { name: "current.txt" });
    await act(async () => {
      old.resolve(page(entry("obsolete.txt")));
    });
    expect(screen.queryByRole("treeitem", { name: "obsolete.txt" })).toBeNull();
    expect(screen.getByRole("treeitem", { name: "current.txt" })).toBeInTheDocument();
  });

  it("ignores a previous runtime's rejected read", async () => {
    const old = deferred<Page<FileEntry>>();
    runtime.client.listFiles.mockReturnValue(old.promise);
    const { rerender } = render(tree("A"));
    runtime.client = { listFiles: vi.fn(async () => page(entry("current.txt"))) };
    rerender(tree("A"));
    await screen.findByRole("treeitem", { name: "current.txt" });
    await act(async () => {
      old.reject({ category: "filesystem", code: "old", message: "Old read failed", retryable: true });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("treeitem", { name: "current.txt" })).toBeInTheDocument();
  });

  it("rejects an old subdirectory result with the same display path in another workspace", async () => {
    const old = deferred<Page<FileEntry>>();
    runtime.client.listFiles.mockImplementation((workspace: string, handle: FileHandle | null) => {
      if (!handle) return Promise.resolve(page(entry("src", workspace, true)));
      return workspace === "A" ? old.promise : Promise.resolve(page(entry("src/current.ts", "B")));
    });
    const { rerender } = render(tree("A"));
    fireEvent.click(await screen.findByRole("treeitem", { name: "src, folder" }));
    rerender(tree("B"));
    const folder = await screen.findByRole("treeitem", { name: "src, folder" });
    fireEvent.click(folder);
    await screen.findByRole("treeitem", { name: "current.ts" });
    await act(async () => {
      old.resolve(page(entry("src/obsolete.ts")));
    });
    expect(screen.queryByRole("treeitem", { name: "obsolete.ts" })).toBeNull();
    expect(screen.getByRole("treeitem", { name: "current.ts" })).toBeInTheDocument();
    expect(runtime.client.listFiles).toHaveBeenCalledWith("B", { id: "B:src" }, 200);
  });

  it("resets selection and keyboard tab position across workspaces", async () => {
    runtime.client.listFiles.mockImplementation(async (workspace: string) =>
      page(entry("first.txt", workspace), entry("second.txt", workspace)),
    );
    const { rerender } = render(tree("A"));
    fireEvent.click(await screen.findByRole("treeitem", { name: "second.txt" }));
    expect(screen.getByRole("treeitem", { name: "second.txt" })).toHaveAttribute("aria-selected", "true");
    rerender(tree("B"));
    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(2));
    expect(screen.getByRole("treeitem", { name: "second.txt" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("treeitem", { name: "first.txt" })).toHaveAttribute("tabindex", "0");
  });

  it("retries a failed subdirectory when it is closed and reopened", async () => {
    let attempts = 0;
    runtime.client.listFiles.mockImplementation(async (_workspace: string, handle: FileHandle | null) => {
      if (!handle) return page(entry("src", "A", true));
      if (++attempts === 1)
        throw { category: "filesystem", code: "unavailable", message: "Try again", retryable: true };
      return page(entry("src/recovered.ts"));
    });
    render(tree("A"));
    const folder = await screen.findByRole("treeitem", { name: "src, folder" });
    fireEvent.click(folder);
    await screen.findByText("Try again");
    fireEvent.click(folder);
    fireEvent.click(folder);
    expect(await screen.findByRole("treeitem", { name: "recovered.ts" })).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it("does not move to a sibling on ArrowRight from an expanded empty folder", async () => {
    runtime.client.listFiles.mockImplementation(async (_workspace: string, handle: FileHandle | null) =>
      handle ? page() : page(entry("empty", "A", true), entry("sibling.txt")),
    );
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    render(tree("A"));
    fireEvent.click(await screen.findByRole("treeitem", { name: "empty, folder" }));
    const folder = await screen.findByRole("treeitem", { name: "empty, folder, empty" });
    act(() => folder.focus());
    fireEvent.keyDown(folder, { key: "ArrowRight" });
    act(() => {
      for (const callback of frames) callback(0);
    });
    expect(folder).toHaveFocus();
  });

  it("rejects scheduled focus from the previous workspace even if cancellation arrives too late", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    runtime.client.listFiles.mockImplementation(async (workspace: string) =>
      page(entry("first.txt", workspace), entry("second.txt", workspace)),
    );
    const { rerender } = render(tree("A"));
    fireEvent.keyDown(await screen.findByRole("treeitem", { name: "first.txt" }), { key: "ArrowDown" });
    rerender(tree("B"));
    const first = await screen.findByRole("treeitem", { name: "first.txt" });
    act(() => first.focus());
    act(() => {
      for (const callback of frames) callback(0);
    });
    expect(first).toHaveFocus();
  });

  it("keeps the latest keyboard focus request when older animation callbacks arrive late", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    runtime.client.listFiles.mockResolvedValue(page(entry("first.txt"), entry("second.txt"), entry("third.txt")));
    render(tree("A"));
    const first = await screen.findByRole("treeitem", { name: "first.txt" });
    fireEvent.keyDown(first, { key: "ArrowDown" });
    fireEvent.keyDown(first, { key: "End" });
    act(() => {
      for (const callback of [...frames].reverse()) callback(0);
    });
    expect(screen.getByRole("treeitem", { name: "third.txt" })).toHaveFocus();
  });

  it("does not steal focus back after the user leaves the tree", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    runtime.client.listFiles.mockResolvedValue(page(entry("first.txt"), entry("second.txt")));
    render(
      <>
        {tree("A")}
        <button type="button">Outside</button>
      </>,
    );
    const first = await screen.findByRole("treeitem", { name: "first.txt" });
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const outside = screen.getByRole("button", { name: "Outside" });
    act(() => outside.focus());
    act(() => {
      for (const callback of frames) callback(0);
    });
    expect(outside).toHaveFocus();
  });

  it("rejects the first StrictMode setup's completion after its replacement has loaded", async () => {
    const discarded = deferred<Page<FileEntry>>();
    runtime.client.listFiles.mockReturnValueOnce(discarded.promise).mockResolvedValue(page(entry("current.txt")));
    render(tree("A"));
    await screen.findByRole("treeitem", { name: "current.txt" });
    await act(async () => {
      discarded.resolve(page(entry("discarded.txt")));
    });
    expect(screen.queryByRole("treeitem", { name: "discarded.txt" })).toBeNull();
    expect(screen.getByRole("treeitem", { name: "current.txt" })).toBeInTheDocument();
  });

  it("cancels queued focus and ignores a child read after unmount", async () => {
    const frames: FrameRequestCallback[] = [];
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const child = deferred<Page<FileEntry>>();
    runtime.client.listFiles.mockImplementation((_workspace: string, handle: FileHandle | null) =>
      handle ? child.promise : Promise.resolve(page(entry("src", "A", true), entry("last.txt"))),
    );
    const { unmount } = render(tree("A"));
    const folder = await screen.findByRole("treeitem", { name: "src, folder" });
    fireEvent.click(folder);
    fireEvent.keyDown(folder, { key: "End" });
    const focus = vi.spyOn(screen.getByRole("treeitem", { name: "last.txt" }), "focus");
    unmount();
    await act(async () => {
      child.resolve(page(entry("src/late.txt")));
      for (const callback of frames) callback(0);
    });
    expect(cancel).toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});
