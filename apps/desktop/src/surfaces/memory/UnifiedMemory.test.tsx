import type { MemoryRecord, Workspace } from "@kalcode/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "../../ipc/client.ts";
import { createMemoryTransport } from "../../ipc/memoryTransport.ts";
import { UnifiedMemory } from "./UnifiedMemory.tsx";

const runtime = vi.hoisted(() => ({ client: null as unknown as KalCodeClient }));
const workspaces = vi.hoisted(() => ({
  active: { id: "project-a", name: "Project A" } as Workspace,
  workspaces: [] as Workspace[],
  activate: vi.fn(),
  openFolder: vi.fn(),
}));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => runtime }));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => workspaces }));
vi.mock("../../shell/navigation.tsx", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));

const memory = (id: string, title: string): MemoryRecord => ({
  id,
  workspaceId: "project-a",
  title,
  category: "architecture",
  content: "The dashboard owns the project shell.",
  pinned: false,
  permanent: false,
  sourceKind: "agent",
  sourceId: "agent-review",
  filePath: "src/Dashboard.tsx",
  fileHash: "abc",
  commitId: "abc123",
  stale: true,
  createdAt: "2026-10-01T12:00:00Z",
  updatedAt: "2026-10-01T12:00:00Z",
});

/** Captures the 5 s background refresh; other intervals (waitFor's polling) still run. */
function captureRefresh() {
  const refresh: { current?: () => void } = {};
  const real = window.setInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation(((handler: TimerHandler, ms?: number) => {
    if (ms !== 5000) return real(handler, ms);
    refresh.current = handler as () => void;
    return 1;
  }) as typeof window.setInterval);
  return refresh;
}

beforeEach(() => {
  runtime.client = new KalCodeClient(createMemoryTransport("code", { detectDelayMs: 0 }));
  workspaces.active = { id: "project-a", name: "Project A" } as Workspace;
  workspaces.workspaces = [workspaces.active];
});
afterEach(() => vi.restoreAllMocks());

