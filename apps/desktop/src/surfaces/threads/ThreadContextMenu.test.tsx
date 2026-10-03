import type { ProviderAccount, ThreadSummary, Workspace } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadContextMenu, ThreadMenuDataProvider } from "./ThreadContextMenu.tsx";

const runtime = vi.hoisted(() => ({ client: null as unknown, events: [] }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({ client: runtime.client }),
  useEvents: () => ({ events: runtime.events }),
}));

const thread: ThreadSummary = {
  id: "clicked-thread",
  name: "Clicked conversation",
  providerId: "claude-code",
  providerName: "Claude Code",
  model: null,
  effort: null,
  providerAccountId: "current",
  accountLabel: "Personal",
  workspaceId: "current-workspace",
  workspaceName: "Current",
  permissionMode: "approve",
  status: "idle",
  currentActivity: null,
  createdAt: "2026-10-03T00:00:00Z",
  lastActivityAt: "2026-10-03T00:00:00Z",
  pendingApprovals: 0,
  unreadMessages: 0,
  filesChanged: 0,
  branch: null,
  error: null,
  archivedAt: null,
  resumable: false,
  permissionProfileId: null,
  runtimeKind: null,
  terminalId: null,
  worktreeId: null,
  canMoveWorkspace: true,
};
const workspace: Workspace = {
  id: "destination",
  name: "Destination",
  rootPath: "C:/destination",
  displayPath: "C:/destination",
  available: true,
  createdAt: "",
  lastOpenedAt: "",
  activeTerminalId: null,
};
const account: ProviderAccount = {
  id: "alternate",
  providerId: "claude-code",
  displayName: "Work",
  providerReportedIdentity: null,
  authenticationState: "authenticated",
  isDefault: false,
  createdAt: "",
  lastUsedAt: null,
  lastCheckedAt: null,
  lastErrorCode: null,
  archivedAt: null,
};
function makeClient() {
  return {
    listWorkspaces: vi.fn().mockResolvedValue([workspace]),
    listProviderAccounts: vi.fn().mockResolvedValue([account]),
    renameThread: vi.fn().mockResolvedValue(thread),
    duplicateThread: vi.fn().mockResolvedValue({ ...thread, id: "copy" }),
    moveThread: vi.fn().mockResolvedValue(thread),
    rebindThreadAccount: vi.fn().mockResolvedValue(thread),
    archiveThread: vi.fn().mockResolvedValue(thread),
    unarchiveThread: vi.fn().mockResolvedValue(thread),
  };
}
let client: ReturnType<typeof makeClient>;
beforeEach(() => {
  client = makeClient();
  runtime.client = client;
});

function mount(partial: Partial<ThreadSummary> = {}) {
  const onChanged = vi.fn();
  const onDuplicated = vi.fn();
  render(
    <ToastProvider>
      <ThreadMenuDataProvider>
        <ThreadContextMenu thread={{ ...thread, ...partial }} onChanged={onChanged} onDuplicated={onDuplicated}>
          <button type="button">Thread row</button>
        </ThreadContextMenu>
      </ThreadMenuDataProvider>
    </ToastProvider>,
  );
  return { user: userEvent.setup(), onChanged, onDuplicated };
}
function open() {
  fireEvent.contextMenu(screen.getByRole("button", { name: "Thread row" }));
}

