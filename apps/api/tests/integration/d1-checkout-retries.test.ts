import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { billingService } from "../../worker/lib/billing-routes";
import { d1BillingStore } from "../../worker/lib/billing-store";
import type { StripeClient } from "../../worker/lib/stripe";
import { openDatabase } from "../support/platform";
import { createMigratedDatabase, removeDatabase } from "../support/wrangler";

let persistTo: string;
let db: D1Database;
let dispose: () => Promise<void>;
const START = Date.parse("2026-09-25T12:00:00.000Z");

beforeAll(async () => {
  persistTo = createMigratedDatabase();
  ({ db, dispose } = await openDatabase(persistTo));
});
afterAll(async () => {
  await dispose?.();
  await removeDatabase(persistTo);
});

async function fixture(name: string) {
  const accountId = `acct_retry_${name}`;
  await db
    .prepare("INSERT INTO accounts (id, email, email_verified_at, created_at) VALUES (?1, ?2, ?3, ?3)")
    .bind(accountId, `${name}@example.com`, new Date(START).toISOString())
    .run();
  let clock = START;
  let loseResponse = false;
  const sessions = new Map<string, { parameters: string; id: string; url: string }>();
  const createCheckout = vi.fn(async (input: Parameters<StripeClient["createCheckout"]>[0]) => {
    const existing = sessions.get(input.idempotencyKey);
    if (existing && existing.parameters !== JSON.stringify(input)) throw new Error("idempotency parameter mismatch");
    if (!existing && input.expiresAt < clock / 1000 + 1800) throw new Error("expiration below provider minimum");
    const session = existing ?? {
      parameters: JSON.stringify(input),
      id: `cs_${name}_${sessions.size}`,
      url: `https://checkout.stripe.com/c/pay/cs_${name}_${sessions.size}`,
    };
    sessions.set(input.idempotencyKey, session);
    if (loseResponse) {
      loseResponse = false;
      throw new Error("synthetic lost response");
    }
    return { id: session.id, url: session.url };
  });
  const store = d1BillingStore(db);
  const catalog = {
    ok: true as const,
    priceForTier: { pro: "price_original", max: "price_max", max2x: "price_max2x" },
    tierForPrice: {},
  };
  const stripe = {
    createCheckout,
    createCustomer: vi.fn(async () => ({ id: `cus_${name}` })),
    expireCheckout: vi.fn(async () => undefined),
  } as unknown as StripeClient;
  const service = billingService({
    store,
    stripe,
    catalog,
    checkoutEnabled: true,
    now: () => new Date(clock),
    webhookSecret: "whsec_synthetic",
  });
  const checkout = () =>
    service.checkout(
      new Request("https://api.kalcoded.com/v1/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier: "pro", requestId: "same_request_123" }),
      }),
      accountId,
    );
  return {
    accountId,
    store,
    catalog,
    checkout,
    createCheckout,
    sessions,
    loseNextResponse: () => {
      loseResponse = true;
    },
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
  };
}

