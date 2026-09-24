import { describe, expect, it } from "vitest";
import { formatInterval, formatPrice, getPlan, PLANS } from "./plans.ts";

describe("plans", () => {
  it("defines exactly Free, Pro and MAX in ascending price order", () => {
    expect(PLANS.map((plan) => plan.id)).toEqual(["free", "pro", "max"]);
    expect(PLANS.map((plan) => plan.name)).toEqual(["Free", "Pro", "MAX"]);
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

  it("never paywalls provider connections", () => {
    for (const plan of PLANS) {
      expect(plan.entitlements.providerConnections).toBe("unlimited");
    }
  });

  it("increases concurrency with each tier", () => {
    const [free, pro, max] = PLANS.map((plan) => plan.entitlements.concurrentThreads);
    expect(free).toBeLessThan(pro ?? 0);
    expect(pro).toBeLessThan(max ?? 0);
  });

  it("rejects unknown plan ids", () => {
    // @ts-expect-error — deliberately invalid id
    expect(() => getPlan("enterprise")).toThrow(/Unknown plan/);
  });
});