describe("Thread context actions", () => {
  it("opens immediately while context data is pending and renames the clicked thread", async () => {
    client.listWorkspaces.mockReturnValue(new Promise(() => {}));
    client.listProviderAccounts.mockReturnValue(new Promise(() => {}));
    const { user, onChanged } = mount();
    open();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Thread name" });
    await user.clear(input);
    await user.type(input, "Updated name");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(client.renameThread).toHaveBeenCalledWith("clicked-thread", "Updated name"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("duplicates the clicked conversation and selects the returned copy", async () => {
    const { user, onDuplicated } = mount();
    open();
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(client.duplicateThread).toHaveBeenCalledWith("clicked-thread");
    await waitFor(() => expect(onDuplicated).toHaveBeenCalledWith(expect.objectContaining({ id: "copy" })));
  });

  it("moves directly to the selected workspace", async () => {
    const { user } = mount();
    await waitFor(() => expect(client.listWorkspaces).toHaveBeenCalled());
    open();
    await user.hover(await screen.findByRole("menuitem", { name: "Move to workspace" }));
    // jsdom has no geometry for Radix's pointer-travel grace area; browser coverage exercises the pointer path.
    fireEvent.click(await screen.findByRole("menuitem", { name: "Destination" }));
    await waitFor(() => expect(client.moveThread).toHaveBeenCalledWith("clicked-thread", "destination"));
  });

  it.each([false, undefined])("hides move when native eligibility is %s", async (canMoveWorkspace) => {
    mount({ canMoveWorkspace });
    await waitFor(() => expect(client.listWorkspaces).toHaveBeenCalled());
    open();
    expect(screen.queryByRole("menuitem", { name: "Move to workspace" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  });

  it("offers only usable same-provider accounts and preserves the canonical rebind confirmation", async () => {
    client.listProviderAccounts.mockResolvedValue([
      account,
      { ...account, id: "wrong-provider", providerId: "codex", displayName: "Wrong provider" },
      { ...account, id: "signed-out", authenticationState: "not_authenticated", displayName: "Signed out" },
    ]);
    const { user } = mount();
    await waitFor(() => expect(client.listProviderAccounts).toHaveBeenCalled());
    open();
    await user.hover(await screen.findByRole("menuitem", { name: "Rebind account" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Work (Claude Code)" }));
    expect(client.rebindThreadAccount).not.toHaveBeenCalled();
    expect(screen.queryByRole("menuitem", { name: "Wrong provider" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Switch to Work (Claude Code)" }));
    expect(client.rebindThreadAccount).toHaveBeenCalledWith("clicked-thread", "alternate");
  });

  it.each([
    { status: "running_tool" },
    { status: "waiting_for_permission", pendingApprovals: 1 },
  ] as Partial<ThreadSummary>[])("hides unsafe actions while the thread is busy: %o", async (partial) => {
    mount(partial);
    open();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    for (const name of ["Move to workspace", "Rebind account", "Archive", "Duplicate"])
      expect(screen.queryByRole("menuitem", { name })).not.toBeInTheDocument();
  });

  it("restores archived threads and hides impossible mutations", async () => {
    const { user } = mount({ archivedAt: "2026-10-02T00:00:00Z" });
    open();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Duplicate" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Restore thread" }));
    expect(client.unarchiveThread).toHaveBeenCalledWith("clicked-thread");
  });

  it("exposes the same actions through keyboard invocation", () => {
    mount();
    const row = screen.getByRole("button", { name: "Thread row" });
    row.focus();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  });

  it.each(["Cancel", "Save name"])("returns keyboard focus to the clicked row after rename %s", async (action) => {
    const { user } = mount();
    const row = screen.getByRole("button", { name: "Thread row" });
    row.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    await user.keyboard("{Home}{Enter}");
    expect(screen.getByRole("dialog", { name: "Rename thread" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(row).toHaveFocus());
  });

  it("archives the clicked object without selecting a different conversation", async () => {
    const { user, onChanged } = mount();
    open();
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(client.archiveThread).toHaveBeenCalledWith("clicked-thread");
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });

  it("reports a native refusal without pretending the object changed", async () => {
    client.archiveThread.mockRejectedValue({
      category: "validation",
      code: "thread_busy",
      message: "The thread started working. Stop it first.",
      retryable: false,
    });
    const { user, onChanged } = mount();
    open();
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(await screen.findByText("The thread started working. Stop it first.")).toBeVisible();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
