import type { OperationDetail, OperationRecord, OperationsSnapshot, ThreadOptions } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationsApi } from "../../ipc/operations.ts";
import { OperationsPage } from "./OperationsPage.tsx";

const seams = vi.hoisted(() => ({
  refresh: vi.fn(async () => undefined),
  openInPane: vi.fn(async () => ({ handled: true, message: "" })),
  activate: vi.fn(async () => true),
  createTerminal: vi.fn(async () => ({ id: "terminal-created" })),
  snapshot: null as OperationsSnapshot | null,
}));

vi.mock("./useOperations.ts", () => ({
  useOperations: () => ({
    snapshot: seams.snapshot,
    loading: false,
    refreshing: false,
    error: null,
    refresh: seams.refresh,
  }),
}));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => ({
    state: "ready",
    active: { id: "workspace-1", name: "KalCode" },
    workspaces: [
      { id: "workspace-1", name: "KalCode" },
      { id: "workspace-2", name: "Other" },
    ],
    activate: seams.activate,
    createTerminal: seams.createTerminal,
  }),
}));
vi.mock("../../shell/panes/useOpenInPane.ts", () => ({ useOpenInPane: () => seams.openInPane }));

function queued(id: string, position: number): OperationRecord {
  return {
    id,
    spec: {
      name: `Task ${id}`,
      workspaceId: "workspace-1",
      kind: "test",
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
    status: "queued",
    workspaceName: "KalCode",
    branch: "main",
    version: null,
    accountLabel: null,
    terminalId: null,
    threadId: null,
    createdAt: "2026-09-30T12:00:00Z",
    startedAt: null,
    endedAt: null,
    currentAction: null,
    outcome: null,
    position,
    blockers: [],
  };
}

function baseSnapshot(): OperationsSnapshot {
  return {
    revision: 7,
    paused: true,
    items: [queued("one", 1), queued("two", 2)],
    services: [],
    environments: [],
    activity: [],
    observedAt: "2026-09-30T12:00:00Z",
    warnings: [],
  };
}

const options: ThreadOptions = {
  providers: [
    {
      id: "codex",
      displayName: "Codex",
      accountLabel: null,
      models: [{ id: "gpt-6", displayName: "GPT-6", isDefault: true }],
      supportsResume: true,
      supportsInterrupt: true,
      hostApprovals: true,
      permissionMappings: [],
    },
  ],
  workspaces: [{ id: "workspace-1", name: "KalCode" }],
  permissionModes: ["approve"],
  defaultPermissionMode: "approve",
};

function operations(): OperationsApi {
  return {
    snapshot: vi.fn(),
    detail: vi.fn(),
    history: vi.fn(),
    enqueue: vi.fn(),
    update: vi.fn(),
    reorder: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    hold: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    runNow: vi.fn(async () => undefined),
    serviceAction: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
  } as OperationsApi;
}

function renderPage(client: OperationsApi) {
  return render(page(client));
}

function page(client: OperationsApi) {
  return (
    <ToastProvider>
      <OperationsPage client={client} threadOptions={async () => options} />
    </ToastProvider>
  );
}

describe("OperationsPage", () => {
  beforeEach(() => {
    seams.snapshot = baseSnapshot();
    vi.clearAllMocks();
  });

  it.each(["test", "agent"] as const)("cancels an active Operations %s through native authority", async (kind) => {
    const run = queued("active-cancel", 1);
    run.spec.kind = kind;
    run.status = "running";
    run.startedAt = run.createdAt;
    seams.snapshot = { ...baseSnapshot(), items: [run] };
    const client = operations();
    vi.mocked(client.detail).mockResolvedValue({
      run,
      timeline: [],
      logs: "",
      files: [],
      artifacts: [],
      tests: [],
      notes: [],
    });
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("button", { name: /Task active-cancel/ }));
    await user.click(await screen.findByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(client.cancel).toHaveBeenCalledWith(run.id));
    expect(seams.refresh).toHaveBeenCalled();
  });

  it("closes the active run detail when changing workspace scope", async () => {
    const run = queued("workspace-active", 1);
    run.status = "running";
    run.startedAt = run.createdAt;
    seams.snapshot = { ...baseSnapshot(), items: [run] };
    const client = operations();
    vi.mocked(client.detail).mockResolvedValue({
      run,
      timeline: [],
      logs: "",
      files: [],
      artifacts: [],
      tests: [],
      notes: [],
    });
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("button", { name: /Task workspace-active/ }));
    await screen.findByRole("button", { name: "Cancel run" });
    await user.selectOptions(screen.getByLabelText("Workspace"), "workspace-2");
    expect(screen.queryByRole("complementary", { name: "Run details" })).not.toBeInTheDocument();
    expect(client.cancel).not.toHaveBeenCalled();
  });

  it("keeps observed active runs read-only", async () => {
    const run = queued("observed-active", 1);
    run.source = "thread";
    run.status = "running";
    run.startedAt = run.createdAt;
    seams.snapshot = { ...baseSnapshot(), items: [run] };
    const client = operations();
    vi.mocked(client.detail).mockResolvedValue({
      run,
      timeline: [],
      logs: "",
      files: [],
      artifacts: [],
      tests: [],
      notes: [],
    });
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("button", { name: /Task observed-active/ }));
    await screen.findByRole("heading", { name: "Task observed-active" });
    expect(screen.queryByRole("button", { name: "Cancel run" })).not.toBeInTheDocument();
    expect(client.cancel).not.toHaveBeenCalled();
  });

  it("loads older workspace history when its recent snapshot is empty", async () => {
    const other = queued("other-workspace", 1);
    other.spec.workspaceId = "workspace-2";
    other.status = "succeeded";
    other.startedAt = other.createdAt;
    const older = queued("older-workspace-run", 2);
    older.status = "succeeded";
    older.startedAt = "2026-09-29T12:00:00Z";
    seams.snapshot = { ...baseSnapshot(), items: [other] };
    const client = operations();
    vi.mocked(client.history).mockResolvedValue({ items: [older], nextCursor: null });
    const user = userEvent.setup();
    renderPage(client);
    expect(screen.getByText("No runs recorded")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByRole("button", { name: /Task older-workspace-run/ })).toBeVisible();
    expect(client.history).toHaveBeenCalledWith(null);
  });

  it("offers keyboard-accessible queue reordering against the current revision", async () => {
    const client = operations();
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "Move Task one down" }));
    await waitFor(() => expect(client.reorder).toHaveBeenCalledWith(["two", "one"], 7));
  });

  it("names dependency blockers without changing an explicitly Later dependency", async () => {
    const later = queued("later-dependency", 2);
    later.spec = { ...later.spec, name: "Prepare artifacts", lane: "later" };
    const next = queued("next-dependent", 1);
    next.spec = {
      ...next.spec,
      name: "Publish preview",
      lane: "next",
      dependencies: [later.id, "missing-dependency"],
    };
    next.status = "blocked";
    next.blockers = [later.id, "missing-dependency", "Run now to authorize this task."];
    seams.snapshot = { ...baseSnapshot(), items: [next, later] };
    const client = operations();
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Queue" }));

    expect(screen.getByText(/Blocked: Prepare artifacts \(Later\).*Unavailable dependency/)).toBeVisible();
    expect(screen.getByText(/Run now to authorize this task\./)).toBeVisible();
    const nextColumn = screen.getByRole("heading", { name: "Next" }).closest("section");
    const laterColumn = screen.getByRole("heading", { name: "Later" }).closest("section");
    expect(within(nextColumn as HTMLElement).getByText("Publish preview")).toBeVisible();
    expect(within(laterColumn as HTMLElement).getByText("Prepare artifacts")).toBeVisible();
    expect(client.update).not.toHaveBeenCalled();
    expect(client.reorder).not.toHaveBeenCalled();
  });

  it("shows unobserved environments honestly and visually distinguishes Production", async () => {
    const client = operations();
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Environments" }));
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(screen.getAllByText("Not observed").length).toBeGreaterThanOrEqual(4);
    const production = screen.getByRole("article", { name: "Production environment" });
    expect(within(production).getByText(/production changes use native admission/i)).toBeVisible();
    expect(screen.queryByText(/^Live$/)).not.toBeInTheDocument();
  });

  it("routes service restart through native Operations authority", async () => {
    seams.snapshot = {
      ...baseSnapshot(),
      services: [
        {
          id: "service-1",
          runId: "run-1",
          name: "Web",
          status: "running",
          pid: 3100,
          processName: "node",
          uptimeSeconds: 90,
          ports: [3000],
          urls: ["http://localhost:3000"],
          workspaceId: "workspace-1",
          workspaceName: "KalCode",
          terminalId: "terminal-1",
          canStop: true,
          canRestart: true,
          actionReason: null,
        },
      ],
    };
    const client = operations();
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Services" }));
    await user.click(screen.getByRole("button", { name: /restart/i }));
    await waitFor(() => expect(client.serviceAction).toHaveBeenCalledWith("service-1", "restart"));
  });

  it("creates and opens a terminal in the service workspace when no terminal is retained", async () => {
    seams.snapshot = {
      ...baseSnapshot(),
      services: [
        {
          id: "service-observed",
          runId: null,
          name: "API",
          status: "running",
          pid: 3200,
          processName: "node",
          uptimeSeconds: 40,
          ports: [4000],
          urls: ["http://localhost:4000"],
          workspaceId: "workspace-2",
          workspaceName: "Other",
          terminalId: null,
          canStop: false,
          canRestart: false,
          actionReason: "Observed outside Operations.",
        },
      ],
    };
    const client = operations();
    const user = userEvent.setup();
    renderPage(client);
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace" }), "");
    await user.click(screen.getByRole("tab", { name: "Services" }));
    await user.click(screen.getByRole("button", { name: "Open terminal" }));

    await waitFor(() => expect(seams.activate).toHaveBeenCalledWith("workspace-2"));
    expect(seams.createTerminal).toHaveBeenCalledWith(null, "workspace-2");
    expect(seams.openInPane).toHaveBeenCalledWith(
      { kind: "terminal", terminalId: "terminal-created" },
      { workspaceId: "workspace-2" },
    );
  });

  it("opens a retained service terminal without creating a replacement", async () => {
    seams.snapshot = {
      ...baseSnapshot(),
      services: [
        {
          id: "service-managed",
          runId: "run-service",
          name: "Frontend",
          status: "running",
          pid: 3300,
          processName: "node",
          uptimeSeconds: 80,
          ports: [3000],
          urls: ["http://localhost:3000"],
          workspaceId: "workspace-1",
          workspaceName: "KalCode",
          terminalId: "terminal-retained",
          canStop: true,
          canRestart: true,
          actionReason: null,
        },
      ],
    };
    const client = operations();
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Services" }));
    await user.click(screen.getByRole("button", { name: "Open terminal" }));

    expect(seams.createTerminal).not.toHaveBeenCalled();
    expect(seams.openInPane).toHaveBeenCalledWith(
      { kind: "terminal", terminalId: "terminal-retained" },
      { workspaceId: "workspace-1" },
    );
  });

  it("refreshes active run logs when observedAt advances without a revision change", async () => {
    const active = queued("active", 1);
    active.status = "running";
    active.startedAt = "2026-09-30T12:00:00Z";
    seams.snapshot = { ...baseSnapshot(), items: [active] };
    const client = operations();
    vi.mocked(client.detail)
      .mockResolvedValueOnce({
        run: active,
        timeline: [],
        logs: "first log frame",
        files: [],
        artifacts: [],
        tests: [],
        notes: [],
      })
      .mockResolvedValueOnce({
        run: active,
        timeline: [],
        logs: "second log frame",
        files: [],
        artifacts: [],
        tests: [],
        notes: [],
      });
    const user = userEvent.setup();
    const view = renderPage(client);
    await user.click(screen.getByRole("button", { name: /Task active/i }));
    await waitFor(() => expect(client.detail).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("tab", { name: "Logs" }));
    expect(screen.getByText("first log frame")).toBeVisible();

    seams.snapshot = {
      ...baseSnapshot(),
      items: [active],
      revision: 7,
      observedAt: "2026-09-30T12:00:03Z",
    };
    view.rerender(page(client));
    await waitFor(() => expect(client.detail).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("second log frame")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
  });

  it("loads run details through the Strict Mode effect replay", async () => {
    const active = queued("strict-active", 1);
    active.status = "running";
    active.startedAt = "2026-09-30T12:00:00Z";
    seams.snapshot = { ...baseSnapshot(), items: [active] };
    const client = operations();
    vi.mocked(client.detail).mockResolvedValue({
      run: active,
      timeline: [],
      logs: "strict mode evidence",
      files: [],
      artifacts: [],
      tests: [],
      notes: [],
    });
    const user = userEvent.setup();
    render(<StrictMode>{page(client)}</StrictMode>);
    await user.click(screen.getByRole("button", { name: /Task strict-active/i }));

    expect(await screen.findByRole("heading", { name: "Task strict-active" })).toBeVisible();
    expect(client.detail).toHaveBeenCalledTimes(1);
  });

  it("coalesces active detail refreshes behind one in-flight request", async () => {
    const active = queued("active", 1);
    active.status = "running";
    active.startedAt = "2026-09-30T12:00:00Z";
    seams.snapshot = { ...baseSnapshot(), items: [active] };
    const client = operations();
    let resolveFirst!: (value: OperationDetail) => void;
    vi.mocked(client.detail)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValue({
        run: active,
        timeline: [],
        logs: "latest frame",
        files: [],
        artifacts: [],
        tests: [],
        notes: [],
      });
    const user = userEvent.setup();
    const view = renderPage(client);
    await user.click(screen.getByRole("button", { name: /Task active/i }));
    await waitFor(() => expect(client.detail).toHaveBeenCalledTimes(1));

    seams.snapshot = { ...baseSnapshot(), items: [active], observedAt: "2026-09-30T12:00:03Z" };
    view.rerender(page(client));
    seams.snapshot = { ...baseSnapshot(), items: [active], observedAt: "2026-09-30T12:00:06Z" };
    view.rerender(page(client));
    expect(client.detail).toHaveBeenCalledTimes(1);

    resolveFirst({
      run: active,
      timeline: [],
      logs: "first frame",
      files: [],
      artifacts: [],
      tests: [],
      notes: [],
    });
    await waitFor(() => expect(client.detail).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("tab", { name: "Logs" }));
    expect(await screen.findByText("latest frame")).toBeVisible();
  });

  it("keeps a started paused agent in Runs and Now without pending task actions", async () => {
    const pausedAgent = queued("paused-agent", 1);
    pausedAgent.status = "paused";
    pausedAgent.startedAt = "2026-09-30T12:00:00Z";
    pausedAgent.spec = {
      ...pausedAgent.spec,
      name: "Paused provider turn",
      kind: "agent",
      command: null,
      prompt: "Continue the implementation",
      providerId: "codex",
      model: "gpt-6",
    };
    seams.snapshot = { ...baseSnapshot(), items: [pausedAgent] };
    const client = operations();
    const user = userEvent.setup();
    renderPage(client);

    expect(screen.getByRole("button", { name: /Paused provider turn/i })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Queue" }));
    const now = screen.getByRole("heading", { name: "Now" }).closest("section");
    expect(now).not.toBeNull();
    expect(within(now as HTMLElement).getByText("Paused provider turn")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Pending tasks" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move Paused provider turn/ })).not.toBeInTheDocument();
    expect(client.runNow).not.toHaveBeenCalled();
    expect(client.reorder).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
  });

  it("extends run history without replacing fresher snapshot status", async () => {
    const current = queued("current", 0);
    current.status = "succeeded";
    current.startedAt = "2026-09-30T12:00:00Z";
    current.endedAt = "2026-09-30T12:02:00Z";
    current.outcome = "Fresh snapshot result";
    const stale = { ...current, status: "failed" as const, outcome: "Stale history result" };
    const older = queued("older", 0);
    older.spec = { ...older.spec, name: "Older regression run" };
    older.status = "succeeded";
    older.createdAt = "2026-09-29T12:00:00Z";
    older.startedAt = "2026-09-29T12:00:00Z";
    older.endedAt = "2026-09-29T12:03:00Z";
    seams.snapshot = { ...baseSnapshot(), items: [current] };
    const client = operations();
    vi.mocked(client.history).mockResolvedValue({ items: [stale, older], nextCursor: null });
    const user = userEvent.setup();
    renderPage(client);

    await user.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByText("Older regression run")).toBeVisible();
    expect(screen.getByText("Fresh snapshot result")).toBeVisible();
    expect(screen.queryByText("Stale history result")).not.toBeInTheDocument();
    expect(client.history).toHaveBeenCalledWith(null);
  });

  it("keeps unknown historical evidence reachable without presenting it as active or complete", async () => {
    const current = queued("current", 0);
    current.status = "succeeded";
    current.startedAt = "2026-09-30T12:00:00Z";
    current.endedAt = "2026-09-30T12:01:00Z";
    const unknown = queued("historical", 0);
    unknown.spec = { ...unknown.spec, name: "Historical agent turn" };
    unknown.source = "agent";
    unknown.status = "unknown";
    unknown.createdAt = "2026-09-29T12:00:00Z";
    unknown.startedAt = "2026-09-29T12:00:00Z";
    const older = queued("older", 0);
    older.spec = { ...older.spec, name: "Earlier verified run" };
    older.status = "succeeded";
    older.createdAt = "2026-09-28T12:00:00Z";
    older.startedAt = "2026-09-28T12:00:00Z";
    older.endedAt = "2026-09-28T12:01:00Z";
    seams.snapshot = { ...baseSnapshot(), items: [current] };
    const client = operations();
    vi.mocked(client.history)
      .mockResolvedValueOnce({ items: [unknown], nextCursor: "opaque:page-2" })
      .mockResolvedValueOnce({ items: [older], nextCursor: null });
    vi.mocked(client.detail).mockResolvedValue({
      run: unknown,
      logs: "",
      timeline: [],
      files: [],
      artifacts: [],
      tests: [],
      notes: [],
    });
    const user = userEvent.setup();
    renderPage(client);

    await user.click(screen.getByRole("button", { name: "Load older" }));
    const historical = await screen.findByRole("button", { name: /Historical agent turn/ });
    expect(historical).toHaveTextContent("Unknown");
    expect(historical).toHaveTextContent("Unavailable");
    await user.click(historical);
    const detail = await screen.findByRole("complementary", { name: "Run details" });
    expect(within(detail).getByText("Current action unavailable.")).toBeVisible();
    expect(within(detail).getByText("Completion evidence unavailable.")).toBeVisible();
    await user.click(within(detail).getByRole("button", { name: "Close run details" }));
    await user.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByText("Earlier verified run")).toBeVisible();
    expect(vi.mocked(client.history).mock.calls).toEqual([[null], ["opaque:page-2"]]);

    await user.click(screen.getByRole("tab", { name: "Queue" }));
    expect(screen.queryByText("Historical agent turn")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move Historical agent turn/ })).not.toBeInTheDocument();
  });

  it("clears provider-only fields when an agent task changes to a command", async () => {
    const client = operations();
    vi.mocked(client.enqueue).mockResolvedValue(queued("created", 3));
    const user = userEvent.setup();
    renderPage(client);
    await user.click(screen.getByRole("tab", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Inspect runtime");
    await user.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "agent");
    await user.selectOptions(await screen.findByRole("combobox", { name: "Provider" }), "codex");
    await user.selectOptions(screen.getByRole("combobox", { name: "Model" }), "gpt-6");
    await user.type(screen.getByRole("textbox", { name: "Prompt" }), "Inspect the runtime");
    await user.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "script");
    await user.type(screen.getByRole("textbox", { name: "Command" }), "pnpm inspect");
    await user.click(screen.getByRole("button", { name: "Add to queue" }));

    await waitFor(() => expect(client.enqueue).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.enqueue).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        kind: "script",
        command: "pnpm inspect",
        prompt: null,
        providerId: null,
        providerAccountId: null,
        model: null,
        effort: null,
      }),
    );
  });

  it("fences an older-history response after the workspace changes", async () => {
    const current = queued("current", 0);
    current.status = "succeeded";
    current.startedAt = "2026-09-30T12:00:00Z";
    seams.snapshot = { ...baseSnapshot(), items: [current] };
    const client = operations();
    let resolveHistory!: (value: { items: OperationRecord[]; nextCursor: string | null }) => void;
    vi.mocked(client.history).mockReturnValue(
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
    );
    const stale = queued("stale", 0);
    stale.spec = { ...stale.spec, name: "Wrong workspace history", workspaceId: "workspace-2" };
    stale.workspaceName = "Other";
    stale.status = "succeeded";
    stale.startedAt = "2026-09-29T12:00:00Z";
    const user = userEvent.setup();
    renderPage(client);

    await user.click(screen.getByRole("button", { name: "Load older" }));
    await user.selectOptions(screen.getByLabelText("Workspace"), "workspace-2");
    expect(await screen.findByText("No runs recorded")).toBeVisible();
    await act(async () => resolveHistory({ items: [stale], nextCursor: null }));
    expect(screen.queryByText("Wrong workspace history")).not.toBeInTheDocument();
  });
});
