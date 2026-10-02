import type { BillableTier, BillingPriceCatalog } from "./billing-plans";
import { constantTimeEqual, hmacSha256Hex } from "./crypto";

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2025-03-31.basil";
const STRIPE_ID = /^(?:cus|sub|cs|bps)_[A-Za-z0-9_]+$/;
const PROVIDER_TIMEOUT_MS = 15_000;

export interface StripeSubscriptionSnapshot {
  id: string;
  customerId: string;
  status: string;
  tier: BillableTier;
  periodStart: string;
  periodEnd: string;
}

export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!header || !secret.startsWith("whsec_") || !Number.isSafeInteger(nowSeconds)) return false;
  const parts = header.split(",").map((part) => part.split("=", 2));
  const timestampText = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value ?? "");
  if (!timestampText || !/^\d{1,12}$/.test(timestampText) || signatures.length === 0) return false;
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = await hmacSha256Hex(secret, `${timestampText}.${payload}`);
  return signatures.some((signature) => /^[a-f0-9]{64}$/.test(signature) && constantTimeEqual(signature, expected));
}

function invalidSubscription(): never {
  throw new Error("invalid subscription");
}

function asStripeId(value: unknown, prefix: "cus" | "sub"): string {
  if (typeof value !== "string" || !value.startsWith(`${prefix}_`) || !STRIPE_ID.test(value)) invalidSubscription();
  return value;
}

export function identifyStripeSubscription(value: unknown): { id: string; customerId: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.livemode !== true) return null;
  try {
    return { id: asStripeId(raw.id, "sub"), customerId: asStripeId(raw.customer, "cus") };
  } catch {
    return null;
  }
}

function unixIso(value: unknown): string {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalidSubscription();
  return new Date((value as number) * 1000).toISOString();
}

function isExactHttpsOrigin(value: string, hostname: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === hostname &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function parseStripeSubscription(
  value: unknown,
  catalog: Extract<BillingPriceCatalog, { ok: true }>,
): StripeSubscriptionSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidSubscription();
  const raw = value as Record<string, unknown>;
  const identity = identifyStripeSubscription(value);
  if (!identity) invalidSubscription();
  const items = raw.items as { data?: unknown } | undefined;
  if (!items || !Array.isArray(items.data) || items.data.length !== 1) invalidSubscription();
  const item = items.data[0] as Record<string, unknown> | undefined;
  const price = item?.price as { id?: unknown } | undefined;
  if (item?.quantity !== 1 || typeof price?.id !== "string") invalidSubscription();
  const tier = catalog.tierForPrice[price.id];
  if (!tier) invalidSubscription();
  if (typeof raw.status !== "string" || !/^[a-z_]{1,32}$/.test(raw.status)) invalidSubscription();
  const periodStart = unixIso(item.current_period_start);
  const periodEnd = unixIso(item.current_period_end);
  if (periodEnd <= periodStart) invalidSubscription();
  return {
    id: identity.id,
    customerId: identity.customerId,
    status: raw.status,
    tier,
    periodStart,
    periodEnd,
  };
}

interface StripeClientOptions {
  secretKey: string;
  fetcher?: typeof fetch;
}

interface StripeRequestOptions {
  idempotencyKey?: string;
}

