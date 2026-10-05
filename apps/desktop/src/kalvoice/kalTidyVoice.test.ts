import type { ThreadStatus, ThreadSummary } from "@kalcode/protocol";
import { describe, expect, it, vi } from "vitest";
import type { KalTidyApi } from "../surfaces/code/kaltidy/kalTidyContext.ts";
import { closeIdleAgents, idleAgentsToClose, parseKalTidyCommand, runKalTidyCommand } from "./kalTidyVoice.ts";

describe("parseKalTidyCommand", () => {
  it.each([
    "close all idle terminals",
    "Close all idle terminals.",
    "close idle terminals",
    "stop idle terminals",
    "kill idle terminals",
    "Kill all the idle terminals",
    "shut down my idle terminals",
    "clean up terminals",
    "Clean up my terminals",
    "tidy up terminals",
    "tidy terminals",
    "Tidy up all my terminals, please",
    "KalTidy",
    "Kal Tidy",
    "kal-tidy",
    "Cal tidy.",
    "run kaltidy",
    "Run KalTidy now",
    "um, close all idle terminals",
    "Hey Kal, close all idle terminals",
    "KalVoice, stop idle terminals for me",
    "can you close idle terminals please",
    "I'd like you to kill idle terminals",
    "go ahead and close all of my idle terminals, thanks",
  ])("runs KalTidy for %j", (text) => {
    expect(parseKalTidyCommand(text)).toBe("run");
  });

  it.each([
    "review idle terminals",
    "Show idle terminals",
    "show me my idle terminals",
    "list all idle terminals",
    "Which terminals are idle?",
    "which of my terminals are idle",
    "KalTidy review",
    "Kal tidy, review",
    "review KalTidy",
    "open kaltidy",
    "hey kal, which terminals are idle",
  ])("opens the review for %j", (text) => {
    expect(parseKalTidyCommand(text)).toBe("review");
  });

  it.each([
    "close this terminal",
    "close the terminal",
    "close terminal",
    "open a terminal",
    "open terminals",
    "stop the build",
    "stop the tests",
    "kill the terminal",
    "close all terminals",
    "stop all terminals",
    "clean up",
    "tidy up",
    "tidy",
    "kal",
    "idle terminals",
    "terminals",
    "don't close idle terminals",
    "close idle terminals and run the tests",
    "close idle terminals then open the dashboard",
    "please close idle terminals after the build finishes",
    "we should close all idle terminals before we ship",
    "I think KalTidy closes idle terminals",
    "the idle terminals are fine",
    "show idle agents",
    "show the idle threads",
    "",
    "   ",
  ])("leaves %j to native routing", (text) => {
    expect(parseKalTidyCommand(text)).toBeNull();
  });
});

function api(overrides: Partial<KalTidyApi> = {}): KalTidyApi {
  return {
    openReview: vi.fn(),
    stopIdle: vi.fn().mockResolvedValue({ stopped: 3, kept: 2, failed: 0, summary: "Stopped 3 idle terminals." }),
    clearFailed: vi.fn(),
    clearFinished: vi.fn(),
    dismissAgent: vi.fn(),
    closeAll: vi.fn(),
    ...overrides,
  };
}

describe("runKalTidyCommand", () => {
  it("says KalTidy isn't available when there is no provider", async () => {
    const report = vi.fn();
    await runKalTidyCommand(null, "run", report);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      ok: false,
      message: "KalTidy isn't available here. Nothing was stopped.",
    });
  });

  it("stops idle terminals and reports KalTidy's own summary", async () => {
    const kalTidy = api();
    const report = vi.fn();
    await runKalTidyCommand(kalTidy, "run", report);
    expect(kalTidy.stopIdle).toHaveBeenCalledOnce();
    expect(kalTidy.openReview).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledExactlyOnceWith({ ok: true, message: "Stopped 3 idle terminals." });
  });

  it("reports a partial failure as not ok, still in KalTidy's words", async () => {
    const kalTidy = api({
      stopIdle: vi.fn().mockResolvedValue({ stopped: 1, kept: 0, failed: 1, summary: "Stopped 1; 1 couldn't stop." }),
    });
    const report = vi.fn();
    await runKalTidyCommand(kalTidy, "run", report);
    expect(report).toHaveBeenCalledExactlyOnceWith({ ok: false, message: "Stopped 1; 1 couldn't stop." });
  });

  it("opens the review without stopping anything", async () => {
    const kalTidy = api();
    const report = vi.fn();
    await runKalTidyCommand(kalTidy, "review", report);
    expect(kalTidy.openReview).toHaveBeenCalledOnce();
    expect(kalTidy.stopIdle).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledExactlyOnceWith({
      ok: true,
      message: "Opened KalTidy review. Nothing was stopped.",
    });
  });
});

