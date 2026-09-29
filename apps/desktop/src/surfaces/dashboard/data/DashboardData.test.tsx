import type { Settings, ThreadSummary } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Activity, StrictMode, useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "../../../ipc/client.ts";
import { createMemoryTransport, type MemoryScenario, type MemoryTransport } from "../../../ipc/memoryTransport.ts";
import { RuntimeProvider, useEvents } from "../../../runtime/RuntimeProvider.tsx";
import { PermissionsProvider, usePermissions } from "../../permissions/index.ts";
import {
  DashboardDataProvider,
  useDashboardAnnouncements,
  useRunningTerminals,
  useThreadSummaries,
} from "./DashboardData.tsx";

const SETTINGS: Settings = { theme: "dark", motion: "reduced", density: "comfortable", sidebarCollapsed: false };

function Probe() {
  const threads = useThreadSummaries();
  // Pending approvals come from the permission engine's shared state (Z4), as on the Dashboard.
  const approvals = usePermissions();
  const terminals = useRunningTerminals();
  const { urgent, polite } = useDashboardAnnouncements();
  const first = approvals.pendingState === "ready" ? approvals.pending.at(-1) : undefined;
  const target =
    threads.state.status === "ready" ? threads.state.data.find((t) => t.name === "Fix flaky checkout test") : undefined;
  return (
    <div>
      <output data-testid="threads">
        {threads.state.status === "ready" ? `ready:${threads.state.data.length}` : threads.state.status}
      </output>
      <output data-testid="approvals">
        {approvals.pendingState === "ready" ? `ready:${approvals.pending.length}` : approvals.pendingState}
      </output>
      <output data-testid="terminals">{terminals.state.status}</output>
      <output data-testid="target">{target?.status ?? "none"}</output>
      <output data-testid="urgent">{urgent?.text ?? ""}</output>
      <output data-testid="polite">{polite?.text ?? ""}</output>
      <button type="button" onClick={() => first && void approvals.decide(first.id, "approve_once")}>
        approve
      </button>
      <button type="button" onClick={() => threads.reload()}>
        reload
      </button>
    </div>
  );
}

async function mount(scenario: MemoryScenario): Promise<MemoryTransport> {
  const transport = createMemoryTransport(scenario);
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  render(
    <ToastProvider>
      <RuntimeProvider client={client} info={boot.info} initialSettings={SETTINGS}>
        <PermissionsProvider>
          <DashboardDataProvider>
            <Probe />
          </DashboardDataProvider>
        </PermissionsProvider>
      </RuntimeProvider>
    </ToastProvider>,
  );
  return transport;
}

const text = (id: string) => screen.getByTestId(id).textContent;

