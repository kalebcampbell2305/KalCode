import type { DevelopmentService, OperationDetail, OperationRecord, OperationsSnapshot } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationsApi } from "../../ipc/operations.ts";
import { blockingBrowserOverlayOpen } from "../browser/browserVisibility.ts";
import {
  CodeContextOperations,
  codeContextOperationsAvailable,
  codeContextOperationsContent,
} from "./CodeContextOperations.tsx";

const seams = vi.hoisted(() => ({
  snapshot: null as OperationsSnapshot | null,
  refresh: vi.fn(async () => undefined),
  navigate: vi.fn(),
  openInPane: vi.fn(async () => ({ handled: true, message: "" })),
  activate: vi.fn(async () => true),
  createTerminal: vi.fn(async () => ({ id: "created-terminal" })),
  operationsEnabled: [] as boolean[],
}));

vi.mock("../operations/useOperations.ts", () => ({
  useOperations: (_client: OperationsApi, enabled: boolean) => {
    seams.operationsEnabled.push(enabled);
    return {
      snapshot: seams.snapshot,
      observedAt: seams.snapshot?.observedAt ?? null,
      loading: false,
      refreshing: false,
      error: null,
      refresh: seams.refresh,
    };
  },
}));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => ({
    state: "ready",
    active: { id: "workspace-1", name: "KalCode" },
    activate: seams.activate,
    createTerminal: seams.createTerminal,
  }),
}));
vi.mock("../../shell/panes/useOpenInPane.ts", () => ({ useOpenInPane: () => seams.openInPane }));
vi.mock("../../shell/navigation.tsx", () => ({
  useNavigation: () => ({ current: "code", navigate: seams.navigate }),
}));
vi.mock("../../account/AccountProvider.tsx", () => ({ useOptionalAccount: () => null }));

function run(id: string, workspaceId: string, kind: OperationRecord["spec"]["kind"]): OperationRecord {
  return {
    id,
    spec: {
      name: id === "test-current" ? "Workspace tests" : id === "test-other" ? "Other tests" : "Build desktop",
      workspaceId,
      kind,
      command: "pnpm test",
      prompt: null,
      providerId: null,
      providerAccountId: null,
      model: null,
      effort: null,
      dependencies: [],
      priority: 0,
      lane: "next",
      environment: "local",
      urls: [],
      envKeys: [],
    },
    source: "operations",
    status: "succeeded",
    workspaceName: workspaceId === "workspace-1" ? "KalCode" : "Other",
    branch: "main",
    version: null,
    accountLabel: null,
    terminalId: null,
    threadId: null,
    createdAt: "2026-10-03T12:00:00Z",
    startedAt: "2026-10-03T12:00:01Z",
    endedAt: "2026-10-03T12:00:04Z",
    currentAction: null,
    outcome: "Completed",
    position: 0,
    blockers: [],
  };
}

function service(id: string, workspaceId: string): DevelopmentService {
  return {
    id,
    runId: id === "service-current" ? "build-current" : null,
    name: id === "service-current" ? "Frontend" : "Other service",
    status: "running",
    pid: 42,
    processName: "node",
    uptimeSeconds: 10,
    ports: [3000],
    urls: ["http://localhost:3000"],
    workspaceId,
    workspaceName: workspaceId === "workspace-1" ? "KalCode" : "Other",
    terminalId: "terminal-1",
    canStop: true,
    canRestart: true,
    actionReason: null,
  };
}

function snapshot(): OperationsSnapshot {
  return {
    revision: 3,
    paused: false,
    items: [
      run("test-current", "workspace-1", "test"),
      run("test-other", "workspace-2", "test"),
      run("build-current", "workspace-1", "build"),
    ],
    services: [service("service-current", "workspace-1"), service("service-other", "workspace-2")],
    environments: [],
    activity: [],
    observedAt: "2026-10-03T12:00:05Z",
    warnings: [],
  };
}

function api(): OperationsApi {
  const current = run("test-current", "workspace-1", "test");
  const detail: OperationDetail = {
    run: current,
    timeline: [],
    logs: null,
    files: [],
    artifacts: [],
    tests: [{ name: "Desktop suite", status: "passed", detail: "42 tests passed" }],
    notes: [],
    relatedServices: [],
    relatedDeployments: [],
  };
  return {
    snapshot: vi.fn(),
    detail: vi.fn(async () => detail),
    history: vi.fn(),
    enqueue: vi.fn(),
    update: vi.fn(),
    reorder: vi.fn(),
    pause: vi.fn(),
    hold: vi.fn(),
    cancel: vi.fn(async () => undefined),
    runNow: vi.fn(),
    serviceAction: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
  } as OperationsApi;
}

