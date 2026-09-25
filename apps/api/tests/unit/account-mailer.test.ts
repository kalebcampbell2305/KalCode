import { describe, expect, it, vi } from "vitest";
import { serviceBoundAccountMailer } from "../../worker/lib/account-mailer";

describe("account email service binding", () => {
  const identity = { networkHash: "n".repeat(43), recipientHash: "r".repeat(43) };

  it("passes only bounded recipient, purpose, proof and opaque admission buckets to the internal RPC", async () => {
    const sendAccountEmail = vi.fn(async () => ({ outcome: "sent" as const }));
    const mailer = serviceBoundAccountMailer({ sendAccountEmail });
    const proof = "p".repeat(43);

    await expect(mailer.sendSignIn("person@example.com", proof, identity)).resolves.toBe(true);
    await expect(mailer.sendDelete("person@example.com", proof, identity)).resolves.toBe(true);
    expect(sendAccountEmail).toHaveBeenNthCalledWith(1, {
      purpose: "signin",
      recipient: "person@example.com",
      oneTimeProof: proof,
      ...identity,
    });
    expect(sendAccountEmail).toHaveBeenNthCalledWith(2, {
      purpose: "delete",
      recipient: "person@example.com",
      oneTimeProof: proof,
      ...identity,
    });
  });

  it("preserves a possibly delivered proof on ambiguous transport failures", async () => {
    const sendAccountEmail = vi.fn(async () => ({ outcome: "ambiguous" as const }));
    const mailer = serviceBoundAccountMailer({ sendAccountEmail });
    await expect(mailer.sendSignIn("person@example.com", "p".repeat(43), identity)).resolves.toBe(true);
  });

  it.each(["invalid", "rejected", "budget_exhausted"] as const)("fails closed for %s", async (outcome) => {
    const mailer = serviceBoundAccountMailer({ sendAccountEmail: vi.fn(async () => ({ outcome })) });
    await expect(mailer.sendSignIn("person@example.com", "p".repeat(43), identity)).resolves.toBe(false);
  });

  it("preserves the proof when the RPC disconnects after an unknown delivery point", async () => {
    const mailer = serviceBoundAccountMailer({
      sendAccountEmail: vi.fn(async () => {
        throw new Error("service unavailable");
      }),
    });
    await expect(mailer.sendSignIn("person@example.com", "p".repeat(43), identity)).resolves.toBe(true);
  });
});
