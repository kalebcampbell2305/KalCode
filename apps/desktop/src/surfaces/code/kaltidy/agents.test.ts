import { describe, expect, it, vi } from "vitest";
import { KalCodeError } from "../../../ipc/errors.ts";
import { ALL_STATUSES, thread } from "../../dashboard/data/testing.ts";
import { agentCleanup, clearAgents, clearSummary, isClearableAgent, removeAgent } from "./agents.ts";
import { announceClosedPane } from "./closedPanes.ts";

const agent = (overrides: Parameters<typeof thread>[0] = {}) =>
  thread({ runtimeKind: "interactive_pty", ...overrides });

function code(c: string): KalCodeError {
  return new KalCodeError({ category: "validation", code: c, message: c, retryable: false });
}

vi.mock("./closedPanes.ts", () => ({ announceClosedPane: vi.fn() }));

describe("agentCleanup", () => {
  it("clears only agents whose session is over, never one in use", () => {
    const classes = Object.fromEntries(ALL_STATUSES.map((status) => [status, agentCleanup(agent({ status }))]));
    expect(classes).toEqual({
      starting: null,
      active: null,
      thinking: null,
      running_tool: null,
      running_command: null,
      editing: null,
      testing: null,
      reviewing: null,
      idle: null,
      waiting_for_permission: null,
      waiting_for_user: null,
      waiting_for_dependency: null,
      paused: null,
      recovering: null,
      failed: "failed",
      completed: "finished",
      interrupted: "finished",
      offline: "finished",
    });
  });

  it("never treats a chat thread or an archived agent as clearable", () => {
    expect(agentCleanup(thread({ status: "failed" }))).toBeNull();
    expect(isClearableAgent(agent({ status: "failed", archivedAt: "2026-09-24T10:00:00.000Z" }))).toBe(false);
    expect(isClearableAgent(agent({ status: "completed" }))).toBe(true);
  });
});

describe("removeAgent", () => {
  it("archives the agent and closes its pane", async () => {
    const target = agent({ status: "completed" });
    const client = { archiveThread: vi.fn().mockResolvedValue(target), stopThread: vi.fn() };
    await removeAgent(client, target);
    expect(client.archiveThread).toHaveBeenCalledWith(target.id);
    expect(client.stopThread).not.toHaveBeenCalled();
    expect(announceClosedPane).toHaveBeenCalledWith({ kind: "agent", id: target.id });
  });

  it("ends a session that is still held before archiving, so nothing is orphaned", async () => {
    const target = agent({ status: "failed" });
    const client = {
      archiveThread: vi.fn().mockRejectedValueOnce(code("thread_running")).mockResolvedValueOnce(target),
      stopThread: vi.fn().mockResolvedValue(target),
    };
    await removeAgent(client, target);
    expect(client.stopThread).toHaveBeenCalledWith(target.id);
    expect(client.archiveThread).toHaveBeenCalledTimes(2);
  });

  it("reports a real failure and leaves the pane", async () => {
    vi.mocked(announceClosedPane).mockClear();
    const target = agent({ status: "failed" });
    const client = { archiveThread: vi.fn().mockRejectedValue(code("io_error")), stopThread: vi.fn() };
    await expect(removeAgent(client, target)).rejects.toThrow("io_error");
    expect(announceClosedPane).not.toHaveBeenCalled();
  });
});

describe("clearAgents", () => {
  const list = [
    agent({ name: "failed", status: "failed" }),
    agent({ name: "done", status: "completed" }),
    agent({ name: "stopped", status: "interrupted" }),
    agent({ name: "working", status: "editing" }),
    agent({ name: "needs you", status: "waiting_for_user" }),
    thread({ name: "chat", status: "failed" }),
  ];

  it("clears failed agents only", async () => {
    const client = { archiveThread: vi.fn(async (id: string) => thread({ id })), stopThread: vi.fn() };
    expect(await clearAgents(client, list, "failed")).toEqual({ cleared: 1, failed: 0 });
    expect(client.archiveThread.mock.calls.map(([id]) => id)).toEqual([list[0]?.id]);
  });

  it("clears finished and stopped agents, never working or waiting ones, and counts failures", async () => {
    const client = {
      archiveThread: vi.fn(async (id: string) => {
        if (id === list[2]?.id) throw code("io_error");
        return thread({ id });
      }),
      stopThread: vi.fn(),
    };
    expect(await clearAgents(client, list, "finished")).toEqual({ cleared: 1, failed: 1 });
    expect(client.archiveThread.mock.calls.map(([id]) => id)).toEqual([list[1]?.id, list[2]?.id]);
  });

  it("summarises truthfully", () => {
    expect(clearSummary({ cleared: 2, failed: 0 }, "failed")).toBe("Cleared 2 failed agents.");
    expect(clearSummary({ cleared: 1, failed: 1 }, "finished")).toBe(
      "Cleared 1 finished agent. 1 agent couldn't be cleared.",
    );
    expect(clearSummary({ cleared: 0, failed: 0 }, "finished")).toBe("No finished agents to clear.");
  });
});