describe("persisted checkout retries", () => {
  it("recovers a lost provider response with exactly the same parameters after time advances", async () => {
    const f = await fixture("lost");
    f.loseNextResponse();
    await expect(f.checkout()).rejects.toThrow("synthetic lost response");
    f.advance(60);
    expect((await f.checkout()).status).toBe(200);
    expect(f.createCheckout.mock.calls[1]?.[0]).toEqual(f.createCheckout.mock.calls[0]?.[0]);
    expect(f.sessions.size).toBe(1);
  });

  it("returns a known finalized URL after the creation window closes without another provider call", async () => {
    const f = await fixture("known");
    const first = await (await f.checkout()).json();
    f.advance(600);
    const retry = await f.checkout();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(first);
    expect(f.createCheckout).toHaveBeenCalledTimes(1);
  });

  it("holds an ambiguous late retry until expiry and creates a distinct operation after expiry", async () => {
    const f = await fixture("late");
    f.loseNextResponse();
    await expect(f.checkout()).rejects.toThrow("synthetic lost response");
    f.advance(600);
    const held = await f.checkout();
    expect(held.status).toBe(409);
    expect(held.headers.get("retry-after")).toBe("1500");
    expect(f.createCheckout).toHaveBeenCalledTimes(1);
    f.advance(1501);
    expect((await f.checkout()).status).toBe(200);
    expect(f.sessions.size).toBe(2);
    expect(f.createCheckout.mock.calls[1]?.[0].idempotencyKey).not.toBe(
      f.createCheckout.mock.calls[0]?.[0].idempotencyKey,
    );
  });

  it("keeps the reserved server price when deployment catalog settings change between attempts", async () => {
    const f = await fixture("catalog");
    f.loseNextResponse();
    await expect(f.checkout()).rejects.toThrow("synthetic lost response");
    f.catalog.priceForTier.pro = "price_replacement";
    f.advance(10);
    expect((await f.checkout()).status).toBe(200);
    expect(f.createCheckout.mock.calls[1]?.[0].priceId).toBe("price_original");
  });

  it("does not return a saved URL after account deletion", async () => {
    const f = await fixture("deleted");
    expect((await f.checkout()).status).toBe(200);
    await db
      .prepare("UPDATE accounts SET deleted_at = ?2 WHERE id = ?1")
      .bind(f.accountId, new Date(START + 1000).toISOString())
      .run();
    f.advance(1);
    expect((await f.checkout()).status).toBe(409);
    expect(f.createCheckout).toHaveBeenCalledTimes(1);
  });

  it("clears saved URLs and frozen parameters when a known expired checkout is replaced", async () => {
    const f = await fixture("replace");
    const original = await (await f.checkout()).json();
    f.advance(2101);
    f.catalog.priceForTier.pro = "price_updated";
    const replacement = await f.checkout();
    expect(replacement.status).toBe(200);
    expect(await replacement.json()).not.toEqual(original);
    expect(f.createCheckout.mock.calls[1]?.[0].priceId).toBe("price_updated");
    expect(f.sessions.size).toBe(2);
  });

  it("holds legacy intents with unknown provider parameters without attempting creation", async () => {
    const f = await fixture("legacy");
    const hash = "a".repeat(43);
    await f.store.reserveCheckout({
      accountId: f.accountId,
      tier: "pro",
      requestHash: hash,
      idempotencyKey: "legacy_checkout_key",
      now: new Date(START).toISOString(),
      expiresAt: new Date(START + 2100000).toISOString(),
    });
    await db
      .prepare("UPDATE billing_checkout_intents SET creation_parameters = NULL WHERE account_id = ?1")
      .bind(f.accountId)
      .run();
    expect(
      await f.store.bindCheckoutParameters({
        accountId: f.accountId,
        tier: "pro",
        requestHash: hash,
        now: new Date(START + 1000).toISOString(),
        parameters: {
          customerId: "cus_legacy",
          priceId: "price_legacy",
          successUrl: "https://kalcoded.com/account",
          cancelUrl: "https://kalcoded.com/pricing",
          expiresAt: 0,
          idempotencyKey: "legacy_checkout_key",
        },
      }),
    ).toBeNull();
    expect(f.createCheckout).not.toHaveBeenCalled();
  });

  it("fences stale attempts when an expired reservation is replaced by the same request hash", async () => {
    const f = await fixture("fence");
    const first = {
      accountId: f.accountId,
      tier: "pro" as const,
      requestHash: "f".repeat(43),
      idempotencyKey: "old_checkout_key_123",
      now: new Date(START).toISOString(),
      expiresAt: new Date(START + 2100000).toISOString(),
    };
    await f.store.reserveCheckout(first);
    const later = new Date(START + 2101000).toISOString();
    await f.store.reserveCheckout({
      ...first,
      idempotencyKey: "replacement_checkout_key",
      now: later,
      expiresAt: new Date(START + 4201000).toISOString(),
    });
    expect(await f.store.checkoutStillReserved({ ...first, now: later })).toBe(false);
    expect(
      await f.store.finalizeCheckout({
        ...first,
        now: later,
        stripeSessionId: "cs_stale",
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_stale",
      }),
    ).toBe(false);
    expect(
      await f.store.bindCheckoutParameters({
        ...first,
        now: later,
        parameters: {
          customerId: "cus_stale",
          priceId: "price_stale",
          successUrl: "https://kalcoded.com/account",
          cancelUrl: "https://kalcoded.com/pricing",
          expiresAt: 0,
          idempotencyKey: first.idempotencyKey,
        },
      }),
    ).toBeNull();
  });

  it("freezes concurrent creators to one parameter object", async () => {
    const f = await fixture("concurrent");
    const intent = {
      accountId: f.accountId,
      tier: "pro" as const,
      requestHash: "c".repeat(43),
      idempotencyKey: "shared_checkout_key",
      now: new Date(START).toISOString(),
      expiresAt: new Date(START + 2100000).toISOString(),
    };
    await f.store.reserveCheckout(intent);
    const parameters = {
      customerId: "cus_concurrent",
      priceId: "price_first",
      successUrl: "https://kalcoded.com/account",
      cancelUrl: "https://kalcoded.com/pricing",
      expiresAt: 0,
      idempotencyKey: intent.idempotencyKey,
    };
    const bindings = await Promise.all([
      f.store.bindCheckoutParameters({ ...intent, parameters }),
      f.store.bindCheckoutParameters({ ...intent, parameters: { ...parameters, priceId: "price_second" } }),
    ]);
    expect(bindings[0]).not.toBeNull();
    expect(bindings[1]).toEqual(bindings[0]);
    expect(bindings[0]?.parameters.expiresAt).toBe(START / 1000 + 2100);
  });
});