function context(client: OperationsApi, visible = true) {
  return (
    <StrictMode>
      <ToastProvider>
        <CodeContextOperations client={client} visible={visible} />
      </ToastProvider>
    </StrictMode>
  );
}

function renderContext(client: OperationsApi, visible = true) {
  return render(context(client, visible));
}

describe("CodeContextOperations", () => {
  beforeEach(() => {
    seams.snapshot = snapshot();
    seams.operationsEnabled.length = 0;
    vi.clearAllMocks();
  });

  it("registers only behind the native Operations gate", () => {
    expect(codeContextOperationsContent()).toEqual({ kind: "widget", widgetId: "code-context-operations" });
    expect(codeContextOperationsAvailable({ surfaces: [{ id: "operations", visible: true, state: "preview" }] })).toBe(
      true,
    );
    expect(codeContextOperationsAvailable([{ id: "operations", visible: true, state: "gated" }])).toBe(false);
    expect(codeContextOperationsAvailable([{ id: "operations", visible: false, state: "available" }])).toBe(false);
  });

  it("suspends the Operations feed while its pane is hidden and resumes when shown", () => {
    const client = api();
    const view = renderContext(client);
    expect(seams.operationsEnabled.at(-1)).toBe(true);

    view.rerender(context(client, false));
    expect(seams.operationsEnabled.at(-1)).toBe(false);

    view.rerender(context(client, true));
    expect(seams.operationsEnabled.at(-1)).toBe(true);
  });

  it("keeps selected run state but removes its global drawer while the pane is hidden", async () => {
    const client = api();
    const user = userEvent.setup();
    const view = renderContext(client);
    await user.click(screen.getByRole("tab", { name: /Tests/ }));
    await user.click(screen.getByRole("button", { name: "Open run Workspace tests" }));
    expect(await screen.findByRole("dialog", { name: "Run details" })).toBeVisible();
    expect(blockingBrowserOverlayOpen()).toBe(true);

    view.rerender(context(client, false));
    expect(screen.queryByRole("dialog", { name: "Run details" })).not.toBeInTheDocument();
    expect(blockingBrowserOverlayOpen()).toBe(false);

    view.rerender(context(client, true));
    expect(await screen.findByRole("dialog", { name: "Run details" })).toBeVisible();
    expect(blockingBrowserOverlayOpen()).toBe(true);
    await user.click(screen.getByRole("button", { name: "Close run details" }));
    expect(blockingBrowserOverlayOpen()).toBe(false);
  });

  it("scopes test runs to Code's workspace and opens the canonical test evidence tab", async () => {
    const client = api();
    const user = userEvent.setup();
    renderContext(client);

    await user.click(screen.getByRole("tab", { name: /Tests/ }));
    const tests = screen.getByRole("list", { name: "Test runs" });
    expect(within(tests).getByText("Workspace tests")).toBeVisible();
    expect(within(tests).queryByText("Other tests")).not.toBeInTheDocument();
    await user.click(within(tests).getByRole("button", { name: "Open run Workspace tests" }));

    const detail = await screen.findByRole("dialog", { name: "Run details" });
    expect(within(detail).getByRole("tab", { name: "Tests" })).toHaveAttribute("aria-selected", "true");
    expect(within(detail).getByText("42 tests passed")).toBeVisible();
    expect(client.detail).toHaveBeenCalledWith("test-current");
  });

  it("opens without mutations and keeps canonical service controls live under Strict Mode", async () => {
    const client = api();
    const user = userEvent.setup();
    renderContext(client);

    expect(client.serviceAction).not.toHaveBeenCalled();
    expect(client.openUrl).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /Services/ }));
    const services = screen.getByRole("list", { name: "Workspace services" });
    expect(within(services).getByText("Frontend")).toBeVisible();
    expect(within(services).queryByText("Other service")).not.toBeInTheDocument();

    await user.click(within(services).getByRole("button", { name: "Browser" }));
    await waitFor(() => expect(client.openUrl).toHaveBeenCalledWith("http://localhost:3000"));
    await waitFor(() => expect(seams.refresh).toHaveBeenCalledTimes(1));
    await user.click(within(services).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(client.serviceAction).toHaveBeenCalledWith("service-current", "stop"));
    await waitFor(() => expect(seams.refresh).toHaveBeenCalledTimes(2));
  });

  it("admits a service mutation only once before React commits its busy state", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const client = api();
    vi.mocked(client.serviceAction).mockReturnValue(pending);
    const user = userEvent.setup();
    renderContext(client);
    await user.click(screen.getByRole("tab", { name: /Services/ }));
    const stop = within(screen.getByRole("list", { name: "Workspace services" })).getByRole("button", {
      name: "Stop",
    });

    act(() => {
      fireEvent.click(stop);
      fireEvent.click(stop);
    });
    expect(client.serviceAction).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    await waitFor(() => expect(stop).not.toBeDisabled());
  });
});
