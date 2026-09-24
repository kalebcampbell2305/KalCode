import type { Settings } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { KalCodeClient } from "../../../ipc/client.ts";
import { createMemoryTransport, type MemoryScenario, type MemoryTransport } from "../../../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../../../runtime/RuntimeProvider.tsx";
import {
  DashboardDataProvider,
  useDashboardAnnouncements,
  usePendingApprovals,
  useRunningTerminals,
  useThreadSummaries,
} from "./DashboardData.tsx";

const SETTINGS: Settings = { theme: "dark", motion: "reduced", density: "comfortable", sidebarCollapsed: false };

function Probe() {
  const threads = useThreadSummaries();
  const approvals = usePendingApprovals();
  const terminals = useRunningTerminals();
  const { urgent, polite } = useDashboardAnnouncements();
  const first = approvals.state.status === "ready" ? approvals.state.data[0] : undefined;
  const target =
    threads.state.status === "ready" ? threads.state.data.find((t) => t.name === "Fix flaky checkout test") : undefined;
  return (
    <div>
      <output data-testid="threads">
        {threads.state.status === "ready" ? `ready:${threads.state.data.length}` : threads.state.status}
      </output>
      <output data-testid="approvals">
        {approvals.state.status === "ready" ? `ready:${approvals.state.data.length}` : approvals.state.status}
      </output>
      <output data-testid="terminals">{terminals.state.status}</output>
      <output data-testid="target">{target?.status ?? "none"}</output>
      <output data-testid="urgent">{urgent?.text ?? ""}</output>
      <output data-testid="polite">{polite?.text ?? ""}</output>
      <button type="button" onClick={() => first && void approvals.decide(first, "approve_once")}>
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
        <DashboardDataProvider>
          <Probe />
        </DashboardDataProvider>
      </RuntimeProvider>
    </ToastProvider>,
  );
  return transport;
}

const text = (id: string) => screen.getByTestId(id).textContent;

describe("Dashboard data layer", () => {
  it("reports the sources this build lacks as unavailable", async () => {
    await mount("default");
    await waitFor(() => expect(text("approvals")).toBe("unavailable"));
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

  it("announces approvals that arrive after the first read, assertively", async () => {
    const transport = await mount("busy");
    await waitFor(() => expect(text("approvals")).toBe("ready:2"));
    expect(text("urgent")).toBe("");
    act(() => {
      transport.dashboard?.requestApproval();
    });
    await waitFor(() => expect(text("approvals")).toBe("ready:3"));
    await waitFor(() => expect(text("urgent")).toBe("New approval request: Run pnpm prisma migrate dev"));
  });

  it("decides through approval_decide, removes the request and announces the result politely", async () => {
    await mount("busy");
    await waitFor(() => expect(text("approvals")).toBe("ready:2"));
    await userEvent.click(screen.getByRole("button", { name: "approve" }));
    await waitFor(() => expect(text("approvals")).toBe("ready:1"));
    await waitFor(() => expect(text("polite")).toBe("Approved once: Push chore/deps to origin"));
    // A decision the user made is never announced as a new arrival.
    expect(text("urgent")).toBe("");
  });

  it("shows a typed error, then recovers on retry", async () => {
    const transport = await mount("errors");
    await waitFor(() => expect(text("threads")).toBe("error"));
    transport.dashboard?.recover();
    await userEvent.click(screen.getByRole("button", { name: "reload" }));
    await waitFor(() => expect(text("threads")).toBe("ready:13"));
  });
});
