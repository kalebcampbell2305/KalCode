import { describe, expect, it, vi } from "vitest";
import { focusAttentionOperation, type OperationAttentionAction, operationFocusTarget } from "./actions.ts";

function action(patch: Partial<OperationAttentionAction> = {}): OperationAttentionAction {
  return {
    id: "open-operation",
    label: "Open run",
    operationId: "op-release",
    operationName: "Release desktop",
    workspaceId: "workspace-kalcode",
    tab: "runs",
    ...patch,
  };
}

describe("Operations attention actions", () => {
  it("uses the exact canonical run or queue target", () => {
    expect(operationFocusTarget(action())).toEqual({
      kind: "run",
      tab: "runs",
      runId: "op-release",
      workspaceId: "workspace-kalcode",
      label: "Release desktop",
    });
    expect(operationFocusTarget(action({ tab: "queue", label: "Open queue" }))).toEqual({
      kind: "queue",
      tab: "queue",
      runId: "op-release",
      workspaceId: "workspace-kalcode",
      label: "Release desktop",
    });
  });

  it("opens Operations before focusing, and reports stale recovery truthfully", async () => {
    const order: string[] = [];
    const navigate = vi.fn(() => order.push("navigate"));
    const focus = vi.fn(async () => {
      order.push("focus");
      return false;
    });
    await expect(focusAttentionOperation(action(), navigate, focus)).resolves.toEqual({
      ok: false,
      message: "Operations opened, but that work is no longer visible.",
    });
    expect(order).toEqual(["navigate", "focus"]);
    expect(navigate).toHaveBeenCalledWith("operations");
    expect(focus).toHaveBeenCalledWith(operationFocusTarget(action()));
  });

  it("confirms the exact queued work was focused", async () => {
    const navigate = vi.fn();
    const focus = vi.fn(async () => true);
    await expect(
      focusAttentionOperation(action({ tab: "queue", label: "Open queue" }), navigate, focus),
    ).resolves.toEqual({ ok: true, message: "Opened the queued work." });
  });
});
