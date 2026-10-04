import { describe, expect, it, vi } from "vitest";
import {
  AccountClient,
  type AccountCommandName,
  type AccountTransport,
  PLAN_CATALOG,
  parseAccountSnapshot,
  parseAccountUsage,
  parseRuntimeStatus,
  tierName,
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
  account: { id: "acct_01", email: "owner@example.com", activatedAt: "2026-09-25T12:00:00Z", displayName: null },
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

  it("preserves public recovery reasons and rejects secret-bearing or inconsistent recovery", () => {
    const recovery = {
      code: "workspace_owned",
      message: "Close the other KalCode instance, then try again.",
      retryable: true,
    };
    expect(parseRuntimeStatus({ phase: "blocked_unclean", ready: false, recovery }).recovery).toEqual(recovery);
    expect(() => parseRuntimeStatus({ phase: "ready", ready: true, recovery })).toThrow(/recovery/i);
    expect(() =>
      parseRuntimeStatus({ phase: "blocked_unclean", ready: false, recovery: { ...recovery, token: "private" } }),
    ).toThrow(/secret/i);
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

  it("sends monthly checkout exactly as before and adds only the yearly interval", async () => {
    const calls: Array<{ command: AccountCommandName; args?: Record<string, unknown> }> = [];
    const confirming = {
      ...signedOut,
      phase: "confirming_plan",
      account: { id: "acct_01", email: "owner@example.com", activatedAt: null, displayName: null },
    };
    const client = new AccountClient({
      invoke: vi.fn(async (command, args) => {
        calls.push({ command, args });
        return confirming;
      }),
    });

    await client.checkout("pro");
    await client.checkout("max", "month");
    await client.checkout("max2x", "year");
    await expect(client.checkout("pro", "week" as never)).rejects.toThrow("Choose monthly or yearly billing.");

    expect(calls).toEqual([
      { command: "account_checkout", args: { tier: "pro" } },
      { command: "account_checkout", args: { tier: "max" } },
      { command: "account_checkout", args: { tier: "max2x", interval: "year" } },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/price/i);
  });

  it("derives the plan catalog from the canonical protocol plans", () => {
    expect(
      PLAN_CATALOG.map(({ tier, name, requests, monthlyPriceUsd, yearlyPriceUsd, yearlySavingsUsd }) => ({
        tier,
        name,
        requests,
        monthlyPriceUsd,
        yearlyPriceUsd,
        yearlySavingsUsd,
      })),
    ).toEqual([
      { tier: "free", name: "Free", requests: 25, monthlyPriceUsd: 0, yearlyPriceUsd: 0, yearlySavingsUsd: 0 },
      { tier: "pro", name: "Pro", requests: 150, monthlyPriceUsd: 10, yearlyPriceUsd: 100, yearlySavingsUsd: 20 },
      { tier: "max", name: "MAX", requests: 500, monthlyPriceUsd: 25, yearlyPriceUsd: 250, yearlySavingsUsd: 50 },
      {
        tier: "max2x",
        name: "MAX 2X",
        requests: 1000,
        monthlyPriceUsd: 50,
        yearlyPriceUsd: 500,
        yearlySavingsUsd: 100,
      },
    ]);
    expect(PLAN_CATALOG.filter((plan) => plan.popular).map((plan) => plan.tier)).toEqual(["max"]);
    expect(tierName("max2x")).toBe("MAX 2X");
    expect(tierName("owner")).toBe("Owner");
  });
});

describe("account display name", () => {
  it("reads the synced name, and treats a native build without one as unnamed", () => {
    const named = { ...ready, account: { ...ready.account, displayName: "Kaleb" } };
    expect(parseAccountSnapshot(named).account?.displayName).toBe("Kaleb");
    const { displayName: _omitted, ...legacy } = ready.account;
    expect(parseAccountSnapshot({ ...ready, account: legacy }).account?.displayName).toBeNull();
    expect(() => parseAccountSnapshot({ ...ready, account: { ...ready.account, displayName: "" } })).toThrow();
    expect(() =>
      parseAccountSnapshot({ ...ready, account: { ...ready.account, displayName: "x".repeat(65) } }),
    ).toThrow();
  });

  it("sends only the name to native and returns the updated account", async () => {
    const calls: Array<{ command: AccountCommandName; args?: Record<string, unknown> }> = [];
    const client = new AccountClient({
      invoke: vi.fn(async (command, args) => {
        calls.push({ command, args });
        return { ...ready, account: { ...ready.account, displayName: (args?.displayName as string | null) ?? null } };
      }),
    });
    expect((await client.setDisplayName("Kaleb")).account?.displayName).toBe("Kaleb");
    expect((await client.setDisplayName(null)).account?.displayName).toBeNull();
    expect(calls).toEqual([
      { command: "account_set_display_name", args: { displayName: "Kaleb" } },
      { command: "account_set_display_name", args: { displayName: null } },
    ]);
  });
});

describe("verified billing interval", () => {
  it("reads the actual interval without assuming monthly for older builds", () => {
    expect(parseAccountSnapshot({ ...ready, billingInterval: "year" }).billingInterval).toBe("year");
    expect(parseAccountSnapshot({ ...ready, billingInterval: "month" }).billingInterval).toBe("month");
    expect(parseAccountSnapshot({ ...ready, billingInterval: null }).billingInterval).toBeNull();
    expect(parseAccountSnapshot(ready).billingInterval).toBeUndefined();
    expect(() => parseAccountSnapshot({ ...ready, billingInterval: "week" })).toThrow(
      "Invalid native billing interval",
    );
  });
});

it("reads optional billing metadata with usage and rejects invalid intervals", () => {
  const usage = { used: 1, allowance: 150, periodStart: "2026-10-01T00:00:00Z", resetsAt: "2026-11-01T00:00:00Z" };
  expect(parseAccountUsage({ ...usage, billingInterval: "year" }).billingInterval).toBe("year");
  expect(parseAccountUsage(usage).billingInterval).toBeUndefined();
  expect(() => parseAccountUsage({ ...usage, billingInterval: "week" })).toThrow("Invalid native billing interval");
});
