import { describe, expect, it } from "vitest";
import { parseUsageReceipt, USAGE_RECEIPT_MAX_LIFETIME_SECONDS, USAGE_RECEIPT_TTL_SECONDS } from "./usage-receipts.ts";

const T0 = 1_790_000_000;

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    accountId: "0b6f1c1e-5a39-4d0c-9a0f-2b1f7d9e4c11",
    tier: "pro",
    used: 41,
    allowance: 150,
    periodStart: "2026-09-10T08:00:00.000Z",
    resetsAt: "2026-10-10T08:00:00.000Z",
    issuedAt: T0,
    expiresAt: T0 + USAGE_RECEIPT_TTL_SECONDS,
    keyId: "k2026-10",
    ...overrides,
  };
}

describe("parseUsageReceipt", () => {
  it("accepts receipts for restricted tiers and unlimited OWNER receipts", () => {
    expect(parseUsageReceipt(receipt()).ok).toBe(true);
    expect(parseUsageReceipt(receipt({ tier: "max2x", allowance: 1_000 })).ok).toBe(true);
    expect(parseUsageReceipt(receipt({ tier: "owner", allowance: null, used: 99_999 })).ok).toBe(true);
    expect(parseUsageReceipt({ ...receipt(), addedLater: 1 }).ok).toBe(true);
  });

  it.each([
    ["an OWNER receipt with a number", receipt({ tier: "owner", allowance: 10 })],
    ["negative usage", receipt({ used: -1 })],
    ["fractional allowance", receipt({ allowance: 2.5 })],
    ["a cycle that ends before it starts", receipt({ resetsAt: "2026-09-10T08:00:00.000Z" })],
    ["a non-ISO timestamp", receipt({ periodStart: "2026-09-10" })],
    ["an over-long lifetime", receipt({ expiresAt: T0 + USAGE_RECEIPT_MAX_LIFETIME_SECONDS + 1 })],
    ["an unknown tier", receipt({ tier: "enterprise" })],
    ["a bad key id", receipt({ keyId: "K" })],
    ["another version", receipt({ version: 2 })],
  ])("rejects %s", (_name, value) => {
    expect(parseUsageReceipt(value).ok).toBe(false);
  });
});
