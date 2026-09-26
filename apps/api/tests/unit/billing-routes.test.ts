import { describe, expect, it, vi } from "vitest";
import { billingPriceCatalog } from "../../worker/lib/billing-plans";
import { billingService } from "../../worker/lib/billing-routes";
import type { BillingStore } from "../../worker/lib/billing-store";
import { hmacSha256Hex } from "../../worker/lib/crypto";
import type { StripeClient, StripeSubscriptionSnapshot } from "../../worker/lib/stripe";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const catalog = billingPriceCatalog({
  STRIPE_PRICE_PRO: "price_pro_123",
  STRIPE_PRICE_MAX: "price_max_456",
  STRIPE_PRICE_MAX_2X: "price_max2x_789",
});
if (!catalog.ok) throw new Error("test catalog invalid");

function fakeStore(overrides: Record<string, unknown> = {}): BillingStore {
  return {
    reserveCustomer: vi.fn(async () => ({
      accountId: "acct_123",
      email: "user@example.com",
      stripeCustomerId: "cus_12345678",
      createIdempotencyKey: "customer_idempotency_123",
    })),
    bindCustomer: vi.fn(async () => true),
    customerForAccount: vi.fn(async () => "cus_12345678"),
    reserveCheckout: vi.fn(async ({ idempotencyKey }) => ({ status: "reserved" as const, idempotencyKey })),
    bindCheckoutParameters: vi.fn(async ({ parameters }) => ({
      parameters: { ...parameters, expiresAt: Math.floor(NOW.getTime() / 1000) + 2100 },
      checkoutUrl: null,
    })),
    checkoutStillReserved: vi.fn(async () => true),
    finalizeCheckout: vi.fn(async () => true),
    allowAction: vi.fn(async () => true),
    claimEvent: vi.fn(async ({ eventId, token }) => ({
      status: "claimed" as const,
      claim: { eventId, token, version: 1 },
    })),
    finishEvent: vi.fn(async () => true),
    acquireLease: vi.fn(async ({ subscriptionId, token, expiresAt }) => ({
      subscriptionId,
      token,
      version: 1,
      expiresAt,
    })),
    applySubscription: vi.fn(async () => true),
    pendingCheckoutInvalidations: vi.fn(async () => []),
    completeCheckoutInvalidation: vi.fn(async () => true),
    revokeInvalidSubscription: vi.fn(async () => true),
    releaseLease: vi.fn(async () => undefined),
    ...overrides,
  } as BillingStore;
}

function fakeStripe(overrides: Record<string, unknown> = {}): StripeClient {
  return {
    createCustomer: vi.fn(async () => ({ id: "cus_12345678" })),
    createCheckout: vi.fn(async () => ({ id: "cs_123", url: "https://checkout.stripe.com/c/pay/cs_123" })),
    expireCheckout: vi.fn(async () => undefined),
    retireCheckout: vi.fn(async () => undefined),
    createPortal: vi.fn(async () => ({ url: "https://billing.stripe.com/p/session_123" })),
    retrieveSubscription: vi.fn(async () => ({
      id: "sub_12345678",
      livemode: true,
      customer: "cus_12345678",
      status: "active",
      items: {
        data: [
          {
            quantity: 1,
            price: { id: "price_max_456" },
            current_period_start: 1_700_000_000,
            current_period_end: 1_702_592_000,
          },
        ],
      },
    })),
    ...overrides,
  } as StripeClient;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://api.kalcoded.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function signedWebhook(event: unknown, secret = "whsec_test", timestamp = Math.floor(NOW.getTime() / 1000)) {
  const payload = JSON.stringify(event);
  const signature = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return new Request("https://api.kalcoded.com/v1/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": `t=${timestamp},v1=${signature}`, "content-type": "application/json" },
    body: payload,
  });
}

