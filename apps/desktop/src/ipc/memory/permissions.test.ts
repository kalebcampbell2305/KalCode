import type { ApprovalView, EventPayload, PermissionSettings } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { KalCodeClient } from "../client.ts";
import { KalCodeError } from "../errors.ts";
import { createMemoryTransport } from "../memoryTransport.ts";
import { ALL_SCOPES, BUILTIN_PROFILES, baseline, createPermissionMemory } from "./permissions.ts";

function memory(seed = true) {
  const events: EventPayload[] = [];
  const permissions = createPermissionMemory({ emit: (e) => events.push(e), requireCore: () => {}, seed });
  const call = <T>(command: keyof typeof permissions.handlers, args: Record<string, unknown> = {}) =>
    permissions.handlers[command](args) as T;
  return { events, permissions, call };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error("expected a failure");
}

describe("in-memory permission commands", () => {
  it("starts fresh installs in Bypass without weakening explicit later choices", () => {
    const { call } = memory(false);
    expect(call<PermissionSettings>("permission_settings_get").defaultMode).toBe("bypass");
    expect(call<PermissionSettings>("permission_settings_update", { defaultMode: "approve" }).defaultMode).toBe(
      "approve",
    );
  });

  it("seeds pending approvals and announces them", () => {
    const { events, call } = memory();
    const pending = call<ApprovalView[]>("approval_list", { status: "pending" });
    expect(pending).toHaveLength(4);
    expect(events.filter((e) => e.type === "approval.requested")).toHaveLength(4);
  });

  it("only answers pending requests with an allowed decision", () => {
    const { call, events } = memory();
    const [newest, push] = call<ApprovalView[]>("approval_list", { status: "pending" }) as [ApprovalView, ApprovalView];
    expect(push.allowedDecisions).toEqual(["deny", "approve_once"]);
    expect(codeOf(() => call("approval_decide", { requestId: push.id, decision: "approve_for_thread" }))).toBe(
      "decision_not_allowed",
    );
    const approved = call<ApprovalView>("approval_decide", { requestId: newest.id, decision: "approve_once" });
    expect(approved.status).toBe("approved");
    expect(events.at(-1)?.type).toBe("approval.approved");
    expect(codeOf(() => call("approval_decide", { requestId: newest.id, decision: "deny" }))).toBe(
      "approval_already_decided",
    );
  });

  it("rejects malformed and unknown ids and decisions", () => {
    const { call } = memory();
    expect(codeOf(() => call("approval_decide", { requestId: "../x", decision: "deny" }))).toBe("invalid_id");
    expect(codeOf(() => call("approval_decide", { requestId: crypto.randomUUID(), decision: "deny" }))).toBe(
      "approval_not_found",
    );
    expect(codeOf(() => call("approval_decide", { requestId: crypto.randomUUID(), decision: "sure" }))).toBe(
      "ipc_rejected",
    );
  });

  it("needs no confirmation for Bypass but a profile for Custom", () => {
    const { call, events } = memory(false);
    call("permission_settings_update", { defaultMode: "auto" });
    expect(codeOf(() => call("permission_settings_update", { defaultMode: "custom" }))).toBe("profile_required");
    expect(
      codeOf(() => call("permission_settings_update", { defaultMode: "custom", profileId: "builtin.approve" })),
    ).toBe("profile_not_found");
    const settings = call<PermissionSettings>("permission_settings_update", { defaultMode: "bypass" });
    expect(settings.defaultMode).toBe("bypass");
    expect(events.at(-1)).toMatchObject({
      type: "permission.mode_changed",
      payload: { from: "auto", to: "bypass" },
    });
  });

  it("changing a thread's mode expires its pending requests", () => {
    const { call, events } = memory();
    const pending = call<ApprovalView[]>("approval_list", { status: "pending" });
    const target = pending[0] as ApprovalView;
    call("thread_set_permission_mode", { threadId: target.action.threadId, mode: "plan" });
    const after = call<ApprovalView[]>("approval_list", {});
    expect(after.find((v) => v.id === target.id)?.status).toBe("expired");
    expect(events.some((e) => e.type === "approval.expired")).toBe(true);
    expect(codeOf(() => call("thread_set_permission_mode", { threadId: crypto.randomUUID(), mode: "plan" }))).toBe(
      "thread_not_found",
    );
  });
});

describe("built-in profiles", () => {
  it("mode profiles mirror the baseline and cover every scope", () => {
    for (const profile of BUILTIN_PROFILES) {
      expect(profile.rules.map((r) => r.scope)).toEqual(ALL_SCOPES);
      if (profile.mode !== "custom")
        for (const rule of profile.rules) expect(rule.effect).toBe(baseline(profile.mode, rule.scope));
    }
  });

  it("no mode allows remote-consequential scopes without asking", () => {
    for (const mode of ["plan", "approve", "auto", "bypass", "custom"] as const)
      for (const scope of ["git.push", "deploy.production", "cloud.modify", "billing.spend", "messaging.send"] as const)
        expect(baseline(mode, scope)).not.toBe("allow");
  });
});

describe("client", () => {
  it("sends camelCase arguments and surfaces native error codes", async () => {
    const client = new KalCodeClient(createMemoryTransport("approvals"));
    const pending = await client.listApprovals("pending");
    expect(pending.length).toBeGreaterThan(0);
    const updated = await client.decideApproval((pending[0] as ApprovalView).id, "deny");
    expect(updated.status).toBe("denied");
    await expect(client.updatePermissionSettings("custom")).rejects.toBeInstanceOf(KalCodeError);
    await expect(client.updatePermissionSettings("custom")).rejects.toMatchObject({ code: "profile_required" });
    const settings = await client.updatePermissionSettings("bypass");
    expect(settings.defaultMode).toBe("bypass");
    expect((await client.listPermissionProfiles()).map((p) => p.name)).toContain("Code Reviewer");
  });
});