async function stripeJson(
  fetcher: typeof fetch,
  secretKey: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetcher(`${STRIPE_API}${path}`, {
    ...init,
    // Workerd rejects `redirect: "error"` before issuing even a non-redirecting request.
    // Manual mode exposes a 3xx response without following it; the !response.ok check then rejects it.
    redirect: "manual",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${secretKey}`,
      "stripe-version": STRIPE_VERSION,
      ...(init.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error("billing provider unavailable");
  try {
    return await response.json();
  } catch {
    throw new Error("billing provider unavailable");
  }
}

export function stripeClient({ secretKey, fetcher = fetch }: StripeClientOptions) {
  const post = async (path: string, parameters: Record<string, string>, options: StripeRequestOptions = {}) =>
    stripeJson(fetcher, secretKey, path, {
      method: "POST",
      headers: options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {},
      body: new URLSearchParams(parameters).toString(),
    });
  const checkoutStatus = async (sessionId: string): Promise<"open" | "complete" | "expired"> => {
    if (!sessionId.startsWith("cs_") || !STRIPE_ID.test(sessionId)) throw new Error("invalid checkout session");
    const value = (await stripeJson(fetcher, secretKey, `/checkout/sessions/${encodeURIComponent(sessionId)}`)) as {
      id?: unknown;
      livemode?: unknown;
      status?: unknown;
    };
    if (
      value.id !== sessionId ||
      value.livemode !== true ||
      (value.status !== "open" && value.status !== "complete" && value.status !== "expired")
    ) {
      throw new Error("billing provider unavailable");
    }
    return value.status;
  };
  const expireCheckout = async (sessionId: string): Promise<void> => {
    if (!sessionId.startsWith("cs_") || !STRIPE_ID.test(sessionId)) throw new Error("invalid checkout session");
    const value = (await post(`/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {})) as {
      id?: unknown;
      livemode?: unknown;
      status?: unknown;
    };
    if (value.id !== sessionId || value.livemode !== true || value.status !== "expired") {
      throw new Error("billing provider unavailable");
    }
  };
  /** Read-only, paginated list of a Stripe collection. Bounded so one call can never run away. */
  const listAll = async (path: string, parameters: Record<string, string>, maxPages = 20): Promise<unknown[]> => {
    const items: unknown[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const query = new URLSearchParams({ ...parameters, limit: "100" });
      if (startingAfter) query.set("starting_after", startingAfter);
      const value = (await stripeJson(fetcher, secretKey, `${path}?${query}`)) as {
        object?: unknown;
        data?: unknown;
        has_more?: unknown;
      };
      if (value.object !== "list" || !Array.isArray(value.data)) throw new Error("billing provider unavailable");
      items.push(...value.data);
      const last = value.data.at(-1) as { id?: unknown } | undefined;
      if (value.has_more !== true || typeof last?.id !== "string") return items;
      startingAfter = last.id;
    }
    throw new Error("billing list too large");
  };
  return {
    /** Every subscription (all statuses), with discounts expanded, for owner revenue reporting. */
    listSubscriptions(): Promise<unknown[]> {
      return listAll("/subscriptions", { status: "all", "expand[]": "data.discounts" });
    },
    listCharges(createdGteSeconds: number): Promise<unknown[]> {
      return listAll("/charges", { "created[gte]": String(createdGteSeconds) });
    },
    listRefunds(createdGteSeconds: number): Promise<unknown[]> {
      return listAll("/refunds", { "created[gte]": String(createdGteSeconds) });
    },
    async createCustomer(input: { email: string; accountId: string; idempotencyKey: string }): Promise<{ id: string }> {
      const value = (await post(
        "/customers",
        { email: input.email, "metadata[kalcode_account_id]": input.accountId },
        { idempotencyKey: input.idempotencyKey },
      )) as { id?: unknown };
      if (typeof value.id !== "string" || !value.id.startsWith("cus_") || !STRIPE_ID.test(value.id)) {
        throw new Error("billing provider unavailable");
      }
      return { id: value.id };
    },
    async createCheckout(input: {
      customerId: string;
      priceId: string;
      successUrl: string;
      cancelUrl: string;
      expiresAt: number;
      idempotencyKey: string;
    }): Promise<{ id: string; url: string }> {
      const value = (await post(
        "/checkout/sessions",
        {
          customer: input.customerId,
          mode: "subscription",
          "line_items[0][price]": input.priceId,
          "line_items[0][quantity]": "1",
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          expires_at: String(input.expiresAt),
          "subscription_data[metadata][kalcode_managed]": "true",
        },
        { idempotencyKey: input.idempotencyKey },
      )) as { id?: unknown; url?: unknown };
      if (
        typeof value.id !== "string" ||
        !value.id.startsWith("cs_") ||
        !STRIPE_ID.test(value.id) ||
        typeof value.url !== "string" ||
        !isExactHttpsOrigin(value.url, "checkout.stripe.com")
      ) {
        throw new Error("billing provider unavailable");
      }
      return { id: value.id, url: value.url };
    },
    expireCheckout,
    async retireCheckout(sessionId: string): Promise<void> {
      if ((await checkoutStatus(sessionId)) !== "open") return;
      try {
        await expireCheckout(sessionId);
      } catch {
        // Completion can race the expiry request. Accept only a newly observed terminal state;
        // an unavailable provider or still-open session remains retryable via the D1 outbox.
        if ((await checkoutStatus(sessionId)) === "open") throw new Error("billing provider unavailable");
      }
    },
    async createPortal(input: {
      customerId: string;
      returnUrl: string;
      idempotencyKey: string;
    }): Promise<{ url: string }> {
      const value = (await post(
        "/billing_portal/sessions",
        { customer: input.customerId, return_url: input.returnUrl },
        { idempotencyKey: input.idempotencyKey },
      )) as { url?: unknown };
      if (typeof value.url !== "string" || !isExactHttpsOrigin(value.url, "billing.stripe.com")) {
        throw new Error("billing provider unavailable");
      }
      return { url: value.url };
    },
    async retrieveSubscription(subscriptionId: string): Promise<unknown> {
      if (!subscriptionId.startsWith("sub_") || !STRIPE_ID.test(subscriptionId))
        throw new Error("invalid subscription");
      return stripeJson(fetcher, secretKey, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    },
  };
}

export type StripeClient = ReturnType<typeof stripeClient>;
