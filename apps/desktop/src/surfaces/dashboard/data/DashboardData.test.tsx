import type { Settings } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { KalCodeClient } from "../../../ipc/client.ts";
import { createMemoryTransport, type MemoryScenario, type MemoryTransport } from "../../../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../../../runtime/RuntimeProvider.tsx";
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

  it("shows a typed error, then recovers on retry", async () => {
    const transport = await mount("errors");
    await waitFor(() => expect(text("threads")).toBe("error"));
    transport.dashboard?.recover();
    await userEvent.click(screen.getByRole("button", { name: "reload" }));
    await waitFor(() => expect(text("threads")).toBe("ready:13"));
  });
});
