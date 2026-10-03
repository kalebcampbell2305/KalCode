import type { TerminalInfo } from "@kalcode/protocol";
import { describe, expect, it, vi } from "vitest";
import { thread } from "../../dashboard/data/testing.ts";
import { closeAllSummary, closeAllTerminals } from "./closeAll.ts";

function terminal(id: string, status: TerminalInfo["status"] = "running"): TerminalInfo {
  return {
    id,
    workspaceId: "w1",
    shellId: "pwsh",
    title: "PowerShell 7",
    position: 0,
    status,
    startedAt: null,
    endedAt: null,
    exitCode: null,
  };
}

describe("closeAllTerminals", () => {
  it("closes every terminal and every coding agent, whatever it is doing", async () => {
    const terminals = [terminal("shell"), terminal("build"), terminal("ended", "exited")];
    const threads = [
      thread({ name: "claude working", runtimeKind: "interactive_pty", status: "editing" }),
      thread({
        name: "codex waiting",
        providerId: "codex",
        runtimeKind: "interactive_pty",
        status: "waiting_for_permission",
      }),
      thread({ name: "idle agent", runtimeKind: "interactive_pty", status: "idle" }),
      thread({ name: "failed agent", runtimeKind: "interactive_pty", status: "failed" }),
      thread({ name: "agent in a terminal", terminalId: "shell", status: "running_command" }),
      thread({ name: "chat thread", status: "thinking" }),
      thread({ name: "archived", runtimeKind: "interactive_pty", archivedAt: "2026-09-24T10:00:00.000Z" }),
    ];
    const closeTerminal = vi.fn().mockResolvedValue(undefined);
    const removeAgent = vi.fn().mockResolvedValue(undefined);
    const result = await closeAllTerminals({ terminals, threads }, { closeTerminal, removeAgent });
    expect(closeTerminal.mock.calls.map(([t]) => t.id)).toEqual(["shell", "build", "ended"]);
    expect(removeAgent.mock.calls.map(([t]) => t.name)).toEqual([
      "claude working",
      "codex waiting",
      "idle agent",
      "failed agent",
      "agent in a terminal",
    ]);
    expect(result).toEqual({ terminals: 3, agents: 5, failed: 0 });
    expect(closeAllSummary(result)).toBe("Closed 3 terminals and 5 agents.");
  });

  it("starts every close at once and reports the ones that failed", async () => {
    let releaseFirst: () => void = () => undefined;
    const closeTerminal = vi.fn((t: TerminalInfo) => {
      if (t.id === "slow") return new Promise<void>((resolve) => (releaseFirst = resolve));
      if (t.id === "stuck") return Promise.reject(new Error("kill failed"));
      return Promise.resolve();
    });
    const removeAgent = vi.fn().mockRejectedValue(new Error("stop failed"));
    const pending = closeAllTerminals(
      {
        terminals: [terminal("slow"), terminal("stuck"), terminal("ok")],
        threads: [thread({ runtimeKind: "interactive_pty" })],
      },
      { closeTerminal, removeAgent },
    );
    // All closes are in flight before the slow one finishes.
    expect(closeTerminal).toHaveBeenCalledTimes(3);
    expect(removeAgent).toHaveBeenCalledTimes(1);
    releaseFirst();
    const result = await pending;
    expect(result).toEqual({ terminals: 2, agents: 0, failed: 2 });
    expect(closeAllSummary(result)).toBe("Closed 2 terminals. 2 couldn't be closed.");
  });

  it("says when there is nothing to close", async () => {
    const result = await closeAllTerminals(
      { terminals: [], threads: [] },
      { closeTerminal: vi.fn(), removeAgent: vi.fn() },
    );
    expect(closeAllSummary(result)).toBe("No terminals or agents to close.");
    expect(closeAllSummary({ terminals: 0, agents: 1, failed: 1 })).toBe("Closed 1 agent. 1 couldn't be closed.");
  });
});
