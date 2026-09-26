import { describe, expect, it, vi } from "vitest";
import {
  AccountClient,
  type AccountCommandName,
  type AccountTransport,
  PLAN_CATALOG,
  parseAccountSnapshot,
  parseRuntimeStatus,
} from "./account.ts";

const signedOut = {
  phase: "signed_out",
  account: null,
  tier: null,
  sessionExpiresAt: null,
  entitlementExpiresAt: null,
  offlineGraceUntil: null,
  pendingEmail: null,
  pendingExpiresAt: null,
  degradedReason: null,
} as const;

const ready = {
  phase: "ready",
  account: { id: "acct_01", email: "owner@example.com", activatedAt: "2026-09-25T12:00:00Z" },
  tier: "max2x",
  sessionExpiresAt: "2026-10-25T12:00:00Z",
  entitlementExpiresAt: 1_800_000_000,
  offlineGraceUntil: null,
  pendingEmail: null,
  pendingExpiresAt: null,
  degradedReason: null,
} as const;

describe("account IPC validation", () => {
  it("accepts a social attempt without exposing secrets or email authority", () => {
    const pending = { ...signedOut, phase: "social_pending", pendingExpiresAt: "2026-09-25T12:10:00Z" };
    expect(parseAccountSnapshot(pending)).toEqual(pending);
    expect(() => parseAccountSnapshot({ ...pending, pendingExpiresAt: null })).toThrow();
    expect(() => parseAccountSnapshot({ ...pending, pendingEmail: "owner@example.com" })).toThrow();
    expect(() => parseAccountSnapshot({ ...pending, account: ready.account })).toThrow();
  });
  it("accepts complete account and runtime truth without deriving local authority", () => {
    expect(parseAccountSnapshot(ready)).toEqual(ready);
    expect(parseRuntimeStatus({ phase: "ready", ready: true })).toEqual({ phase: "ready", ready: true });
    expect(parseRuntimeStatus({ phase: "blocked_unclean", ready: false })).toEqual({
      phase: "blocked_unclean",
      ready: false,
    });
  });

  it("rejects inconsistent runtime readiness and secret-bearing account responses", () => {
    expect(() => parseRuntimeStatus({ phase: "starting", ready: true })).toThrow(/readiness/i);
    expect(() => parseRuntimeStatus({ phase: "ready", ready: false })).toThrow(/readiness/i);
    expect(() => parseAccountSnapshot({ ...signedOut, accessToken: "private" })).toThrow(/secret/i);
    expect(() => parseAccountSnapshot({ ...ready, account: { ...ready.account, codeVerifier: "private" } })).toThrow(
      /secret/i,
    );
  });

  it("rejects internally inconsistent authority states", () => {
    expect(() => parseAccountSnapshot({ ...ready, phase: "signed_out" })).toThrow(/signed_out/i);
    expect(() => parseAccountSnapshot({ ...signedOut, phase: "ready" })).toThrow(/ready/i);
    expect(() => parseAccountSnapshot({ ...ready, tier: "enterprise" })).toThrow(/tier/i);
  });
});

describe("AccountClient", () => {
  it("starts social sign-in with only the provider name", async () => {
    const invoke = vi.fn(async () => ({
      ...signedOut,
      phase: "social_pending",
      pendingExpiresAt: "2026-09-25T12:10:00Z",
    }));
    const client = new AccountClient({ invoke });
    await client.startSocial("google");
    expect(invoke).toHaveBeenCalledWith("account_social_start", { provider: "google" });
  });
  it("sends only public arguments and parses account and runtime responses", async () => {
    const calls: Array<{ command: AccountCommandName; args?: Record<string, unknown> }> = [];
    const transport: AccountTransport = {
      invoke: vi.fn(async (command, args) => {
        calls.push({ command, args });
        if (command === "runtime_status") return { phase: "signed_out", ready: false };
        return command === "account_email_start"
          ? {
              ...signedOut,
              phase: "email_pending",
              pendingEmail: "owner@example.com",
              pendingExpiresAt: "2026-09-25T12:10:00Z",
            }
          : signedOut;
      }),
    };
    const client = new AccountClient(transport);

    await client.status();
    await client.runtimeStatus();
    await client.startEmail("owner@example.com");
    await client.pollEmail();
    await client.cancelAuth();
    await client.logout();

    expect(calls).toEqual([
      { command: "account_status", args: undefined },
      { command: "runtime_status", args: undefined },
      { command: "account_email_start", args: { email: "owner@example.com" } },
      { command: "account_email_poll", args: undefined },
      { command: "account_auth_cancel", args: undefined },
      { command: "account_logout", args: undefined },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/token|verifier/i);
  });

  it("keeps the published plan catalog exact and Free outside checkout", () => {
    expect(PLAN_CATALOG).toEqual([
      { tier: "free", name: "Free", requests: 75, monthlyPriceUsd: 0, action: "activate_free" },
      { tier: "pro", name: "Pro", requests: 1500, monthlyPriceUsd: 10, action: "checkout" },
      { tier: "max", name: "Max", requests: 5000, monthlyPriceUsd: 25, action: "checkout" },
      { tier: "max2x", name: "Max 2X", requests: 10000, monthlyPriceUsd: 50, action: "checkout" },
    ]);
  });
});
