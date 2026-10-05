import type { OperationRecord, OperationsSnapshot, WorkspaceRailEntry } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RailDialogs } from "./RailDialogs.tsx";
import { WorkspaceContextMenu } from "./WorkspaceContextMenu.tsx";
import { workspaceDeployments } from "./workspaceOperations.ts";

const state = vi.hoisted(() => ({
  activate: vi.fn(async () => true),
  navigate: vi.fn(),
  openPane: vi.fn(async () => ({ handled: true })),
  update: vi.fn(async () => ({})),
  dispatch: vi.fn(async (..._args: unknown[]) => ({ handled: true })),
  invoke: vi.fn(async () => undefined),
}));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useOptionalWorkspaces: () => ({ active: { id: "other" } }),
  useWorkspaces: () => ({ activate: state.activate, active: { id: "other" } }),
}));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({
    client: { transport: { invoke: state.invoke } },
    info: { flags: { features: [{ id: "provider_panes", visible: true, state: "available" }] } },
  }),
}));
vi.mock("../navigation.tsx", () => ({ useNavigation: () => ({ navigate: state.navigate }) }));
vi.mock("../panes/useOpenInPane.ts", () => ({ useOpenInPane: () => state.openPane }));
vi.mock("../panes/paneCommands.ts", () => ({
  activateAndDispatchPaneCommand: (...args: unknown[]) => state.dispatch(...args),
}));
vi.mock("../deck/DeckData.tsx", () => ({ useDeckData: () => ({ operations: { data: null, failed: false } }) }));
vi.mock("./RailProvider.tsx", () => ({ useRail: () => ({ update: state.update, rail: { groups: [] } }) }));

const entry: WorkspaceRailEntry = {
  workspaceId: "clicked",
  name: "Clicked workspace",
  folderName: "clicked",
  displayPath: "~/clicked",
  location: "local",
  available: true,
  active: false,
  pinned: false,
  archived: false,
  groupId: null,
  collapsed: false,
  indexMessages: false,
  providers: [],
  threads: 0,
  working: 0,
  needsYou: 0,
  lastOpenedAt: "2026-10-03",
  lastActivityAt: "2026-10-03",
};

function mount(overrides: Partial<WorkspaceRailEntry> = {}) {
  const onDialog = vi.fn();
  render(
    <ToastProvider>
      <WorkspaceContextMenu entry={{ ...entry, ...overrides }} onDialog={onDialog}>
        <button type="button">Workspace row</button>
      </WorkspaceContextMenu>
    </ToastProvider>,
  );
  return onDialog;
}

beforeEach(() => vi.clearAllMocks());

describe("workspace context actions", () => {
  it("opens immediately without IPC and opens Browser in the clicked workspace", async () => {
    mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Workspace row" }), { clientX: 42, clientY: 84 });
    expect(screen.getByRole("menu", { name: "Clicked workspace workspace actions" })).toBeVisible();
    expect(state.invoke).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("menuitem", { name: "Open Browser" }));
    expect(state.openPane).toHaveBeenCalledWith(expect.objectContaining({ kind: "browser" }), {
      workspaceId: "clicked",
    });
    expect(state.activate).not.toHaveBeenCalled();
  });
  it("supports keyboard invocation and targets the coding launcher", async () => {
    mount();
    fireEvent.keyDown(screen.getByRole("button", { name: "Workspace row" }), { key: "F10", shiftKey: true });
    await userEvent.click(screen.getByRole("menuitem", { name: "New coding agent…" }));
    expect(state.dispatch).toHaveBeenCalledWith(
      "clicked",
      { kind: "open-agent-launcher" },
      state.activate,
      expect.any(Function),
      expect.any(Function),
    );
  });
  it("hides impossible file-dependent actions for a missing workspace", () => {
    mount({ available: false });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Workspace row" }));
    expect(screen.queryByRole("menuitem", { name: "Open Browser" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "New coding agent…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Deploy / release" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Workspace settings…" })).toBeVisible();
  });
  it("pins the clicked workspace directly", async () => {
    mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Workspace row" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Pin workspace in rail" }));
    expect(state.update).toHaveBeenCalledWith({ workspaceId: "clicked", pinned: true });
  });
  it("saves actual settings on the clicked workspace", async () => {
    const onClose = vi.fn();
    render(<RailDialogs dialog={{ kind: "settings", entry }} onClose={onClose} />);
    const name = screen.getByRole("textbox", { name: "Workspace name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Renamed");
    await userEvent.click(screen.getByRole("checkbox", { name: "Pin workspace" }));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({
        workspaceId: "clicked",
        name: "Renamed",
        pinned: true,
        indexMessages: false,
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });
});

describe("configured workspace deployments", () => {
  const run = (id: string, patch: Partial<OperationRecord> = {}) =>
    ({
      id,
      source: "operations",
      status: "queued",
      blockers: [],
      spec: { workspaceId: "clicked", kind: "deploy" },
      ...patch,
    }) as OperationRecord;
  const snapshot = (items: OperationRecord[], paused = false) => ({ items, paused }) as OperationsSnapshot;
  it("offers only ready owner-authored tasks belonging to this workspace", () => {
    const ready = run("ready");
    const other = { ...ready, id: "other", spec: { ...ready.spec, workspaceId: "other" } };
    expect(
      workspaceDeployments(
        snapshot([
          ready,
          other,
          run("history", { status: "succeeded" }),
          run("blocked", { blockers: ["test"] }),
          run("observed", { source: "terminal" }),
          run("held", { status: "paused" }),
        ]),
        "clicked",
      ),
    ).toEqual([ready]);
    expect(workspaceDeployments(snapshot([ready], true), "clicked")).toEqual([]);
    expect(workspaceDeployments(null, "clicked")).toEqual([]);
  });
});
