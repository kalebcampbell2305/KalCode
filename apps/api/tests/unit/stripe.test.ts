import { describe, expect, it, vi } from "vitest";
import { billingPriceCatalog } from "../../worker/lib/billing-plans";
import { parseStripeSubscription, stripeClient, verifyStripeSignature } from "../../worker/lib/stripe";

const catalog = billingPriceCatalog({
  STRIPE_PRICE_PRO: "price_pro_123",
  STRIPE_PRICE_MAX: "price_max_456",
  STRIPE_PRICE_MAX_2X: "price_max2x_789",
});
if (!catalog.ok) throw new Error("test catalog invalid");

describe("Stripe webhook verification", () => {
  it("accepts a current valid v1 signature and rejects tampering or stale timestamps", async () => {
    const payload = '{"id":"evt_123"}';
    const secret = "whsec_test";
    const signature = await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
      ]),
      new TextEncoder().encode(`1700000000.${payload}`),
    );
    const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const header = `t=1700000000,v1=${hex}`;
    await expect(verifyStripeSignature(payload, header, secret, 1_700_000_100)).resolves.toBe(true);
    await expect(verifyStripeSignature(`${payload} `, header, secret, 1_700_000_100)).resolves.toBe(false);
    await expect(verifyStripeSignature(payload, header, secret, 1_700_000_400)).resolves.toBe(false);
  });
});

describe("Stripe subscription authority", () => {
  it("maps exactly one quantity-one known price using item-level billing periods", () => {
    expect(
      parseStripeSubscription(
        {
          id: "sub_123",
          livemode: true,
          customer: "cus_123",
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
        },
        catalog,
      ),
    ).toEqual({
      id: "sub_123",
      customerId: "cus_123",
      status: "active",
      tier: "max",
      periodStart: "2023-11-14T22:13:20.000Z",
      periodEnd: "2023-12-14T22:13:20.000Z",
    });
  });

  it.each([
    ["unknown price", { quantity: 1, price: { id: "price_unknown" } }],
    ["wrong quantity", { quantity: 2, price: { id: "price_pro_123" } }],
  ])("fails closed for %s", (_label, item) => {
    expect(() =>
      parseStripeSubscription(
        {
          id: "sub_123",
          livemode: true,
          customer: "cus_123",
          status: "active",
          items: { data: [{ ...item, current_period_start: 1_700_000_000, current_period_end: 1_702_592_000 }] },
        },
        catalog,
      ),
    ).toThrow(/invalid subscription/);
  });

  it("fails closed for multiple subscription items", () => {
    expect(() =>
      parseStripeSubscription(
        {
          id: "sub_123",
          livemode: true,
          customer: "cus_123",
          status: "active",
          items: { data: [{}, {}] },
        },
        catalog,
      ),
    ).toThrow(/invalid subscription/);
  });
});

