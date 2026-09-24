import type { EventEnvelope } from "@kalcode/protocol";
import { describe, expect, it, vi } from "vitest";
import { clampTerminalSize, KalCodeClient } from "./client.ts";
import { createMemoryTransport } from "./memoryTransport.ts";
import type { Transport } from "./transport.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

async function setup() {
  const transport = createMemoryTransport("default");
  const client = new KalCodeClient(transport);
  const events: EventEnvelope[] = [];
  await client.subscribeEvents((e) => events.push(e));
  transport.workspaces.queueFolders("site");
  const workspace = await client.openWorkspaceDialog();
  if (!workspace) throw new Error("no workspace");
  return { transport, client, events, workspace };
}

describe("terminal client", () => {
  it("clamps sizes to what native accepts", () => {
    expect(clampTerminalSize({ cols: 0, rows: 5000 })).toEqual({ cols: 2, rows: 1000 });
    expect(clampTerminalSize({ cols: 80.7, rows: Number.NaN })).toEqual({ cols: 80, rows: 2 });
  });

  it("splits large input into ordered writes within the native limit, never splitting a surrogate pair", async () => {
    const writes: string[] = [];
    const transport = {
      kind: "memory",
      invoke: vi.fn(async (_command: string, args?: Record<string, unknown>) => {
        writes.push(String(args?.data));
      }),
    } as unknown as Transport;
    const client = new KalCodeClient(transport);
    const text = `${"a".repeat(8191)}😀${"b".repeat(20_000)}`;
    await client.writeTerminal("0192f3c4-0000-7000-8000-000000000000", text);
    expect(writes.join("")).toBe(text);
    expect(writes.every((w) => new TextEncoder().encode(w).length <= 64 * 1024)).toBe(true);
    expect(writes[0]?.endsWith("a")).toBe(true);
    expect(writes[1]?.startsWith("😀")).toBe(true);
  });
});

describe("memory runtime: workspaces and terminals", () => {
  it("opens folders from the picker, reuses workspaces and emits events", async () => {
    const { transport, client, events, workspace } = await setup();
    expect(workspace.name).toBe("site");
    expect((await client.activeWorkspace())?.id).toBe(workspace.id);
    transport.workspaces.queueFolders(null);
    expect(await client.openWorkspaceDialog()).toBeNull();
    transport.workspaces.queueFolders("site");
    expect((await client.openWorkspaceDialog())?.id).toBe(workspace.id);
    await tick();
    expect(events.map((e) => e.type)).toEqual(["workspace.created", "workspace.opened"]);
    expect(events[0]?.correlation.workspaceId).toBe(workspace.id);
  });

  it("validates ids, sizes, shells and input like native", async () => {
    const { client, workspace } = await setup();
    await expect(client.listTerminals("nope")).rejects.toMatchObject({ code: "invalid_id" });
    await expect(client.transport.invoke("terminal_create", { workspaceId: workspace.id, cols: 1, rows: 30 })).rejects.toMatchObject({
      code: "invalid_size",
    });
    await expect(client.transport.invoke("terminal_create", { workspaceId: workspace.id, cols: -1, rows: 30 })).rejects.toMatchObject({
      code: "ipc_rejected",
    });
    await expect(client.createTerminal(workspace.id, "C:\\evil.exe", { cols: 80, rows: 24 })).rejects.toMatchObject({
      code: "invalid_shell",
    });
    await expect(client.createTerminal(workspace.id, "fish", { cols: 80, rows: 24 })).rejects.toMatchObject({
      code: "shell_unavailable",
    });
    const terminal = await client.createTerminal(workspace.id, null, { cols: 80, rows: 24 });
    await expect(
      client.transport.invoke("terminal_write", { terminalId: terminal.id, data: "x".repeat(64 * 1024 + 1) }),
    ).rejects.toMatchObject({ code: "input_too_large" });
  });

  it("streams a replay first, then live output; restart and close behave like native", async () => {
    const { transport, client, events, workspace } = await setup();
    const terminal = await client.createTerminal(workspace.id, "cmd", { cols: 80, rows: 24 });
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    expect(await client.attachTerminal(terminal.id, (b) => chunks.push(decoder.decode(b)))).toBe(true);
    expect(chunks[0]).toContain("Microsoft Windows");
    await client.writeTerminal(terminal.id, "echo hi\r");
    await tick();
    expect(chunks.join("")).toContain("hi\r\n");

    await client.writeTerminal(terminal.id, "exit 2\r");
    await tick();
    const [ended] = await client.listTerminals(workspace.id);
    expect(ended).toMatchObject({ status: "exited", exitCode: 2 });
    await expect(client.writeTerminal(terminal.id, "x")).rejects.toMatchObject({ code: "terminal_not_running" });

    const restarted = await client.restartTerminal(terminal.id, { cols: 80, rows: 24 });
    expect(restarted.status).toBe("running");
    expect(transport.workspaces.runningProcessCount()).toBe(1);
    await expect(client.removeWorkspace(workspace.id)).rejects.toMatchObject({ code: "terminals_running" });
    await client.closeTerminal(terminal.id);
    expect(transport.workspaces.runningProcessCount()).toBe(0);
    await client.removeWorkspace(workspace.id);
    await tick();
    expect(events.map((e) => e.type)).toEqual([
      "workspace.created",
      "shell.started",
      "shell.failed",
      "shell.started",
      "shell.completed",
      "workspace.removed",
    ]);
    expect(await client.listWorkspaces()).toEqual([]);
  });
});
