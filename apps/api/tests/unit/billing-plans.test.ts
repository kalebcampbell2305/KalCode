import { describe, expect, it } from "vitest";
import { billingPriceCatalog } from "../../worker/lib/billing-plans";

describe("billing price catalog", () => {
  const configured = {
    STRIPE_PRICE_PRO: "price_pro_123",
    STRIPE_PRICE_MAX: "price_max_456",
    STRIPE_PRICE_MAX_2X: "price_max2x_789",
    STRIPE_PRICE_PRO_YEARLY: "price_pro_year_123",
    STRIPE_PRICE_MAX_YEARLY: "price_max_year_456",
    STRIPE_PRICE_MAX_2X_YEARLY: "price_max2x_year_789",
  };

  it("maps every monthly and yearly Stripe price to its public paid tier and never to Free or OWNER", () => {
    const catalog = billingPriceCatalog(configured);
    expect(catalog).toEqual({
      ok: true,
      priceFor: {
        pro: { month: "price_pro_123", year: "price_pro_year_123" },
        max: { month: "price_max_456", year: "price_max_year_456" },
        max2x: { month: "price_max2x_789", year: "price_max2x_year_789" },
      },
      tierForPrice: {
        price_pro_123: "pro",
        price_max_456: "max",
        price_max2x_789: "max2x",
        price_pro_year_123: "pro",
        price_max_year_456: "max",
        price_max2x_year_789: "max2x",
      },
      planForPrice: {
        price_pro_123: { tier: "pro", interval: "month" },
        price_max_456: { tier: "max", interval: "month" },
        price_max2x_789: { tier: "max2x", interval: "month" },
        price_pro_year_123: { tier: "pro", interval: "year" },
        price_max_year_456: { tier: "max", interval: "year" },
        price_max2x_year_789: { tier: "max2x", interval: "year" },
      },
    });
    if (catalog.ok) {
      expect(Object.keys(catalog.priceFor).sort()).toEqual(["max", "max2x", "pro"]);
      expect(Object.values(catalog.tierForPrice)).not.toContain("free");
      expect(Object.values(catalog.tierForPrice)).not.toContain("owner");
    }
  });

  const { STRIPE_PRICE_MAX_2X: _monthly, ...missingMonthly } = configured;
  const { STRIPE_PRICE_MAX_YEARLY: _yearly, ...missingYearly } = configured;

  it.each([
    ["missing monthly", missingMonthly],
    ["missing yearly", missingYearly],
    [
      "no yearly prices at all",
      { STRIPE_PRICE_PRO: "price_pro_123", STRIPE_PRICE_MAX: "price_max_456", STRIPE_PRICE_MAX_2X: "price_max2x_789" },
    ],
    ["malformed monthly", { ...configured, STRIPE_PRICE_PRO: "prod_not-a-price" }],
    ["malformed yearly", { ...configured, STRIPE_PRICE_PRO_YEARLY: "price_bad-id" }],
    ["duplicate monthly", { ...configured, STRIPE_PRICE_MAX_2X: configured.STRIPE_PRICE_MAX }],
    ["monthly reused as yearly", { ...configured, STRIPE_PRICE_PRO_YEARLY: configured.STRIPE_PRICE_PRO }],
    ["yearly reused across tiers", { ...configured, STRIPE_PRICE_MAX_YEARLY: configured.STRIPE_PRICE_PRO_YEARLY }],
  ])("fails closed for %s configuration", (_name, value) => {
    expect(billingPriceCatalog(value)).toEqual({ ok: false, reason: expect.any(String) });
  });
});