describe("Stripe client", () => {
  it("uses only fixed official endpoints and server-owned checkout values", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "cs_123", url: "https://checkout.stripe.com/c/pay/cs_123" }), {
        status: 200,
      }),
    );
    const stripe = stripeClient({ secretKey: "sk_test", fetcher });
    await expect(
      stripe.createCheckout({
        customerId: "cus_123",
        priceId: "price_pro_123",
        successUrl: "https://kalcoded.com/account?checkout=success",
        cancelUrl: "https://kalcoded.com/pricing?checkout=cancelled",
        expiresAt: 1_800_000_000,
        idempotencyKey: "checkout-opaque",
      }),
    ).resolves.toEqual({ id: "cs_123", url: "https://checkout.stripe.com/c/pay/cs_123" });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toMatchObject({ "Idempotency-Key": "checkout-opaque" });
    expect(new Headers(init?.headers).get("stripe-version")).toBe("2025-03-31.basil");
    const body = new URLSearchParams(init?.body as string);
    expect(Object.fromEntries(body)).toMatchObject({
      customer: "cus_123",
      mode: "subscription",
      "line_items[0][price]": "price_pro_123",
      "line_items[0][quantity]": "1",
      expires_at: "1800000000",
    });
  });

  it("rejects a redirect instead of following it", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "https://redirect-target.invalid/never-requested" } }),
      );
    const stripe = stripeClient({ secretKey: "sk_test", fetcher });
    await expect(
      stripe.createCustomer({ email: "a@example.com", accountId: "acct_1", idempotencyKey: "customer-opaque" }),
    ).rejects.toThrow("billing provider unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("expires only the exact Checkout Session returned by Stripe", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "cs_raced123", livemode: true, status: "expired" }), { status: 200 }),
      );
    const stripe = stripeClient({ secretKey: "sk_test", fetcher });
    await expect(stripe.expireCheckout("cs_raced123")).resolves.toBeUndefined();
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.stripe.com/v1/checkout/sessions/cs_raced123/expire");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "manual" });
    await expect(stripe.expireCheckout("sub_wrong_kind")).rejects.toThrow("invalid checkout session");
  });

  it("retires an open Checkout and accepts a terminal session without another effect", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "cs_open123", livemode: true, status: "open" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "cs_open123", livemode: true, status: "expired" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "cs_done123", livemode: true, status: "complete" }), { status: 200 }),
      );
    const stripe = stripeClient({ secretKey: "sk_test", fetcher });
    await expect(stripe.retireCheckout("cs_open123")).resolves.toBeUndefined();
    await expect(stripe.retireCheckout("cs_done123")).resolves.toBeUndefined();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://api.stripe.com/v1/checkout/sessions/cs_open123",
      "https://api.stripe.com/v1/checkout/sessions/cs_open123/expire",
      "https://api.stripe.com/v1/checkout/sessions/cs_done123",
    ]);
  });

  it("rechecks terminal state when completion races Checkout expiry", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "cs_race123", livemode: true, status: "open" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("already complete", { status: 400 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "cs_race123", livemode: true, status: "complete" }), { status: 200 }),
      );
    await expect(stripeClient({ secretKey: "sk_test", fetcher }).retireCheckout("cs_race123")).resolves.toBeUndefined();
  });

  it.each([
    ["checkout", "https://checkout.stripe.com.attacker.example/c/pay/cs_123"],
    ["checkout credentials", "https://checkout.stripe.com@attacker.example/c/pay/cs_123"],
  ])("rejects a non-Stripe %s return URL", async (_label, url) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ id: "cs_123", url }), { status: 200 }));
    const stripe = stripeClient({ secretKey: "sk_test", fetcher });
    await expect(
      stripe.createCheckout({
        customerId: "cus_123",
        priceId: "price_pro_123",
        successUrl: "https://kalcoded.com/account?checkout=success",
        cancelUrl: "https://kalcoded.com/pricing?checkout=cancelled",
        expiresAt: 1_800_000_000,
        idempotencyKey: "checkout-opaque",
      }),
    ).rejects.toThrow("billing provider unavailable");
  });

  it("rejects a prefix-confused billing Portal URL", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ url: "https://billing.stripe.com.attacker.example/session" }), { status: 200 }),
      );
    const stripe = stripeClient({ secretKey: "sk_test", fetcher });
    await expect(
      stripe.createPortal({
        customerId: "cus_123",
        returnUrl: "https://kalcoded.com/account",
        idempotencyKey: "portal-opaque",
      }),
    ).rejects.toThrow("billing provider unavailable");
  });

  it("rejects test-mode or empty-status subscription snapshots", () => {
    const base = {
      id: "sub_123",
      customer: "cus_123",
      livemode: true,
      status: "active",
      items: {
        data: [
          {
            quantity: 1,
            price: { id: "price_pro_123" },
            current_period_start: 1_700_000_000,
            current_period_end: 1_702_592_000,
          },
        ],
      },
    };
    expect(() => parseStripeSubscription({ ...base, livemode: false }, catalog)).toThrow(/invalid subscription/);
    expect(() => parseStripeSubscription({ ...base, status: "" }, catalog)).toThrow(/invalid subscription/);
  });
});
