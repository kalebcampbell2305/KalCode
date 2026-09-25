import { describe, expect, it, vi } from "vitest";
import {
  type AccountMailDispatchStore,
  type AccountMailRpcRequest,
  sendAccountEmail,
} from "../../worker/lib/account-mail-service";
import type { Mailer, SendResult } from "../../worker/lib/mailer";
import { hashToken } from "../../worker/lib/tokens";

const PROOF = "p".repeat(43);
const NETWORK_HASH = "n".repeat(43);
const RECIPIENT_HASH = "r".repeat(43);
const NOW = new Date("2026-09-25T12:00:00.000Z");

function harness(
  options: { existing?: "claimed" | "sent" | "ambiguous" | "rejected"; send?: SendResult; budget?: boolean } = {},
) {
  const finalize = vi.fn(async () => undefined);
  const claim = vi.fn(async () => {
    if (options.existing) return { kind: "existing" as const, state: options.existing };
    return options.budget === false ? ({ kind: "budget_exhausted" } as const) : ({ kind: "claimed" } as const);
  });
  const store: AccountMailDispatchStore = { claim, finalize };
  const send = vi.fn(async () => options.send ?? ({ ok: true } as const));
  const mailer: Mailer = { transport: "resend", send };
  const logs: Record<string, string>[] = [];
  return {
    deps: {
      store,
      mailer,
      now: () => NOW,
      dailyEmailLimit: 90,
      log: (entry: Record<string, string>) => logs.push(entry),
    },
    claim,
    finalize,
    send,
    logs,
  };
}

function request(overrides: Partial<AccountMailRpcRequest> = {}): AccountMailRpcRequest {
  return {
    purpose: "signin",
    recipient: "person@example.com",
    oneTimeProof: PROOF,
    networkHash: NETWORK_HASH,
    recipientHash: RECIPIENT_HASH,
    ...overrides,
  };
}

describe("account mail service binding", () => {
  it.each([
    null,
    {},
    { purpose: "reset", recipient: "person@example.com", oneTimeProof: PROOF },
    { purpose: "signin", recipient: "Person@example.com", oneTimeProof: PROOF },
    { purpose: "signin", recipient: "person@example.com", oneTimeProof: "short" },
    { purpose: "signin", recipient: "person@example.com", oneTimeProof: PROOF, body: "arbitrary" },
    { purpose: "signin", recipient: "person@example.com", oneTimeProof: PROOF, networkHash: "raw-ip" },
  ])("rejects malformed or extensible RPC input without claiming or sending: %j", async (input) => {
    const h = harness();
    await expect(sendAccountEmail(input, h.deps)).resolves.toEqual({ outcome: "invalid" });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("renders the fixed sign-in template and uses a proof-derived idempotency key", async () => {
    const h = harness();
    await expect(sendAccountEmail(request(), h.deps)).resolves.toEqual({ outcome: "sent" });
    const proofHash = await hashToken(PROOF);
    expect(h.claim).toHaveBeenCalledWith({
      proofHash,
      purpose: "signin",
      networkHash: NETWORK_HASH,
      recipientHash: RECIPIENT_HASH,
      now: NOW,
      dailyLimit: 90,
    });
    expect(h.send).toHaveBeenCalledTimes(1);
    const message = h.send.mock.calls[0]?.[0];
    expect(message?.to).toBe("person@example.com");
    expect(message?.subject).toBe("Sign in to KalCode");
    expect(message?.text).toContain(`https://kalcoded.com/account#verify=${PROOF}`);
    expect(message?.html).toContain(`https://kalcoded.com/account#verify=${PROOF}`);
    expect(message?.text).not.toContain("account?verify=");
    expect(message?.idempotencyKey).toBe(`account-signin-${proofHash.slice(0, 32)}`);
    expect(h.finalize).toHaveBeenCalledWith(proofHash, "sent", NOW);
  });

  it("uses a fixed deletion template", async () => {
    const h = harness();
    await expect(sendAccountEmail(request({ purpose: "delete" }), h.deps)).resolves.toEqual({ outcome: "sent" });
    const message = h.send.mock.calls[0]?.[0];
    expect(message?.subject).toBe("Confirm deletion of your KalCode account");
    expect(message?.text).toContain("delete your account from KalCode");
    expect(message?.html).toContain("Confirm account deletion");
  });

  it("never replays an existing proof or spends beyond the shared daily budget", async () => {
    for (const [existing, outcome] of [
      ["claimed", "ambiguous"],
      ["sent", "sent"],
      ["ambiguous", "ambiguous"],
      ["rejected", "rejected"],
    ] as const) {
      const h = harness({ existing });
      await expect(sendAccountEmail(request(), h.deps)).resolves.toEqual({ outcome });
      expect(h.send).not.toHaveBeenCalled();
    }
    const exhausted = harness({ budget: false });
    await expect(sendAccountEmail(request(), exhausted.deps)).resolves.toEqual({ outcome: "budget_exhausted" });
    expect(exhausted.send).not.toHaveBeenCalled();
  });

  it("retains ambiguous provider attempts but marks explicit rejections for a safe budget refund", async () => {
    for (const [sendResult, state, outcome] of [
      [{ ok: false, reason: "timeout" }, "ambiguous", "ambiguous"],
      [{ ok: false, reason: "network" }, "ambiguous", "ambiguous"],
      [{ ok: false, reason: "rejected", status: 422 }, "rejected", "rejected"],
      [{ ok: false, reason: "not_configured" }, "rejected", "rejected"],
    ] as const) {
      const h = harness({ send: sendResult });
      await expect(sendAccountEmail(request(), h.deps)).resolves.toEqual({ outcome });
      expect(h.finalize).toHaveBeenCalledWith(await hashToken(PROOF), state, NOW);
      expect(h.logs).toEqual([
        expect.objectContaining({ event: "account_email.dispatch", purpose: "signin", outcome }),
      ]);
      expect(JSON.stringify(h.logs)).not.toContain("person@example.com");
      expect(JSON.stringify(h.logs)).not.toContain(PROOF);
    }
  });
});
