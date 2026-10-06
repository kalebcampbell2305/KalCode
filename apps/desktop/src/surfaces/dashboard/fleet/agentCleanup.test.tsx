import type { ThreadStatus, ThreadSummary } from "@kalcode/protocol";
import { DISPLAY_STATUS_OF } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { KalTidyContext } from "../../code/kaltidy/kalTidyContext.ts";
import { canDismiss, cleanupCounts, cleanupSteps, cleanupSummary, useAgentCleanup } from "./agentCleanup.ts";

const data = vi.hoisted(() => ({ threads: [] as ThreadSummary[], runBulk: vi.fn() }));
vi.mock("../data/DashboardData.tsx", () => ({
  useCodingAgents: () => ({ state: { status: "ready", data: data.threads }, runBulk: data.runBulk }),
  useArchivedCodingAgents: () => ({ state: { status: "ready", data: [] }, runBulk: vi.fn() }),
}));

let n = 0;
function agent(status: ThreadStatus): ThreadSummary {
  n += 1;
  return {
    id: `01999a4e-0002-7${String(n).padStart(3, "0")}-8a2e-${String(n).padStart(12, "0")}`,
    name: `Agent ${n}`,
    providerId: "claude-code",
    providerName: "Claude Code",
    model: null,
    effort: null,
    providerAccountId: null,
    accountLabel: null,
    workspaceId: "ws",
    workspaceName: "kalcode",
    permissionMode: "approve",
    status,
    currentActivity: null,
    createdAt: "2026-10-03T08:00:00Z",
    lastActivityAt: "2026-10-03T09:00:00Z",
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
  };
}

const every = () => (Object.keys(DISPLAY_STATUS_OF) as ThreadStatus[]).map(agent);
const statuses = (steps: ReturnType<typeof cleanupSteps>) => steps.map((s) => s.thread.status);

describe("Fleet cleanup plans (only what the thread commands accept)", () => {
  it("Clear failed and Clear finished archive exactly those agents", () => {
    const all = every();
    expect(statuses(cleanupSteps(all, "failed"))).toEqual(["failed"]);
    // Finished as KalTidy clears it: done, stopped or offline.
    expect(statuses(cleanupSteps(all, "finished")).sort()).toEqual(["completed", "interrupted", "offline"]);
    for (const step of [...cleanupSteps(all, "failed"), ...cleanupSteps(all, "finished")]) {
      expect(step.commands).toEqual(["archive"]);
    }
  });

  it("Close idle closes agents idle at their prompt, never a paused or blocked one mid-turn", () => {
    expect(statuses(cleanupSteps(every(), "idle"))).toEqual(["idle"]);
  });

  it("Close all stops running agents before archiving them and archives quiet ones directly", () => {
    const steps = cleanupSteps(every(), "all");
    expect(steps).toHaveLength(18);
    const byStatus = new Map(steps.map((s) => [s.thread.status, s.commands]));
    expect(byStatus.get("running_command")).toEqual(["stop", "archive"]);
    expect(byStatus.get("waiting_for_permission")).toEqual(["stop", "archive"]);
    expect(byStatus.get("paused")).toEqual(["stop", "archive"]);
    expect(byStatus.get("waiting_for_user")).toEqual(["archive"]);
    expect(byStatus.get("idle")).toEqual(["archive"]);
    expect(byStatus.get("failed")).toEqual(["archive"]);
  });

  it("counts each cleanup for the menu", () => {
    expect(cleanupCounts([agent("failed"), agent("failed"), agent("completed"), agent("editing")])).toEqual({
      failed: 2,
      finished: 1,
      idle: 0,
      all: 4,
    });
  });

  it("offers the card's X only for failed, finished, stopped or offline agents", () => {
    const dismissable = (Object.keys(DISPLAY_STATUS_OF) as ThreadStatus[]).filter(canDismiss).sort();
    expect(dismissable).toEqual(["completed", "failed", "interrupted", "offline"]);
  });

  it("says what happened in one sentence", () => {
    expect(cleanupSummary("failed", { done: 120, failed: 0 })).toBe("Cleared 120 failed agents.");
    expect(cleanupSummary("finished", { done: 1, failed: 0 })).toBe("Cleared 1 finished agent.");
    expect(cleanupSummary("idle", { done: 3, failed: 1 })).toBe("Closed 3 idle agents. 1 agent couldn't be closed.");
    expect(cleanupSummary("all", { done: 0, failed: 2 })).toBe("Nothing was closed. 2 agents couldn't be closed.");
  });
});

describe("KalTidy is the one cleanup tool", () => {
  it("uses KalTidy's canonical removal when this build's KalTidy offers it", async () => {
    const failed = agent("failed");
    data.threads = [failed, agent("editing")];
    const api = {
      openReview: vi.fn(),
      stopIdle: vi.fn(),
      dismissAgent: vi.fn(async () => true),
      clearFailed: vi.fn(async () => ({ cleared: 0, failed: 0, summary: "" })),
      clearFinished: vi.fn(async () => ({ cleared: 0, failed: 0, summary: "" })),
      closeAll: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ToastProvider>
        <KalTidyContext.Provider value={api}>{children}</KalTidyContext.Provider>
      </ToastProvider>
    );
    const { result } = renderHook(() => useAgentCleanup(), { wrapper });
    expect(result.current.canonical).toBe(true);
    await act(() => result.current.dismissAgent(failed.id));
    await act(() => result.current.clearFailed());
    await act(() => result.current.closeAll());
    expect(api.dismissAgent).toHaveBeenCalledWith(failed.id);
    expect(api.clearFailed).toHaveBeenCalledOnce();
    expect(api.closeAll).toHaveBeenCalledOnce();
    expect(data.runBulk).not.toHaveBeenCalled();
  });

  it("falls back to the same thread commands without it", async () => {
    const failed = agent("failed");
    data.threads = [failed];
    data.runBulk.mockResolvedValue({ done: [], failed: 0 });
    const wrapper = ({ children }: { children: ReactNode }) => <ToastProvider>{children}</ToastProvider>;
    const { result } = renderHook(() => useAgentCleanup(), { wrapper });
    expect(result.current.canonical).toBe(false);
    await act(() => result.current.clearFailed());
    expect(data.runBulk).toHaveBeenCalledWith([{ thread: failed, commands: ["archive"] }]);
  });
});
