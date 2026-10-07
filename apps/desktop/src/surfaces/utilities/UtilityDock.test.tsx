import type { ListeningPort } from "@kalcode/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryUtilityApi } from "../../ipc/memory/utilities.ts";
import { UtilityDock } from "./UtilityDock.tsx";

describe("UtilityDock", () => {
  it("runs a local JSON transform without native authority", async () => {
    const user = userEvent.setup();
    render(<UtilityDock api={new MemoryUtilityApi()} />);

    await user.click(screen.getByRole("tab", { name: "JSON" }));
    fireEvent.change(screen.getByLabelText("JSON input"), { target: { value: '{"ready":true}' } });
    await user.click(screen.getByRole("button", { name: "Format JSON" }));

    expect(screen.getByLabelText("JSON result")).toHaveValue('{\n  "ready": true\n}');
  });

  it("shows a bounded API response and never labels an unprobed tool live", async () => {
    const user = userEvent.setup();
    let continuation = 0;
    const api = new MemoryUtilityApi({
      httpSend: async () => ({ kind: "awaiting_approval", approvalId: "approval-http" }),
      effectContinue: async () => {
        continuation += 1;
        if (continuation === 1) {
          return { kind: "awaiting_approval", approvalId: "approval-http-send" };
        }
        return {
          kind: "http_completed",
          response: {
            status: 204,
            reason: "No Content",
            headers: [],
            body: "",
            bodyKind: "empty",
            contentType: null,
            bytes: 0,
            truncated: false,
            timing: { resolveMs: 1, headersMs: 4, totalMs: 5 },
            url: "https://example.test/health",
            redirects: [],
            destination: "external",
            remoteAddress: "203.0.113.8",
            historyId: "history-1",
          },
        };
      },
    });
    render(<UtilityDock api={api} />);

    await user.type(screen.getByLabelText("Request URL"), "https://example.test/health");
    await user.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText(/authorizes hostname resolution first/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Continue approved request" }));
    expect(await screen.findByText(/then the pinned request/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Continue approved request" }));

    expect(await screen.findByText("204 No Content")).toBeVisible();
    expect(api.calls.effectContinue).toEqual(["approval-http", "approval-http-send"]);
    expect(screen.queryByText(/^live$/i)).not.toBeInTheDocument();
  });

  it("requires a second deliberate click before stopping an eligible process", async () => {
    const user = userEvent.setup();
    const api = new MemoryUtilityApi({
      processes: async () => ({
        processes: [
          {
            pid: 42,
            parentPid: 7,
            name: "node.exe",
            startTime: "1700000000",
            cpuPercent: 2.5,
            memoryBytes: 1_024,
            owner: "kal_code_child",
            role: null,
            label: "Started in a KalCode terminal",
            workspaceId: "workspace-1",
            workspaceName: "Website",
            terminalId: null,
            terminalGeneration: null,
            ports: [3000],
            killable: { kind: "confirm" },
            canRestart: false,
          },
        ],
        total: 1,
        hidden: 0,
        cpuReady: true,
        sampledAt: "2026-09-25T12:00:00Z",
      }),
      effectContinue: async () => ({
        kind: "process_completed",
        result: { pid: 42, signal: "terminate", outcome: "stopped", message: "node.exe stopped." },
      }),
    });
    render(<UtilityDock api={api} />);

    await user.click(screen.getByRole("tab", { name: "Processes" }));
    expect(await screen.findByRole("list", { name: "Related processes" })).toBeVisible();
    expect(await screen.findByText("node.exe")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Stop node.exe" }));
    expect(api.calls.processSignal).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Confirm stop node.exe" }));

    await waitFor(() =>
      expect(api.calls.processSignal).toEqual([{ pid: 42, startTime: "1700000000", signal: "terminate" }]),
    );
    await user.click(screen.getByRole("button", { name: "Continue approved stop node.exe" }));
    await waitFor(() => expect(api.calls.effectContinue).toEqual(["memory-process-42"]));
  });

  it("continues an approved SQLite write by approval id without resending SQL", async () => {
    const user = userEvent.setup();
    const api = new MemoryUtilityApi({
      sqlitePick: async () => ({
        id: "db-1",
        displayName: "work.db",
        workspaceId: "workspace-1",
        bytes: 4096,
        objects: [],
      }),
      effectContinue: async () => ({
        kind: "sqlite_completed",
        result: { changes: 1, elapsedMs: 2 },
      }),
    });
    render(<UtilityDock api={api} />);

    await user.click(screen.getByRole("tab", { name: "SQLite" }));
    await user.click(screen.getByRole("button", { name: "Choose database" }));
    await waitFor(() => expect(screen.getByText(/work\.db/)).toBeVisible());
    await user.clear(screen.getByLabelText("SQL statement"));
    await user.type(screen.getByLabelText("SQL statement"), "update notes set done = 1");
    await user.click(screen.getByRole("button", { name: "Run statement" }));
    await user.click(screen.getByRole("button", { name: "Confirm database change" }));
    await user.click(screen.getByRole("button", { name: "Continue approved database change" }));

    expect(api.calls.sqliteWrite).toEqual([{ dbId: "db-1", sql: "update notes set done = 1" }]);
    expect(api.calls.effectContinue).toEqual(["memory-sqlite-db-1"]);
    expect(await screen.findByRole("alert")).toHaveTextContent("1 row changed.");
  });

  it("closes the previous SQLite handle on a new pick and the current one on unmount", async () => {
    const user = userEvent.setup();
    const open = new Set<string>();
    const closed: string[] = [];
    let picks = 0;
    let cancelNextPick = false;
    const api = new MemoryUtilityApi({
      sqlitePick: async () => {
        if (cancelNextPick) return null;
        // Mirrors the native limit: the ninth concurrent handle is refused.
        if (open.size >= 8) throw new Error("Close a database first: at most 8 can be open at once.");
        picks += 1;
        const id = `db-${picks}`;
        open.add(id);
        return { id, displayName: `work-${picks}.db`, workspaceId: null, bytes: 4096, objects: [] };
      },
      sqliteClose: async (dbId) => {
        open.delete(dbId);
        closed.push(dbId);
      },
    });
    const { unmount } = render(<UtilityDock api={api} />);

    await user.click(screen.getByRole("tab", { name: "SQLite" }));
    for (let pick = 1; pick <= 9; pick += 1) {
      await user.click(screen.getByRole("button", { name: "Choose database" }));
      await waitFor(() => expect(screen.getByText(new RegExp(`work-${pick}[.]db`))).toBeVisible());
    }
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(closed).toEqual(["db-1", "db-2", "db-3", "db-4", "db-5", "db-6", "db-7", "db-8"]);
    expect([...open]).toEqual(["db-9"]);

    // A cancelled pick keeps the current database open.
    cancelNextPick = true;
    await user.click(screen.getByRole("button", { name: "Choose database" }));
    expect(screen.getByText(/work-9\.db/)).toBeVisible();

    unmount();
    await waitFor(() => expect(open.size).toBe(0));
    expect(closed.at(-1)).toBe("db-9");
  });

  it("shows the terminal integration dependency without a dead action", async () => {
    const user = userEvent.setup();
    render(<UtilityDock api={new MemoryUtilityApi()} />);

    await user.click(screen.getByRole("tab", { name: "Scratch terminal" }));

    expect(screen.getByText(/opens through the workspace terminal authority/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /open scratch terminal/i })).not.toBeInTheDocument();
  });
  it("lists every process sharing one port without colliding row keys", async () => {
    const user = userEvent.setup();
    const shared: Omit<ListeningPort, "pid" | "processName"> = {
      protocol: "udp",
      localAddress: "0.0.0.0",
      port: 5353,
      exposure: "all_interfaces",
      owner: null,
      label: null,
      workspaceId: null,
      workspaceName: null,
    };
    const api = new MemoryUtilityApi({
      ports: async () => ({
        ports: [
          { ...shared, pid: 2500, processName: "svchost.exe" },
          { ...shared, pid: 4100, processName: "chrome.exe" },
        ],
        source: "Windows IP Helper",
        sampledAt: "2026-09-25T12:00:00Z",
      }),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<UtilityDock api={api} />);
      await user.click(screen.getByRole("tab", { name: "Ports" }));

      expect(await screen.findByText("svchost.exe")).toBeVisible();
      expect(screen.getByText("chrome.exe")).toBeVisible();
      expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/same key/i);
    } finally {
      consoleError.mockRestore();
    }
  });
});