describe("Unified Memory", () => {
  it("explicitly reviews stale knowledge in its workspace and keeps uncertainty on a failed recheck", async () => {
    const record = memory("one", "Dashboard ownership");
    vi.spyOn(runtime.client, "listUnifiedMemory").mockResolvedValue([record]);
    const review = vi
      .spyOn(runtime.client, "reviewUnifiedMemory")
      .mockRejectedValueOnce({
        category: "filesystem",
        code: "memory_source_missing",
        message: "The linked file could not be verified.",
        retryable: true,
      })
      .mockResolvedValueOnce({ ...record, stale: false });
    render(<UnifiedMemory />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Dashboard ownership/ }));
    await user.click(screen.getByRole("button", { name: "Mark reviewed" }));
    await screen.findByRole("alert");
    expect(screen.getByText(/related file changed or could not be verified/)).toBeInTheDocument();
    expect(review).toHaveBeenCalledWith("project-a", "one");
    await user.click(screen.getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument());
    expect(screen.queryByText(/related file changed or could not be verified/)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Memory details" })).toHaveTextContent(
      "The dashboard owns the project shell.",
    );
  });

  it("refreshes incoming knowledge while preserving an in-progress edit", async () => {
    const refresh = captureRefresh();
    const search = vi
      .spyOn(runtime.client, "listUnifiedMemory")
      .mockResolvedValue([memory("one", "Dashboard ownership")]);
    render(<UnifiedMemory />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Dashboard ownership/ }));
    const loadedCalls = search.mock.calls.length;
    act(() => refresh.current?.());
    await waitFor(() => expect(search.mock.calls.length).toBeGreaterThan(loadedCalls));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editingCalls = search.mock.calls.length;
    act(() => refresh.current?.());
    expect(search).toHaveBeenCalledTimes(editingCalls);
    expect(screen.getByRole("textbox", { name: "Knowledge" })).toHaveValue("The dashboard owns the project shell.");
  });

  it("refreshes in the background without clearing an error or disabling controls", async () => {
    const refresh = captureRefresh();
    const record = memory("one", "Dashboard ownership");
    let finish: ((records: MemoryRecord[]) => void) | undefined;
    const search = vi
      .spyOn(runtime.client, "listUnifiedMemory")
      .mockResolvedValueOnce([record])
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    vi.spyOn(runtime.client, "reviewUnifiedMemory").mockRejectedValue({
      category: "filesystem",
      code: "memory_source_missing",
      message: "The linked file could not be verified.",
      retryable: true,
    });
    render(<UnifiedMemory />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Dashboard ownership/ }));
    await user.click(screen.getByRole("button", { name: "Mark reviewed" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The linked file could not be verified.");

    act(() => refresh.current?.());
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toHaveTextContent("The linked file could not be verified.");
    expect(screen.queryByText("Searching…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remember something" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Mark reviewed" })).toBeEnabled();

    await act(async () => finish?.([{ ...record }]));
    expect(screen.getByRole("alert")).toHaveTextContent("The linked file could not be verified.");
    expect(screen.getByRole("button", { name: /Dashboard ownership/ })).toBeInTheDocument();
  });

  it("explains a native plan denial and offers the existing plans flow", async () => {
    vi.spyOn(runtime.client, "listUnifiedMemory").mockRejectedValue({
      category: "validation",
      code: "memory_plan_required",
      message: "Unified Memory is included with KalCode Pro and higher plans.",
      retryable: false,
    });
    render(<UnifiedMemory />);
    await screen.findByRole("button", { name: "View plans" });
    expect(screen.getByText(/included with KalCode Pro/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remember something" })).not.toBeInTheDocument();
  });

  it("searches the native index and ignores an older search reply", async () => {
    let finishOld: ((records: MemoryRecord[]) => void) | undefined;
    const search = vi.spyOn(runtime.client, "listUnifiedMemory").mockImplementation((_workspace, query) => {
      if (query === "old")
        return new Promise((resolve) => {
          finishOld = resolve;
        });
      return Promise.resolve(query === "release" ? [memory("indexed", "Indexed release decision")] : []);
    });
    render(<UnifiedMemory />);
    await screen.findByText("Start with what matters");
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Search project memory" }), "old");
    await waitFor(() => expect(search).toHaveBeenCalledWith("project-a", "old"));
    await user.clear(screen.getByRole("textbox", { name: "Search project memory" }));
    await user.type(screen.getByRole("textbox", { name: "Search project memory" }), "release");
    await screen.findByText("Indexed release decision");
    finishOld?.([memory("outdated", "Outdated search result")]);
    await waitFor(() => expect(screen.queryByText("Outdated search result")).not.toBeInTheDocument());
    expect(screen.getByText("Indexed release decision")).toBeInTheDocument();
  });

  it("shows source uncertainty and leaves failed edits available to retry", async () => {
    vi.spyOn(runtime.client, "listUnifiedMemory").mockResolvedValue([memory("one", "Dashboard ownership")]);
    vi.spyOn(runtime.client, "saveUnifiedMemory").mockRejectedValue({
      category: "validation",
      code: "memory_sensitive",
      message: "Memory cannot contain credentials.",
      retryable: false,
    });
    render(<UnifiedMemory />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Dashboard ownership/ }));
    expect(screen.getByText(/related file changed or could not be verified/)).toBeInTheDocument();
    expect(screen.getByText("agent-review")).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByRole("textbox", { name: "Knowledge" }));
    await user.type(screen.getByRole("textbox", { name: "Knowledge" }), "Draft should survive a rejected save.");
    await user.click(screen.getByRole("button", { name: "Save memory" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Memory cannot contain credentials.");
    expect(screen.getByRole("textbox", { name: "Knowledge" })).toHaveValue("Draft should survive a rejected save.");
  });
});
