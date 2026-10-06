import { BILLING_INTERVALS, PLANS } from "@kalcode/protocol/plans";
import { describe, expect, it } from "vitest";
import {
  CHECKOUT_INTENT_TTL_MS,
  CHECKOUT_REQUEST_KEY_PREFIX,
  CHECKOUT_REQUEST_TTL_MS,
  checkoutIntentHref,
  checkoutRequestId,
  forgetCheckoutRequests,
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

describe("checkout request id", () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
  }
  let counter = 0;
  const create = () => {
    counter += 1;
    return `request${String(counter).padStart(8, "0")}`;
  };

  it("reuses the id for the same plan and interval, so returning from Stripe reopens that session", () => {
    const storage = memoryStorage();
    const now = 1_800_000_000_000;
    const first = checkoutRequestId(storage, "max", "year", now, create);
    expect(checkoutRequestId(storage, "max", "year", now + 60_000, create)).toBe(first);
    expect(checkoutRequestId(storage, "max", "month", now + 60_000, create)).not.toBe(first);
    expect(checkoutRequestId(storage, "pro", "year", now + 60_000, create)).not.toBe(first);
    // After the API's reservation lifetime the old id names nothing; start a new request.
    const later = checkoutRequestId(storage, "max", "year", now + CHECKOUT_REQUEST_TTL_MS, create);
    expect(later).not.toBe(first);
    expect(checkoutRequestId(storage, "max", "year", now + CHECKOUT_REQUEST_TTL_MS + 1, create)).toBe(later);
  });

  it("forgets every id once a plan is active and survives blocked or tampered storage", () => {
    const storage = memoryStorage();
    const now = 1_800_000_000_000;
    const first = checkoutRequestId(storage, "pro", "month", now, create);
    forgetCheckoutRequests(storage);
    expect(storage.values.size).toBe(0);
    expect(checkoutRequestId(storage, "pro", "month", now, create)).not.toBe(first);

    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(checkoutRequestId(blocked, "pro", "month", now, create)).toMatch(/^request\d{8}$/);
    expect(() => forgetCheckoutRequests(blocked)).not.toThrow();
    expect(checkoutRequestId(null, "pro", "month", now, create)).toMatch(/^request\d{8}$/);

    storage.values.set(`${CHECKOUT_REQUEST_KEY_PREFIX}pro:month`, JSON.stringify({ id: "x y", createdAt: now }));
    expect(checkoutRequestId(storage, "pro", "month", now, create)).not.toBe("x y");
    storage.values.set(`${CHECKOUT_REQUEST_KEY_PREFIX}pro:month`, "not json");
    expect(checkoutRequestId(storage, "pro", "month", now, create)).toMatch(/^request\d{8}$/);
  });
});
