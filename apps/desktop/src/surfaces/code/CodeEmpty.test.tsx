import type { Workspace } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { render as renderView, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceValue } from "../../runtime/WorkspaceProvider.tsx";
import { CodeEmpty } from "./CodeEmpty.tsx";

const workspaceState = vi.hoisted(() => ({ current: null as unknown as WorkspaceValue }));

vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => workspaceState.current,
}));

function render(ui: ReactNode) {
  return renderView(<TooltipProvider>{ui}</TooltipProvider>);
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "kalcode",
    name: "KalCode",
    rootPath: "C:\\work\\KalCode",
    displayPath: "C:\\work\\KalCode",
    createdAt: "2026-10-01T12:00:00.000Z",
    lastOpenedAt: "2026-10-03T12:00:00.000Z",
    activeTerminalId: null,
    available: true,
    ...overrides,
  };
}

function state(overrides: Partial<WorkspaceValue> = {}): WorkspaceValue {
  return {
    state: "ready",
    error: null,
    workspaces: [],
    active: null,
    shells: [],
    terminals: [],
    activeTerminalId: null,
    running: [],
    picking: false,
    lastSize: { current: { cols: 120, rows: 30 } },
    retry: vi.fn(),
    refresh: vi.fn(async () => undefined),
    openFolder: vi.fn(async () => null),
    activate: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    createTerminal: vi.fn(async () => null),
    closeTerminal: vi.fn(async () => undefined),
    restartTerminal: vi.fn(async () => null),
    selectTerminal: vi.fn(),
    focusRequest: { terminalId: "", n: 0 },
    ...overrides,
  };
}

describe("CodeEmpty", () => {
  beforeEach(() => {
    workspaceState.current = state();
  });

  it("leads first-use users directly into the real Code workspace", async () => {
    const user = userEvent.setup();
    render(<CodeEmpty />);

    expect(screen.getByRole("heading", { level: 1, name: "Code" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Open a project folder" })).toBeVisible();
    const features = screen.getByRole("list", { name: "Code workspace features" });
    expect(within(features).getByText("Real terminals")).toBeVisible();
    expect(within(features).getByText("Coding agents")).toBeVisible();
    expect(within(features).getByText("Your layout")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Open folder…" }));
    expect(workspaceState.current.openFolder).toHaveBeenCalledOnce();
  });

  it("offers real recent workspaces and preserves safe remove semantics", async () => {
    const user = userEvent.setup();
    const available = workspace();
    const missing = workspace({
      id: "moved",
      name: "Moved project",
      rootPath: "C:\\work\\Moved",
      displayPath: "C:\\work\\Moved",
      available: false,
    });
    workspaceState.current = state({ workspaces: [available, missing] });

    render(<CodeEmpty />);

    expect(screen.getByRole("heading", { level: 2, name: "Open a project folder" })).toBeVisible();
    expect(screen.getByText("Recent workspaces")).toBeVisible();
    expect(screen.getByText("Folder not found")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Moved project" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open KalCode" }));
    expect(workspaceState.current.activate).toHaveBeenCalledWith(available.id);

    await user.click(screen.getByRole("button", { name: "Remove Moved project from KalCode" }));
    expect(workspaceState.current.remove).toHaveBeenCalledWith(missing);
  });

  it("shows immediate progress while the native folder picker is open", () => {
    workspaceState.current = state({ picking: true });
    render(<CodeEmpty />);

    expect(screen.getByRole("button", { name: "Open folder…" })).toBeDisabled();
  });
});
