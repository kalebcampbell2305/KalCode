import { BILLING_INTERVALS, PLANS } from "@kalcode/protocol/plans";
import { describe, expect, it } from "vitest";
import {
  CHECKOUT_INTENT_TTL_MS,
  checkoutIntentHref,
  parseCheckoutIntent,
  readCheckoutIntent,
  serializeCheckoutIntent,
} from "../../src/lib/checkout-intent";

const params = (query: string) => new URLSearchParams(query);

describe("checkout intent", () => {
  it("round-trips every catalog plan and interval through the CTA link", () => {
    for (const plan of PLANS) {
      for (const interval of BILLING_INTERVALS) {
        const href = checkoutIntentHref(plan.id, interval);
        expect(href).toBe(`/account?plan=${plan.id}&interval=${interval}`);
        expect(parseCheckoutIntent(new URL(href, "https://kalcoded.com").searchParams)).toEqual({
          plan: plan.id,
          interval,
        });
      }
    }
  });

  it("defaults a missing interval to monthly and ignores anything else", () => {
    expect(parseCheckoutIntent(params("plan=max"))).toEqual({ plan: "max", interval: "month" });
    for (const query of [
      "",
      "interval=year",
      "plan=owner&interval=month",
      "plan=MAX&interval=month",
      "plan=max&interval=week",
      "plan=max&plan=pro&interval=year",
      "plan=max&interval=year&interval=month",
      "plan=max%20&interval=year",
    ]) {
      expect(parseCheckoutIntent(params(query)), query).toBeNull();
    }
  });

  it("expires stored intents after an hour and rejects tampered ones", () => {
    const now = 1_800_000_000_000;
    const raw = serializeCheckoutIntent({ plan: "pro", interval: "year" }, now);
    expect(readCheckoutIntent(raw, now + 1)).toEqual({ plan: "pro", interval: "year" });
    expect(readCheckoutIntent(raw, now + CHECKOUT_INTENT_TTL_MS)).toBeNull();
    expect(readCheckoutIntent(null, now)).toBeNull();
    expect(readCheckoutIntent("not json", now)).toBeNull();
    expect(
      readCheckoutIntent(JSON.stringify({ plan: "owner", interval: "month", expiresAt: now + 10 }), now),
    ).toBeNull();
    expect(
      readCheckoutIntent(JSON.stringify({ plan: "max", interval: "month", expiresAt: now + 10, priceId: "x" }), now),
    ).toBeNull();
    // An expiry further out than the lifetime was not written by this site.
    expect(
      readCheckoutIntent(
        JSON.stringify({ plan: "max", interval: "month", expiresAt: now + CHECKOUT_INTENT_TTL_MS * 2 }),
        now,
      ),
    ).toBeNull();
  });
});
