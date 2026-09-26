import { describe, expect, it } from "vitest";
import { billingPriceCatalog } from "../../worker/lib/billing-plans";

describe("billing price catalog", () => {
  const configured = {
    STRIPE_PRICE_PRO: "price_pro_123",
    STRIPE_PRICE_MAX: "price_max_456",
    STRIPE_PRICE_MAX_2X: "price_max2x_789",
  };

  it("maps configured Stripe prices to every public paid tier and never to Free or OWNER", () => {
    const catalog = billingPriceCatalog(configured);
    expect(catalog).toEqual({
      ok: true,
      priceForTier: {
        pro: "price_pro_123",
        max: "price_max_456",
        max2x: "price_max2x_789",
      },
      tierForPrice: {
        price_pro_123: "pro",
        price_max_456: "max",
        price_max2x_789: "max2x",
      },
    });
    if (catalog.ok) {
      expect(Object.values(catalog.priceForTier)).not.toContain("free");
      expect(Object.values(catalog.priceForTier)).not.toContain("owner");
    }
  });

  it.each([
    ["missing", { STRIPE_PRICE_PRO: configured.STRIPE_PRICE_PRO, STRIPE_PRICE_MAX: configured.STRIPE_PRICE_MAX }],
    ["malformed", { ...configured, STRIPE_PRICE_PRO: "prod_not-a-price" }],
    ["duplicate", { ...configured, STRIPE_PRICE_MAX_2X: configured.STRIPE_PRICE_MAX }],
  ])("fails closed for %s configuration", (_name, value) => {
    expect(billingPriceCatalog(value)).toEqual({ ok: false, reason: expect.any(String) });
  });
});
