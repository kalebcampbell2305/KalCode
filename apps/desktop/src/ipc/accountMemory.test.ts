import { describe, expect, it } from "vitest";
import type { AccountSnapshot, RuntimeStatus } from "./account.ts";
import { createAccountMemory } from "./accountMemory.ts";

describe("deterministic account memory adapter", () => {
  it("models social pending and cancellation without opening a real browser", async () => {
    const memory = createAccountMemory("fresh");
    expect(await memory.handlers.account_social_start({ provider: "google" })).toMatchObject({
      phase: "social_pending",
      pendingEmail: null,
    });
    expect(await memory.handlers.runtime_status()).toEqual({ phase: "signed_out", ready: false });
    expect(await memory.handlers.account_auth_cancel()).toMatchObject({ phase: "signed_out", pendingExpiresAt: null });
    await expect(memory.handlers.account_social_start({ provider: "unknown" })).rejects.toThrow();
    expect(memory.effects).toEqual({ emails: 0, checkouts: 0, browserOpens: 0 });
  });
  it("runs email verification and Free activation without external effects", async () => {
    const memory = createAccountMemory("fresh");
    expect((await memory.handlers.account_status()) as AccountSnapshot).toMatchObject({ phase: "signed_out" });
    expect(
      (await memory.handlers.account_email_start({ email: "owner@example.com" })) as AccountSnapshot,
    ).toMatchObject({ phase: "email_pending" });
    expect((await memory.handlers.account_email_poll()) as AccountSnapshot).toMatchObject({
      phase: "authenticated_unactivated",
    });
    expect((await memory.handlers.account_activate_free()) as AccountSnapshot).toMatchObject({
      phase: "ready",
      tier: "free",
    });
    expect(await memory.handlers.runtime_status()).toEqual({ phase: "ready", ready: true } satisfies RuntimeStatus);
    expect(memory.effects).toEqual({ emails: 0, checkouts: 0, browserOpens: 0 });
  });

  it("does not unlock paid access until the deterministic refresh", async () => {
    const memory = createAccountMemory("unactivated");
    expect((await memory.handlers.account_checkout({ tier: "max2x" })) as AccountSnapshot).toMatchObject({
      phase: "confirming_plan",
      tier: null,
    });
    expect((await memory.handlers.account_refresh()) as AccountSnapshot).toMatchObject({
      phase: "ready",
      tier: "max2x",
    });
    expect(memory.effects).toEqual({ emails: 0, checkouts: 0, browserOpens: 0 });
  });

  it("keeps every fixture free of credential-shaped fields", async () => {
    for (const scenario of ["fresh", "unactivated", "ready", "ready_pro", "expired", "offline_grace"] as const) {
      expect(JSON.stringify(await createAccountMemory(scenario).handlers.account_status())).not.toMatch(
        /token|secret|verifier|receipt|credential/i,
      );
    }
  });
});
