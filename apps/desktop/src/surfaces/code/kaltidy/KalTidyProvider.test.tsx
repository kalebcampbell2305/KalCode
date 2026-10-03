import type { TerminalInfo, ThreadSummary } from "@kalcode/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KalCodeError } from "../../../ipc/errors.ts";
import { thread } from "../../dashboard/data/testing.ts";
import { useKalTidyClosedPanes } from "./closedPanes.ts";
import { KalTidyProvider } from "./KalTidyProvider.tsx";
import { type KalTidyApi, useKalTidy } from "./kalTidyContext.ts";

const mocks = vi.hoisted(() => ({
  client: {} as Record<string, ReturnType<typeof vi.fn> | object>,
  workspaces: {} as Record<string, unknown>,
  toast: { show: vi.fn() },
  api: null as KalTidyApi | null,
}));
vi.mock("../../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => ({ client: mocks.client }) }));
vi.mock("../../../runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => mocks.workspaces }));
vi.mock("../../../shell/navigation.tsx", () => ({ useNavigation: () => ({ current: "code" }) }));
vi.mock("@kalcode/ui/components", async (original) => ({
  ...(await original<typeof import("@kalcode/ui/components")>()),
  useToast: () => mocks.toast,
}));

const W = "w1";

type FakeClient = Record<
  "listWorkspaces" | "listTerminals" | "listThreads" | "getThread" | "closeTerminal" | "stopThread" | "archiveThread",
  ReturnType<typeof vi.fn>
>;
const fake = () => mocks.client as unknown as FakeClient;

function terminal(id: string, title: string, status: TerminalInfo["status"] = "running"): TerminalInfo {
  return {
    id,
    workspaceId: W,
    shellId: "pwsh",
    title,
    position: 0,
    status,
    startedAt: null,
    endedAt: null,
    exitCode: null,
  };
}

function code(c: string): KalCodeError {
  return new KalCodeError({ category: "validation", code: c, message: c, retryable: false });
}

const agent = (name: string, status: ThreadSummary["status"], providerId = "claude-code") =>
  thread({ name, status, providerId, runtimeKind: "interactive_pty", workspaceId: W, workspaceName: "site" });

let threads: ThreadSummary[];
let terminals: TerminalInfo[];
const closedPanes: string[] = [];

function Probe() {
  mocks.api = useKalTidy();
  useKalTidyClosedPanes((keys) => closedPanes.push(...keys));
  return null;
}

function mount() {
  render(
    <KalTidyProvider>
      <Probe />
    </KalTidyProvider>,
  );
  const api = mocks.api;
  if (!api) throw new Error("KalTidy isn't mounted");
  return { api, user: userEvent.setup() };
}

beforeEach(() => {
  vi.clearAllMocks();
  closedPanes.length = 0;
  terminals = [terminal("shell", "PowerShell 7"), terminal("build", "cargo build")];
  threads = [
    agent("Claude working", "editing"),
    agent("Codex waiting", "waiting_for_permission", "codex"),
    agent("Failed agent", "failed"),
    agent("Done agent", "completed"),
    thread({ name: "A chat", status: "idle", workspaceId: W }),
  ];
  const running = new Set(["Claude working", "Codex waiting"]);
  mocks.client = {
    listWorkspaces: vi.fn().mockResolvedValue([{ id: W, name: "site" }]),
    listTerminals: vi.fn(async () => terminals),
    listThreads: vi.fn(async () => threads),
    getThread: vi.fn(async (id: string) => threads.find((t) => t.id === id)),
    closeTerminal: vi.fn().mockResolvedValue(undefined),
    stopThread: vi.fn(async (id: string) => threads.find((t) => t.id === id)),
    archiveThread: vi.fn(async (id: string) => {
      const target = threads.find((t) => t.id === id);
      if (target && running.has(target.name)) {
        running.delete(target.name); // the stop ended it
        throw code("thread_running");
      }
      return target;
    }),
    attachTerminal: vi.fn().mockResolvedValue(null),
    detachTerminal: vi.fn().mockResolvedValue(undefined),
    transport: { invoke: vi.fn().mockRejectedValue(new Error("not in this test")) },
  };
  mocks.workspaces = {
    active: { id: W, name: "site" },
    terminals,
    activeTerminalId: "shell",
    refresh: vi.fn().mockResolvedValue(undefined),
  };
});

describe("Close all terminals and agents", () => {
  it("asks once, with the exact words, and closes nothing on Cancel", async () => {
    const { api, user } = mount();
    act(() => api.closeAll());
    const dialog = screen.getByRole("alertdialog");
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(within(dialog).getByRole("heading", { name: "Close all terminals and agents?" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Active agents, builds, tests, and running processes will be stopped.");
    expect(within(dialog).getByText("site")).toBeInTheDocument();
    expect(within(dialog).getByText("2 terminals")).toBeInTheDocument();
    expect(await within(dialog).findByText("4 agents")).toBeInTheDocument();
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Cancel", "Close all"]);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const client = fake();
    expect(client.closeTerminal).not.toHaveBeenCalled();
    expect(client.stopThread).not.toHaveBeenCalled();
    expect(client.archiveThread).not.toHaveBeenCalled();
  });

  it("ends every terminal and agent, running or not, through the canonical paths", async () => {
    // Another workspace's agent is never touched, even if a list returns it.
    threads.push(thread({ name: "Elsewhere", status: "editing", runtimeKind: "interactive_pty", workspaceId: "w2" }));
    const { api, user } = mount();
    act(() => api.closeAll());
    await user.click(screen.getByRole("button", { name: "Close all" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const client = fake();
    await waitFor(() => expect(mocks.toast.show).toHaveBeenCalled());

    expect(client.listTerminals).toHaveBeenCalledWith(W);
    expect(client.closeTerminal.mock.calls.map(([id]) => id).sort()).toEqual(["build", "shell"]);
    // Working and waiting agents are stopped (their process trees end) and then removed.
    const byId = (id: string) => threads.find((t) => t.id === id)?.name;
    expect(client.stopThread.mock.calls.map(([id]) => byId(id)).sort()).toEqual(["Claude working", "Codex waiting"]);
    expect(new Set(client.archiveThread.mock.calls.map(([id]) => byId(id)))).toEqual(
      new Set(["Claude working", "Codex waiting", "Failed agent", "Done agent"]),
    );
    expect(client.archiveThread.mock.calls.some(([id]) => byId(id) === "A chat")).toBe(false);
    expect(client.archiveThread.mock.calls.some(([id]) => byId(id) === "Elsewhere")).toBe(false);
    expect(new Set(closedPanes)).toEqual(
      new Set(["terminal:shell", "terminal:build", ...threads.slice(0, 4).map((t) => `agent:${t.id}`)]),
    );
    expect(mocks.workspaces.refresh).toHaveBeenCalled();
    expect(mocks.toast.show).toHaveBeenCalledWith({ tone: "success", title: "Closed 2 terminals and 4 agents." });
  });

  it("reports what couldn't be closed", async () => {
    const client = fake();
    client.closeTerminal.mockImplementation(async (id: string) => {
      if (id === "build") throw code("terminal_kill_failed");
    });
    const { api, user } = mount();
    act(() => api.closeAll());
    await user.click(screen.getByRole("button", { name: "Close all" }));
    await waitFor(() => expect(mocks.toast.show).toHaveBeenCalled());
    expect(mocks.toast.show).toHaveBeenCalledWith({
      tone: "danger",
      title: "Closed 1 terminal and 4 agents. 1 couldn't be closed.",
    });
    expect(closedPanes).not.toContain("terminal:build");
  });
});

it("without an open workspace, Close all says so instead of asking", () => {
  mocks.workspaces.active = null;
  const { api } = mount();
  act(() => api.closeAll());
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(mocks.toast.show).toHaveBeenCalledWith(expect.objectContaining({ title: "Open a workspace first." }));
});

describe("Clearing agents", () => {
  it("clears failed agents without a confirmation and touches nothing else", async () => {
    const { api } = mount();
    const outcome = await act(() => api.clearFailed());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const client = fake();
    expect(client.archiveThread).toHaveBeenCalledTimes(1);
    expect(client.archiveThread).toHaveBeenCalledWith(threads[2]?.id);
    expect(client.stopThread).not.toHaveBeenCalled();
    expect(client.closeTerminal).not.toHaveBeenCalled();
    expect(outcome).toEqual({ cleared: 1, failed: 0, summary: "Cleared 1 failed agent." });
    expect(closedPanes).toEqual([`agent:${threads[2]?.id}`]);
  });

  it("clears finished agents only", async () => {
    const { api } = mount();
    const outcome = await act(() => api.clearFinished());
    const client = fake();
    expect(client.archiveThread.mock.calls).toEqual([[threads[3]?.id]]);
    expect(outcome.summary).toBe("Cleared 1 finished agent.");
  });

  it("dismisses one finished agent, and refuses one still in use", async () => {
    const { api } = mount();
    const client = fake();
    expect(await act(() => api.dismissAgent(threads[0]?.id ?? ""))).toBe(false);
    expect(client.archiveThread).not.toHaveBeenCalled();
    expect(mocks.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Claude working is still in use, so it was kept." }),
    );
    expect(await act(() => api.dismissAgent(threads[3]?.id ?? ""))).toBe(true);
    expect(client.archiveThread).toHaveBeenCalledWith(threads[3]?.id);
  });
});

describe("Review", () => {
  it("shows what each action would clean, and the agents the clears would remove", async () => {
    terminals = [terminal("shell", "PowerShell 7", "exited")];
    mocks.workspaces.terminals = terminals;
    const { api } = mount();
    act(() => api.openReview());
    const dialog = await screen.findByRole("dialog");
    const plan = within(dialog).getByRole("list", { name: "What each action would clean" });
    await waitFor(() =>
      expect(
        within(plan)
          .getAllByRole("listitem")
          .map((li) => li.textContent),
      ).toEqual(["Stop idle0terminals", "Clear failed1agents", "Clear finished1agents", "Close all5in workspace"]),
    );
    expect(within(dialog).getByRole("region", { name: /^Failed agents/ })).toHaveTextContent("Failed agent");
    expect(within(dialog).getByRole("region", { name: /^Finished agents/ })).toHaveTextContent("Done agent");
    expect(within(dialog).queryByText("Claude working")).toBeNull();
  });

  it("keeps the newest scan when an older, slower one finishes last", async () => {
    const client = fake();
    let releaseOld: () => void = () => undefined;
    client.listWorkspaces.mockImplementationOnce(
      () => new Promise((resolve) => (releaseOld = () => resolve([{ id: W, name: "site" }]))),
    );
    client.listTerminals.mockResolvedValueOnce([terminal("old", "Old shell", "exited")]);
    client.listTerminals.mockResolvedValueOnce([terminal("new", "New shell", "exited")]);
    const { api, user } = mount();
    act(() => api.openReview());
    const dialog = await screen.findByRole("dialog");
    // The first scan is still listing; a rescan starts and finishes first.
    client.listTerminals.mockReset();
    client.listTerminals.mockResolvedValueOnce([terminal("new", "New shell", "exited")]);
    client.listTerminals.mockResolvedValueOnce([terminal("old", "Old shell", "exited")]);
    await user.click(within(dialog).getByRole("button", { name: "Rescan" }));
    expect(await within(dialog).findByText("New shell")).toBeInTheDocument();
    await act(async () => releaseOld());
    await act(async () => undefined);
    expect(within(dialog).getByText("New shell")).toBeInTheDocument();
    expect(within(dialog).queryByText("Old shell")).toBeNull();
  });
});