let n = 0;
function agent(providerId: string, status: ThreadStatus, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  n += 1;
  return {
    id: `01999a4e-0003-7${String(n).padStart(3, "0")}-8a2e-${String(n).padStart(12, "0")}`,
    name: `Agent ${n}`,
    providerId,
    providerName: providerId,
    model: null,
    effort: null,
    providerAccountId: null,
    accountLabel: null,
    workspaceId: "ws",
    workspaceName: "kalcode",
    permissionMode: "approve",
    status,
    currentActivity: null,
    createdAt: "2026-10-04T08:00:00.000Z",
    lastActivityAt: "2026-10-04T09:00:00.000Z",
    pendingApprovals: 0,
    unreadMessages: 0,
    filesChanged: null,
    branch: null,
    error: null,
    archivedAt: null,
    resumable: false,
    permissionProfileId: null,
    runtimeKind: "interactive_pty",
    terminalId: null,
    worktreeId: null,
    ...overrides,
  };
}

describe("close all idle agents (every provider)", () => {
  const fleet = () => {
    const agents = {
      claudeIdle: agent("claude-code", "idle"),
      codexReady: agent("codex", "idle", { currentActivity: "Ready for a task" }),
      cursorIdle: agent("cursor", "idle"),
      geminiIdle: agent("gemini-cli", "idle"),
      claudeWorking: agent("claude-code", "running_tool"),
      codexNeedsYou: agent("codex", "waiting_for_user"),
      cursorApproval: agent("cursor", "idle", { pendingApprovals: 1 }),
      geminiPaused: agent("gemini-cli", "paused"),
      codexLastTurnFailed: agent("codex", "idle", { currentActivity: "Last turn failed" }),
      claudeDone: agent("claude-code", "completed"),
      chatIdle: agent("codex", "idle", { runtimeKind: "headless" }),
      archivedIdle: agent("cursor", "idle", { archivedAt: "2026-10-04T10:00:00.000Z" }),
    };
    return { agents, list: Object.values(agents) };
  };

  it("chooses idle coding agents of every provider and nothing in use", () => {
    const { agents, list } = fleet();
    expect(new Set(idleAgentsToClose(list, null))).toEqual(
      new Set([agents.claudeIdle, agents.codexReady, agents.cursorIdle, agents.geminiIdle]),
    );
    expect(idleAgentsToClose(list, "cursor")).toEqual([agents.cursorIdle]);
    expect(idleAgentsToClose(list, "codex")).toEqual([agents.codexReady]);
  });

  it("removes each through KalTidy's canonical removal and reports the Fleet's summary", async () => {
    const { agents, list } = fleet();
    const client = {
      listThreads: vi.fn().mockResolvedValue(list),
      archiveThread: vi.fn(async (id: string) => ({ ...agents.claudeIdle, id })),
      stopThread: vi.fn(),
    };
    const report = vi.fn();
    await closeIdleAgents(client, null, report);
    expect(client.archiveThread).toHaveBeenCalledTimes(4);
    expect(client.stopThread).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledExactlyOnceWith({ ok: true, message: "Closed 4 idle agents." });
  });

  it("says when there is nothing idle to close, naming a provider only when asked", async () => {
    const working = [agent("claude-code", "active"), agent("gemini-cli", "idle")];
    const client = { listThreads: vi.fn().mockResolvedValue(working), archiveThread: vi.fn(), stopThread: vi.fn() };
    const report = vi.fn();
    await closeIdleAgents(client, "cursor", report);
    expect(report).toHaveBeenCalledExactlyOnceWith({ ok: true, message: "No idle Cursor agents to close." });
    expect(client.archiveThread).not.toHaveBeenCalled();
  });

  it("reports a removal that failed", async () => {
    const client = {
      listThreads: vi.fn().mockResolvedValue([agent("codex", "idle"), agent("cursor", "idle")]),
      archiveThread: vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce({ code: "io", message: "disk" }),
      stopThread: vi.fn(),
    };
    const report = vi.fn();
    await closeIdleAgents(client, null, report);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      ok: false,
      message: "Closed 1 idle agent. 1 agent couldn't be closed.",
    });
  });

  it("leaves agent phrases to native routing, which closes idle agents rather than stopping all", () => {
    for (const text of ["close all idle agents", "stop all idle agents", "kill idle codex agents"]) {
      expect(parseKalTidyCommand(text)).toBeNull();
    }
  });
});
