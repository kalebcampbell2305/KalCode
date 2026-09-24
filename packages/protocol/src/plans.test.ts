import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSION_MODES,
  formatInterval,
  formatKalVoiceAllowance,
  formatPrice,
  getPlan,
  limitsFor,
  OWNER_LIMITS,
  PLANS,
} from "./plans.ts";

describe("plans", () => {
  it("publicly lists exactly Free, Pro and MAX in ascending price order (never OWNER)", () => {
    expect(PLANS.map((plan) => plan.id)).toEqual(["free", "pro", "max"]);
    expect(PLANS.map((plan) => plan.name)).toEqual(["Free", "Pro", "MAX"]);
    expect(JSON.stringify(PLANS).toLowerCase()).not.toContain("owner");
  });

  it("uses the launch prices", () => {
    expect(getPlan("free").price).toEqual({ amountUsd: 0, interval: "month" });
    expect(getPlan("pro").price).toEqual({ amountUsd: 10, interval: "month" });
    expect(getPlan("max").price).toEqual({ amountUsd: 25, interval: "month" });
  });

  it("formats prices as whole dollars per month", () => {
    expect(formatPrice(getPlan("pro").price)).toBe("$10");
    expect(formatInterval(getPlan("max").price)).toBe("/month");
  });

  it("gives Free 250, Pro 2,500, MAX 10,000 KalVoice Requests and OWNER unlimited", () => {
    expect(limitsFor("free").kalvoiceRequestsPerMonth).toBe(250);
    expect(limitsFor("pro").kalvoiceRequestsPerMonth).toBe(2500);
    expect(limitsFor("max").kalvoiceRequestsPerMonth).toBe(10000);
    expect(limitsFor("owner").kalvoiceRequestsPerMonth).toBeNull();
    expect(formatKalVoiceAllowance(limitsFor("pro"))).toBe("2,500");
    expect(formatKalVoiceAllowance(OWNER_LIMITS)).toBe("Unlimited");
  });

  it("never paywalls dictation, provider connections or any permission mode", () => {
    for (const tier of ["free", "pro", "max", "owner"] as const) {
      const limits = limitsFor(tier);
      expect(limits.kalvoiceDictation).toBe("unlimited");
      expect(limits.providerConnections).toBe("unlimited");
      expect([...limits.permissionModes]).toEqual(["plan", "approve", "auto", "bypass", "custom"]);
    }
    expect(ALL_PERMISSION_MODES).toHaveLength(5);
  });

  it("increases concurrency with each tier; OWNER is unrestricted", () => {
    const [free, pro, max] = PLANS.map((plan) => plan.limits.concurrentThreads ?? Number.POSITIVE_INFINITY);
    expect(free).toBeLessThan(pro ?? 0);
    expect(pro).toBeLessThan(max ?? 0);
    expect(OWNER_LIMITS.concurrentThreads).toBeNull();
    expect(OWNER_LIMITS.advancedMissions).toBe(true);
  });

  it("never describes model tokens as KalVoice usage", () => {
    expect(JSON.stringify(PLANS).toLowerCase()).not.toMatch(/\btokens?\b/);
  });

  it("never lists the private owner entitlement (it is not purchasable)", () => {
    const catalog = JSON.stringify(PLANS).toLowerCase();
    expect(catalog).not.toContain("owner");
    expect(catalog).not.toContain("unrestricted");
  });

  it("rejects unknown plan ids", () => {
    // @ts-expect-error — deliberately invalid id
    expect(() => getPlan("enterprise")).toThrow(/Unknown plan/);
  });
});