describe("billing routes", () => {
  it("holds checkout before any billing effects while retaining existing-customer portal access", async () => {
    const store = fakeStore();
    const stripe = fakeStripe();
    const billing = billingService({
      store,
      stripe,
      catalog,
      webhookSecret: "whsec_test",
      now: () => NOW,
      checkoutEnabled: false,
    });
    const response = await billing.checkout(
      post("/v1/billing/checkout", {
        tier: "pro",
        requestId: "release_hold_test",
      }),
      "acct_123",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "checkout_unavailable" });
    expect(store.allowAction).not.toHaveBeenCalled();
    expect(store.reserveCheckout).not.toHaveBeenCalled();
    expect(store.reserveCustomer).not.toHaveBeenCalled();
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.createCheckout).not.toHaveBeenCalled();
    expect(
      (await billing.portal(post("/v1/billing/portal", { requestId: "portal_hold_test" }), "acct_123")).status,
    ).toBe(200);
    expect(stripe.createPortal).toHaveBeenCalledOnce();
  });

  it("uses only the server catalog price and rejects Free, OWNER, or client price input", async () => {
    const stripe = fakeStripe();
    const billing = billingService({
      checkoutEnabled: true,
      store: fakeStore(),
      stripe,
      catalog,
      webhookSecret: "whsec_test",
      now: () => NOW,
    });
    const response = await billing.checkout(
      post("/v1/billing/checkout", { tier: "max2x", requestId: "checkout_123" }),
      "acct_123",
    );
    expect(response.status).toBe(200);
    expect(stripe.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_12345678",
        priceId: "price_max2x_789",
        expiresAt: Math.floor(NOW.getTime() / 1000) + 2_100,
      }),
    );
    for (const body of [
      { tier: "free", requestId: "checkout_124" },
      { tier: "owner", requestId: "checkout_125" },
      { tier: "pro", requestId: "checkout_126", priceId: "price_attacker" },
    ]) {
      expect((await billing.checkout(post("/v1/billing/checkout", body), "acct_123")).status).toBe(400);
    }
  });

  it("binds idempotency to the selected tier and sends existing subscribers to the portal", async () => {
    const reserved = vi
      .fn()
      .mockResolvedValueOnce({ status: "reserved", idempotencyKey: "checkout_pro" })
      .mockResolvedValueOnce({ status: "reserved", idempotencyKey: "checkout_max" })
      .mockResolvedValueOnce({ status: "subscribed" });
    const store = fakeStore({ reserveCheckout: reserved });
    const stripe = fakeStripe();
    const billing = billingService({
      checkoutEnabled: true,
      store,
      stripe,
      catalog,
      webhookSecret: "whsec_test",
      now: () => NOW,
    });
    expect(
      (await billing.checkout(post("/v1/billing/checkout", { tier: "pro", requestId: "same_request" }), "acct_123"))
        .status,
    ).toBe(200);
    expect(
      (await billing.checkout(post("/v1/billing/checkout", { tier: "max", requestId: "same_request" }), "acct_123"))
        .status,
    ).toBe(200);
    expect(reserved.mock.calls[0]?.[0].requestHash).not.toBe(reserved.mock.calls[1]?.[0].requestHash);
    expect(
      (await billing.checkout(post("/v1/billing/checkout", { tier: "max", requestId: "next_request" }), "acct_123"))
        .status,
    ).toBe(409);
  });

  it("rate limits checkout before any Stripe effect", async () => {
    const stripe = fakeStripe();
    const billing = billingService({
      checkoutEnabled: true,
      store: fakeStore({ allowAction: vi.fn(async () => false) }),
      stripe,
      catalog,
      webhookSecret: "whsec_test",
      now: () => NOW,
    });
    const response = await billing.checkout(
      post("/v1/billing/checkout", { tier: "pro", requestId: "checkout_123" }),
      "acct_123",
    );
    expect(response.status).toBe(429);
    expect(stripe.createCheckout).not.toHaveBeenCalled();
  });

  it.each(["subscribed", "owner"] as const)(
    "expires the remote session when the account becomes %s during Checkout creation",
    async (transition) => {
      let authority: "reserved" | "subscribed" | "owner" = "reserved";
      const store = fakeStore({ finalizeCheckout: vi.fn(async () => authority === "reserved") });
      const stripe = fakeStripe({
        createCheckout: vi.fn(async () => {
          authority = transition;
          return { id: "cs_raced123", url: "https://checkout.stripe.com/c/pay/cs_raced123" };
        }),
      });
      const billing = billingService({
        checkoutEnabled: true,
        store,
        stripe,
        catalog,
        webhookSecret: "whsec_test",
        now: () => NOW,
      });
      const response = await billing.checkout(
        post("/v1/billing/checkout", { tier: "pro", requestId: `checkout_${transition}` }),
        "acct_123",
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "checkout_unavailable" });
      expect(stripe.expireCheckout).toHaveBeenCalledWith("cs_raced123");
    },
  );

  it("never starts paid Checkout for OWNER", async () => {
    const stripe = fakeStripe();
    const billing = billingService({
      checkoutEnabled: true,
      store: fakeStore({ reserveCheckout: vi.fn(async () => ({ status: "owner" as const })) }),
      stripe,
      catalog,
      webhookSecret: "whsec_test",
      now: () => NOW,
    });
    const response = await billing.checkout(
      post("/v1/billing/checkout", { tier: "pro", requestId: "checkout_123" }),
      "acct_owner",
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "billing_unavailable" });
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.createCheckout).not.toHaveBeenCalled();
  });

  it("refuses browser origins before any billing effect", async () => {
    const stripe = fakeStripe();
    const billing = billingService({
      checkoutEnabled: true,
      store: fakeStore(),
      stripe,
      catalog,
      webhookSecret: "whsec_test",
      now: () => NOW,
    });
    const response = await billing.checkout(
      post("/v1/billing/checkout", { tier: "pro", requestId: "checkout_123" }, { origin: "https://attacker.example" }),
      "acct_123",
    );
    expect(response.status).toBe(403);
    expect(stripe.createCheckout).not.toHaveBeenCalled();
  });

  it("rejects a forged webhook before claiming an event or contacting Stripe", async () => {
    const store = fakeStore();
    const stripe = fakeStripe();
    const billing = billingService({
      checkoutEnabled: true,
      store,
      stripe,
      catalog,
      webhookSecret: "whsec_test",
      now: () => NOW,
    });
    const request = await signedWebhook(
      {
        id: "evt_123",
        livemode: true,
        type: "customer.subscription.updated",
        data: { object: { id: "sub_12345678" } },
      },
      "whsec_wrong",
    );
    expect((await billing.webhook(request)).status).toBe(400);
    expect(store.claimEvent).not.toHaveBeenCalled();
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
  });

  it("ignores event snapshot fields and reconciles Stripe's current subscription under a fencing lease", async () => {
    const apply = vi.fn(async (_snapshot: StripeSubscriptionSnapshot) => true);
    const store = fakeStore({ applySubscription: apply });
    const stripe = fakeStripe();
    const billing = billingService({
      checkoutEnabled: true,
      store,
      stripe,
      catalog,
      webhookSecret: "whsec_test",
      now: () => NOW,
    });
    const request = await signedWebhook({
      id: "evt_123",
      livemode: true,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_12345678", items: { data: [{ price: { id: "price_pro_123" } }] } } },
    });
    expect((await billing.webhook(request)).status).toBe(200);
    expect(stripe.retrieveSubscription).toHaveBeenCalledWith("sub_12345678");
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "max" }),
      expect.objectContaining({ version: 1 }),
      expect.any(String),
    );
    expect(store.finishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "evt_123", version: 1 }),
      "applied",
      expect.any(String),
    );
    expect(store.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("retires every durable open-Checkout invalidation before completing the webhook", async () => {
    const store = fakeStore({ pendingCheckoutInvalidations: vi.fn(async () => ["cs_other_open"]) });
    const stripe = fakeStripe();
    const billing = billingService({
      checkoutEnabled: true,
      store,
      stripe,
      catalog,
      webhookSecret: "whsec_test",
      now: () => NOW,
    });
    const request = await signedWebhook({
      id: "evt_checkout_cleanup",
      livemode: true,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_12345678" } },
    });
    expect((await billing.webhook(request)).status).toBe(200);
    expect(stripe.retireCheckout).toHaveBeenCalledWith("cs_other_open");
    expect(store.completeCheckoutInvalidation).toHaveBeenCalledWith(
      "sub_12345678",
      "cs_other_open",
      expect.any(String),
    );
    expect(store.finishEvent).toHaveBeenCalledAfter(vi.mocked(store.completeCheckoutInvalidation));
  });

  it("revokes fail closed for an unknown-price or quantity-mismatched current subscription", async () => {
    const store = fakeStore();
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn(async () => ({
        id: "sub_12345678",
        livemode: true,
        customer: "cus_12345678",
        status: "active",
        items: {
          data: [
            {
              quantity: 2,
              price: { id: "price_unknown" },
              current_period_start: 1_700_000_000,
              current_period_end: 1_702_592_000,
            },
          ],
        },
      })),
    });
    const billing = billingService({
      checkoutEnabled: true,
      store,
      stripe,
      catalog,
      webhookSecret: "whsec_test",
      now: () => NOW,
    });
    const request = await signedWebhook({
      id: "evt_bad",
      livemode: true,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_12345678" } },
    });
    expect((await billing.webhook(request)).status).toBe(200);
    expect(store.applySubscription).not.toHaveBeenCalled();
    expect(store.revokeInvalidSubscription).toHaveBeenCalledWith(
      "sub_12345678",
      "cus_12345678",
      expect.objectContaining({ version: 1 }),
      expect.any(String),
    );
    expect(store.finishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "evt_bad", version: 1 }),
      "applied",
      expect.any(String),
    );
    expect(store.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("rejects test-mode events and same-id payload swaps before reconciliation", async () => {
    const store = fakeStore();
    const stripe = fakeStripe();
    const billing = billingService({
      checkoutEnabled: true,
      store,
      stripe,
      catalog,
      webhookSecret: "whsec_test",
      now: () => NOW,
    });
    const testMode = await signedWebhook({
      id: "evt_test_mode",
      livemode: false,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_12345678" } },
    });
    expect((await billing.webhook(testMode)).status).toBe(400);
    expect(store.claimEvent).not.toHaveBeenCalled();

    vi.mocked(store.claimEvent).mockResolvedValueOnce({ status: "mismatch" });
    const swapped = await signedWebhook({
      id: "evt_replayed",
      livemode: true,
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_attacker123" } },
    });
    expect((await billing.webhook(swapped)).status).toBe(400);
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
  });

  it("does not run two workers for the same pending event", async () => {
    const store = fakeStore({ claimEvent: vi.fn(async () => ({ status: "pending" as const })) });
    const stripe = fakeStripe();
    const billing = billingService({
      checkoutEnabled: true,
      store,
      stripe,
      catalog,
      webhookSecret: "whsec_test",
      now: () => NOW,
    });
    const duplicate = await signedWebhook({
      id: "evt_pending",
      livemode: true,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_12345678" } },
    });
    expect((await billing.webhook(duplicate)).status).toBe(409);
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
  });
});
