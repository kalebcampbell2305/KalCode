import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { thread } from "../dashboard/data/testing.ts";
import { agentAttention, useAgentAttention } from "./useAgentAttention.ts";

const agent = thread({ runtimeKind: "interactive_pty", status: "editing" });

describe("agent attention", () => {
  it("uses coding-agent lifecycle facts and the same waiting conditions as Needs You", () => {
    expect(agentAttention({ ...agent, status: "completed" })).toBe("completed");
    expect(agentAttention({ ...agent, status: "waiting_for_user" })).toBe("needs-you");
    expect(agentAttention({ ...agent, status: "waiting_for_permission" })).toBe("needs-you");
    expect(agentAttention({ ...agent, pendingApprovals: 1 })).toBe("needs-you");
    expect(agentAttention({ ...agent, status: "failed" })).toBeNull();
    expect(agentAttention({ ...agent, status: "idle" })).toBeNull();
    expect(agentAttention({ ...agent, status: "completed", runtimeKind: "headless" })).toBeNull();
    expect(agentAttention({ ...agent, status: "completed", runtimeKind: null, terminalId: "legacy" })).toBeNull();
    expect(agentAttention({ ...agent, status: "completed", archivedAt: "2026-10-04" })).toBeNull();
  });

  it("keeps a result discoverable until visited and never repeats it for output updates", () => {
    const { result, rerender } = renderHook(({ threads }: { threads: ThreadSummary[] }) => useAgentAttention(threads), {
      initialProps: { threads: [agent] },
    });
    expect(result.current.pending.size).toBe(0);
    rerender({ threads: [{ ...agent, status: "completed" }] });
    expect(result.current.pending.get(agent.id)).toBe("completed");
    act(() => result.current.acknowledge(agent.id));
    expect(result.current.pending.size).toBe(0);
    rerender({ threads: [{ ...agent, status: "completed", lastActivityAt: "2026-10-04T11:00:00Z" }] });
    expect(result.current.pending.size).toBe(0);
    rerender({ threads: [agent] });
    rerender({ threads: [{ ...agent, status: "completed" }] });
    expect(result.current.pending.get(agent.id)).toBe("completed");
  });

  it("surfaces simultaneous results independently and clears archived and removed agents", () => {
    const other = { ...agent, id: "other", status: "waiting_for_user" as const };
    const { result, rerender } = renderHook(({ threads }: { threads: ThreadSummary[] }) => useAgentAttention(threads), {
      initialProps: { threads: [{ ...agent, status: "completed" }, other] },
    });
    expect(result.current.pending.size).toBe(2);
    act(() => result.current.acknowledge(agent.id));
    expect([...result.current.pending.keys()]).toEqual([other.id]);
    rerender({ threads: [{ ...other, archivedAt: "2026-10-04" }] });
    expect(result.current.pending.size).toBe(0);
  });
});

import type { ThreadSummary } from "@kalcode/protocol";