describe("Dashboard data layer", () => {
  it("reads every source natively in a fresh session", async () => {
    await mount("default");
    await waitFor(() => expect(text("approvals")).toBe("ready:0"));
    await waitFor(() => expect(text("threads")).toBe("ready:0"));
    await waitFor(() => expect(text("terminals")).toBe("ready"));
  });

  it("loads typed data from the contract commands", async () => {
    await mount("busy");
    await waitFor(() => expect(text("threads")).toBe("ready:13"));
    expect(text("approvals")).toBe("ready:2");
    expect(text("terminals")).toBe("ready");
  });

  it("refreshes threads when the event log records a status change", async () => {
    const transport = await mount("busy");
    await waitFor(() => expect(text("target")).toBe("running_command"));
    act(() => transport.dashboard?.setThreadStatus("01999a4e-0002-7002-8a2e-000000002002", "testing", "Running tests"));
    await waitFor(() => expect(text("target")).toBe("testing"));
  });

  it("lists approvals that arrive after the first read", async () => {
    const transport = await mount("busy");
    await waitFor(() => expect(text("approvals")).toBe("ready:2"));
    act(() => {
      transport.dashboard?.requestApproval();
    });
    await waitFor(() => expect(text("approvals")).toBe("ready:3"));
  });

  it("decides through approval_decide and removes the request", async () => {
    await mount("busy");
    await waitFor(() => expect(text("approvals")).toBe("ready:2"));
    await userEvent.click(screen.getByRole("button", { name: "approve" }));
    await waitFor(() => expect(text("approvals")).toBe("ready:1"));
    // Approvals are announced app-wide (ApprovalAnnouncer), never by the Dashboard's data layer.
    expect(text("urgent")).toBe("");
  });

  it("re-reads threads once when the event tracker starts, so an event before the history load isn't missed", async () => {
    const transport = createMemoryTransport("busy");
    const client = new KalCodeClient(transport);
    const boot = await client.boot();
    // Hold the event history back until after the first thread read and a live status change.
    const recent = client.recentEvents.bind(client);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(client, "recentEvents").mockImplementationOnce(async (...args) => {
      await gate;
      return recent(...args);
    });
    render(
      <ToastProvider>
        <RuntimeProvider client={client} info={boot.info} initialSettings={SETTINGS}>
          <PermissionsProvider>
            <DashboardDataProvider>
              <Probe />
            </DashboardDataProvider>
          </PermissionsProvider>
        </RuntimeProvider>
      </ToastProvider>,
    );
    await waitFor(() => expect(text("target")).toBe("running_command"));
    act(() => transport.dashboard?.setThreadStatus("01999a4e-0002-7002-8a2e-000000002002", "testing", "Running tests"));
    // The history that loads now already contains that change, so it sits under the watermark.
    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => expect(text("target")).toBe("testing"));
  });

  it("keeps archived threads off the board and lists them on their own side", async () => {
    const transport = await mount("archived");
    await waitFor(() => expect(text("threads")).toBe("ready:0"));
    const client = new KalCodeClient(transport);
    const [first] = await client.listThreads({ includeArchived: true });
    if (!first) throw new Error("fixture has archived threads");
    await client.unarchiveThread(first.id);
    // thread.unarchived refreshes the list like any thread event.
    await waitFor(() => expect(text("threads")).toBe("ready:1"));
  });

  it("shows a typed error, then recovers on retry", async () => {
    const transport = await mount("errors");
    await waitFor(() => expect(text("threads")).toBe("error"));
    transport.dashboard?.recover();
    await userEvent.click(screen.getByRole("button", { name: "reload" }));
    await waitFor(() => expect(text("threads")).toBe("ready:13"));
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function dashboardClient() {
  const transport = createMemoryTransport("busy");
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  const thread = (await client.listThreads())[0];
  if (!thread) throw new Error("Busy fixture must contain a thread");
  return { client, boot, transport, thread };
}

async function lifecycleHarness() {
  const first = await dashboardClient();
  const second = await dashboardClient();
  let current!: ReturnType<typeof useThreadSummaries> & ReturnType<typeof useDashboardAnnouncements>;
  let eventsReady = false;
  const commits: (typeof current)[] = [];
  function Capture() {
    current = { ...useThreadSummaries(), ...useDashboardAnnouncements() };
    eventsReady = useEvents().state === "ready";
    const snapshot = current;
    useLayoutEffect(() => {
      commits.push(snapshot);
    });
    return null;
  }
  function tree(source: typeof first, shown = true, mode: "visible" | "hidden" = "visible") {
    return (
      <StrictMode>
        <ToastProvider>
          <RuntimeProvider client={source.client} info={source.boot.info} initialSettings={SETTINGS}>
            <Activity mode={mode}>
              {shown && (
                <DashboardDataProvider>
                  <Capture />
                </DashboardDataProvider>
              )}
            </Activity>
          </RuntimeProvider>
        </ToastProvider>
      </StrictMode>
    );
  }
  const view = render(tree(first));
  await waitFor(() => expect(current.state.status).toBe("ready"));
  await waitFor(() => expect(eventsReady).toBe(true));
  // Let the one refresh that follows the tracker's start (see DashboardDataProvider) settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 180));
  });
  return {
    first,
    second,
    commits,
    get current() {
      return current;
    },
    get firstCommit() {
      const snapshot = commits[0];
      if (!snapshot) throw new Error("Expected a committed Dashboard snapshot");
      return snapshot;
    },
    replace: (source: typeof first) => view.rerender(tree(source)),
    hide: () => view.rerender(tree(first, false)),
    suspend: () => view.rerender(tree(first, true, "hidden")),
    resume: () => view.rerender(tree(first)),
  };
}

describe("Dashboard client and action lifetimes", () => {
  it("does not expose old cards or pending actions in the replacement client's first commit", async () => {
    const h = await lifecycleHarness();
    const action = deferred<ThreadSummary>();
    vi.spyOn(h.first.client, "interruptThread").mockReturnValue(action.promise);
    act(() => {
      void h.current.runAction(h.first.thread, "interrupt");
    });
    const read = deferred<ThreadSummary[]>();
    vi.spyOn(h.second.client, "listThreads").mockReturnValue(read.promise);
    h.commits.length = 0;
    h.replace(h.second);
    expect(h.firstCommit.state.status).toBe("loading");
    expect(h.firstCommit.pendingActions.size).toBe(0);
  });

  it("retires retained action handles on client replacement, including A to B to A", async () => {
    const h = await lifecycleHarness();
    const old = h.current.runAction;
    const dispatch = vi.spyOn(h.first.client, "interruptThread");
    h.replace(h.second);
    h.replace(h.first);
    await act(() => old(h.first.thread, "interrupt"));
    expect(dispatch).not.toHaveBeenCalled();
    await waitFor(() => expect(h.current.state.status).toBe("ready"));
    await act(() => h.current.runAction(h.first.thread, "interrupt"));
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("does not let an old success clear the replacement client's pending action or announce it", async () => {
    const h = await lifecycleHarness();
    const old = deferred<ThreadSummary>();
    const next = deferred<ThreadSummary>();
    vi.spyOn(h.first.client, "interruptThread").mockReturnValue(old.promise);
    vi.spyOn(h.second.client, "stopThread").mockReturnValue(next.promise);
    let running!: Promise<void>;
    act(() => {
      running = h.current.runAction(h.first.thread, "interrupt");
    });
    h.replace(h.second);
    await waitFor(() => expect(h.current.state.status).toBe("ready"));
    act(() => {
      void h.current.runAction(h.second.thread, "stop");
    });
    await act(async () => {
      old.resolve(h.first.thread);
      await running;
    });
    expect(h.current.pendingActions.get(h.second.thread.id)).toBe("stop");
    expect(h.current.polite).toBeNull();
  });

  it("suppresses late failures and invalidations after Dashboard unmount", async () => {
    const h = await lifecycleHarness();
    const failure = deferred<ThreadSummary>();
    vi.spyOn(h.first.client, "interruptThread").mockReturnValue(failure.promise);
    let running!: Promise<void>;
    act(() => {
      running = h.current.runAction(h.first.thread, "interrupt");
    });
    h.hide();
    await act(async () => {
      failure.reject(new Error("retired dashboard failure"));
      await running;
    });
    expect(screen.queryByText(/Couldn't pause/)).not.toBeInTheDocument();
  });

  it("rejects retained actions after unmount before dispatch", async () => {
    const h = await lifecycleHarness();
    const action = h.current.runAction;
    const dispatch = vi.spyOn(h.first.client, "interruptThread");
    h.hide();
    await act(() => action(h.first.thread, "interrupt"));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not revive an action handle from the retired StrictMode effect session", async () => {
    const h = await lifecycleHarness();
    const dispatch = vi.spyOn(h.first.client, "interruptThread");
    await act(() => h.firstCommit.runAction(h.first.thread, "interrupt"));
    expect(dispatch).not.toHaveBeenCalled();
    await act(() => h.current.runAction(h.first.thread, "interrupt"));
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("clears old announcements on the first replacement commit", async () => {
    const h = await lifecycleHarness();
    await act(() => h.current.runAction(h.first.thread, "interrupt"));
    expect(h.current.polite?.text).toContain("pause requested");
    h.commits.length = 0;
    h.replace(h.second);
    expect(h.firstCommit.polite).toBeNull();
  });

  it("retires pending actions and announcements when preserved state reconnects after Activity hiding", async () => {
    const h = await lifecycleHarness();
    await act(() => h.current.runAction(h.first.thread, "interrupt"));
    expect(h.current.polite).not.toBeNull();
    const old = deferred<ThreadSummary>();
    vi.spyOn(h.first.client, "resumeThread").mockReturnValueOnce(old.promise);
    let running!: Promise<void>;
    act(() => {
      running = h.current.runAction(h.first.thread, "resume");
    });
    expect(h.current.pendingActions.get(h.first.thread.id)).toBe("resume");
    h.suspend();
    h.commits.length = 0;
    h.resume();
    expect(h.firstCommit.pendingActions.size).toBe(0);
    expect(h.firstCommit.polite).toBeNull();
    await act(async () => {
      old.resolve(h.first.thread);
      await running;
    });
    expect(h.current.pendingActions.size).toBe(0);
    expect(h.current.polite).toBeNull();
    await act(() => h.current.runAction(h.first.thread, "resume"));
    expect(h.current.polite?.text).toContain("resume requested");
  });

  it("ignores an old client's failure while the new client's same-id action is pending", async () => {
    const h = await lifecycleHarness();
    const old = deferred<ThreadSummary>();
    const next = deferred<ThreadSummary>();
    vi.spyOn(h.first.client, "interruptThread").mockReturnValue(old.promise);
    vi.spyOn(h.second.client, "stopThread").mockReturnValue(next.promise);
    let running!: Promise<void>;
    act(() => {
      running = h.current.runAction(h.first.thread, "interrupt");
    });
    h.replace(h.second);
    await waitFor(() => expect(h.current.state.status).toBe("ready"));
    act(() => {
      void h.current.runAction(h.second.thread, "stop");
    });
    await act(async () => {
      old.reject(new Error("old client failure"));
      await running;
    });
    expect(screen.queryByText(/Couldn't pause/)).not.toBeInTheDocument();
    expect(h.current.pendingActions.get(h.second.thread.id)).toBe("stop");
  });

  it("does not let the previous runtime's scheduled debounce refresh the replacement runtime", async () => {
    const h = await lifecycleHarness();
    act(() => h.first.transport.dashboard?.setThreadStatus(h.first.thread.id, "testing", "old event"));
    const reads = vi.spyOn(h.second.client, "listThreads");
    h.replace(h.second);
    await waitFor(() => expect(h.current.state.status).toBe("ready"));
    // The replacement reads once, then once more when its own event tracker starts.
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    expect(reads).toHaveBeenCalledTimes(2);
    act(() => h.second.transport.dashboard?.setThreadStatus(h.second.thread.id, "testing", "live event"));
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(3));
  });

  it("a current failure reports the error, clears pending state and reconciles threads", async () => {
    const h = await lifecycleHarness();
    vi.spyOn(h.first.client, "interruptThread").mockRejectedValue({
      category: "internal",
      code: "test_failure",
      message: "Synthetic failure",
      retryable: false,
    });
    const reads = vi.spyOn(h.first.client, "listThreads");
    await act(() => h.current.runAction(h.first.thread, "interrupt"));
    expect(screen.getByText(/Couldn't pause/)).toBeInTheDocument();
    expect(h.current.pendingActions.size).toBe(0);
    await waitFor(() => expect(reads).toHaveBeenCalledOnce());
  });

  it("resets the event watermark for a replacement runtime with lower sequence numbers", async () => {
    const h = await lifecycleHarness();
    const firstReads = vi.spyOn(h.first.client, "listThreads");
    for (let n = 0; n < 20; n++) {
      act(() => h.first.transport.dashboard?.setThreadStatus(h.first.thread.id, "testing", "old runtime"));
    }
    await waitFor(() => expect(firstReads).toHaveBeenCalled());
    h.replace(h.second);
    await waitFor(() => expect(h.current.state.status).toBe("ready"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    const reads = vi.spyOn(h.second.client, "listThreads");
    act(() => h.second.transport.dashboard?.setThreadStatus(h.second.thread.id, "testing", "new runtime"));
    await waitFor(() => expect(reads).toHaveBeenCalled());
  });

  it("keeps newer same-thread actions pending when an earlier action finishes", async () => {
    const h = await lifecycleHarness();
    const old = deferred<ThreadSummary>();
    const next = deferred<ThreadSummary>();
    vi.spyOn(h.first.client, "interruptThread").mockReturnValue(old.promise);
    vi.spyOn(h.first.client, "stopThread").mockReturnValue(next.promise);
    let running!: Promise<void>;
    act(() => {
      running = h.current.runAction(h.first.thread, "interrupt");
    });
    act(() => {
      void h.current.runAction(h.first.thread, "stop");
    });
    await act(async () => {
      old.resolve(h.first.thread);
      await running;
    });
    expect(h.current.pendingActions.get(h.first.thread.id)).toBe("stop");
  });
});
