import type { BillableTier, BillingPriceCatalog } from "./billing-plans";
import type { BillingStore } from "./billing-store";
import { isBillableTier } from "./billing-store";
import { readJsonBody } from "./body";
import { randomBase64Url, sha256Base64Url } from "./crypto";
import { apiError, json } from "./http";
import {
  identifyStripeSubscription,
  parseStripeSubscription,
  type StripeClient,
  type StripeSubscriptionSnapshot,
  verifyStripeSignature,
} from "./stripe";

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const EVENT_ID = /^evt_[A-Za-z0-9_]+$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_]+$/;
const MAX_WEBHOOK_BYTES = 256 * 1024;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const CHECKOUT_LIFETIME_MS = 35 * 60 * 1000;
// Stripe requires at least 30 minutes from creation; leave room for network transit.
const CHECKOUT_CREATION_MARGIN_SECONDS = 30 * 60 + 30;
const CHECKOUT_SUCCESS = "https://kalcoded.com/account?checkout=success";
const CHECKOUT_CANCEL = "https://kalcoded.com/pricing?checkout=cancelled";
const PORTAL_RETURN = "https://kalcoded.com/account";
const HANDLED_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

export interface BillingService {
  checkout(request: Request, accountId: string): Promise<Response>;
  portal(request: Request, accountId: string): Promise<Response>;
  webhook(request: Request): Promise<Response>;
}

interface Options {
  /** New purchases open only after the verified desktop release is available. */
  checkoutEnabled?: boolean;
  store: BillingStore;
  stripe: StripeClient;
  catalog: Extract<BillingPriceCatalog, { ok: true }>;
  webhookSecret: string;
  now: () => Date;
}

function noBrowserWrite(request: Request): Response | null {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== "https://kalcoded.com"
    ? apiError(403, "forbidden", "This request origin is not allowed.")
    : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function requestBody(request: Request): Promise<Record<string, unknown> | Response> {
  const body = await readJsonBody(request);
  if (!body.ok) {
    const status = body.reason === "unsupported_media_type" ? 415 : body.reason === "payload_too_large" ? 413 : 400;
    return apiError(status, body.reason, "The billing request is not valid.");
  }
  return object(body.value) ?? apiError(400, "invalid_request", "The billing request is not valid.");
}

async function rawBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared > MAX_WEBHOOK_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

async function ensureCustomer(options: Options, accountId: string, at: string): Promise<string | null> {
  const reservation = await options.store.reserveCustomer({
    accountId,
    idempotencyKey: `customer_${randomBase64Url(24)}`,
    now: at,
  });
  if (!reservation) return null;
  if (reservation.stripeCustomerId) return reservation.stripeCustomerId;
  const created = await options.stripe.createCustomer({
    email: reservation.email,
    accountId,
    idempotencyKey: reservation.createIdempotencyKey,
  });
  if (!(await options.store.bindCustomer(accountId, created.id, at))) {
    return options.store.customerForAccount(accountId);
  }
  return created.id;
}

export function billingService(options: Options): BillingService {
  async function rateAllowed(accountId: string, action: "checkout" | "portal", limit: number): Promise<boolean> {
    const at = options.now();
    return options.store.allowAction({
      accountId,
      action,
      now: at.toISOString(),
      windowStart: new Date(at.getTime() - RATE_WINDOW_MS).toISOString(),
      retentionStart: new Date(at.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      limit,
    });
  }

  return {
    async checkout(request, accountId) {
      const forbidden = noBrowserWrite(request);
      if (forbidden) return forbidden;
      if (options.checkoutEnabled !== true) {
        return apiError(503, "checkout_unavailable", "Paid plans are not open yet.");
      }
      const body = await requestBody(request);
      if (body instanceof Response) return body;
      const tier = body.tier;
      const requestId = body.requestId;
      if (
        Object.keys(body).length !== 2 ||
        typeof tier !== "string" ||
        !isBillableTier(tier) ||
        typeof requestId !== "string" ||
        !REQUEST_ID.test(requestId)
      ) {
        return apiError(400, "invalid_request", "Choose a public paid plan and try again.");
      }
      if (!(await rateAllowed(accountId, "checkout", 10))) {
        return apiError(429, "rate_limited", "Please wait before trying again.", { "retry-after": "600" });
      }
      const at = options.now().toISOString();
      const requestHash = await sha256Base64Url(`${accountId}:${tier}:${requestId}`);
      const reservation = await options.store.reserveCheckout({
        accountId,
        tier,
        requestHash,
        // Only an inserted/replaced reservation adopts this key. Live retries retain theirs.
        idempotencyKey: `checkout_${randomBase64Url(32)}`,
        now: at,
        expiresAt: new Date(options.now().getTime() + CHECKOUT_LIFETIME_MS).toISOString(),
      });
      if (reservation.status === "subscribed") {
        return apiError(409, "manage_existing_subscription", "Manage your current plan in the billing portal.");
      }
      if (reservation.status === "owner") {
        return apiError(409, "billing_unavailable", "OWNER does not need a paid subscription.");
      }
      if (reservation.status === "busy") {
        return apiError(409, "checkout_in_progress", "A checkout is already in progress.", { "retry-after": "1800" });
      }
      const customerId = await ensureCustomer(options, accountId, at);
      if (!customerId) return apiError(409, "billing_account_unavailable", "Billing could not be started.");
      const binding = await options.store.bindCheckoutParameters({
        accountId,
        tier,
        requestHash,
        now: options.now().toISOString(),
        parameters: {
          customerId,
          priceId: options.catalog.priceForTier[tier as BillableTier],
          successUrl: CHECKOUT_SUCCESS,
          cancelUrl: CHECKOUT_CANCEL,
          expiresAt: 0, // The store replaces this with the reservation's immutable expiry.
          idempotencyKey: reservation.idempotencyKey,
        },
      });
      if (!binding) return apiError(409, "checkout_unavailable", "Checkout could not be started.");
      if (
        !(await options.store.checkoutStillReserved({
          accountId,
          tier,
          requestHash,
          idempotencyKey: reservation.idempotencyKey,
          now: options.now().toISOString(),
        }))
      ) {
        return apiError(409, "checkout_unavailable", "Checkout could not be started.");
      }
      if (binding.checkoutUrl) return json({ ok: true, url: binding.checkoutUrl }, 200);
      const remaining = binding.parameters.expiresAt - Math.floor(options.now().getTime() / 1000);
      if (remaining < CHECKOUT_CREATION_MARGIN_SECONDS) {
        // A lost provider response may hide a live session. Do not rotate its key or mutate
        // its parameters to extend expiry. Known finalized URLs were safely returned above.
        return apiError(409, "checkout_in_progress", "Please wait before starting another checkout.", {
          "retry-after": String(Math.max(1, remaining)),
        });
      }
      const checkout = await options.stripe.createCheckout(binding.parameters);
      if (
        !(await options.store.finalizeCheckout({
          accountId,
          tier,
          requestHash,
          stripeSessionId: checkout.id,
          checkoutUrl: checkout.url,
          idempotencyKey: reservation.idempotencyKey,
          now: options.now().toISOString(),
        }))
      ) {
        // The account became subscribed/OWNER, was deleted, expired, or lost its exact intent
        // while Stripe was creating the session. Never return the stale URL; invalidate the
        // remote effect before reporting the lost fence.
        await options.stripe.expireCheckout(checkout.id);
        return apiError(409, "checkout_unavailable", "Checkout could not be started.");
      }
      return json({ ok: true, url: checkout.url }, 200);
    },

    async portal(request, accountId) {
      const forbidden = noBrowserWrite(request);
      if (forbidden) return forbidden;
      const body = await requestBody(request);
      if (body instanceof Response) return body;
      if (Object.keys(body).length !== 1 || typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId)) {
        return apiError(400, "invalid_request", "The billing request is not valid.");
      }
      if (!(await rateAllowed(accountId, "portal", 20))) {
        return apiError(429, "rate_limited", "Please wait before trying again.", { "retry-after": "600" });
      }
      const customerId = await options.store.customerForAccount(accountId);
      if (!customerId)
        return apiError(409, "billing_account_unavailable", "Start a subscription before opening billing.");
      const portal = await options.stripe.createPortal({
        customerId,
        returnUrl: PORTAL_RETURN,
        idempotencyKey: `portal_${await sha256Base64Url(`${accountId}:${body.requestId}`)}`,
      });
      return json({ ok: true, url: portal.url }, 200);
    },

    async webhook(request) {
      if (request.headers.has("origin")) return apiError(403, "forbidden", "Browser requests are not accepted.");
      const payload = await rawBody(request);
      if (payload === null) return apiError(413, "payload_too_large", "The webhook payload is not valid.");
      const valid = await verifyStripeSignature(
        payload,
        request.headers.get("stripe-signature"),
        options.webhookSecret,
        Math.floor(options.now().getTime() / 1000),
      );
      if (!valid) return apiError(400, "invalid_signature", "The webhook signature is not valid.");
      let raw: unknown;
      try {
        raw = JSON.parse(payload) as unknown;
      } catch {
        return apiError(400, "invalid_event", "The webhook payload is not valid.");
      }
      const event = object(raw);
      const data = object(event?.data);
      const subject = object(data?.object);
      const eventId = event?.id;
      const eventType = event?.type;
      if (
        typeof eventId !== "string" ||
        !EVENT_ID.test(eventId) ||
        typeof eventType !== "string" ||
        eventType.length > 100
      ) {
        return apiError(400, "invalid_event", "The webhook payload is not valid.");
      }
      if (event?.livemode !== true) {
        return apiError(400, "invalid_event", "The webhook payload is not valid.");
      }
      const handled = HANDLED_EVENTS.has(eventType);
      let subscriptionId: string | null = null;
      if (handled) {
        if (typeof subject?.id !== "string" || !SUBSCRIPTION_ID.test(subject.id)) {
          return apiError(400, "invalid_event", "The webhook payload is not valid.");
        }
        subscriptionId = subject.id;
      }
      const receivedAt = options.now().toISOString();
      const claim = await options.store.claimEvent({
        eventId,
        eventType,
        eventSubject: subscriptionId,
        token: `event_${randomBase64Url(24)}`,
        receivedAt,
        claimExpiresAt: new Date(options.now().getTime() + 60_000).toISOString(),
      });
      if (claim.status === "mismatch") return apiError(400, "invalid_event", "The webhook payload is not valid.");
      if (claim.status === "done") return json({ ok: true, duplicate: true }, 200);
      if (claim.status === "pending") {
        return apiError(409, "billing_sync_busy", "Billing is already being synchronized.", { "retry-after": "30" });
      }
      if (!handled) {
        if (!(await options.store.finishEvent(claim.claim, "ignored", receivedAt))) {
          return apiError(409, "billing_sync_stale", "Billing synchronization will be retried.", {
            "retry-after": "30",
          });
        }
        return json({ ok: true, ignored: true }, 200);
      }
      if (typeof subscriptionId !== "string") {
        return apiError(400, "invalid_event", "The webhook payload is not valid.");
      }
      const lease = await options.store.acquireLease({
        subscriptionId,
        token: `lease_${randomBase64Url(24)}`,
        now: receivedAt,
        expiresAt: new Date(options.now().getTime() + 30_000).toISOString(),
      });
      if (!lease)
        return apiError(409, "billing_sync_busy", "Billing is already being synchronized.", { "retry-after": "30" });
      try {
        // Retrieval failures are transient and must be retried without changing a valid grant.
        const current = await options.stripe.retrieveSubscription(subscriptionId);
        const currentIdentity = identifyStripeSubscription(current);
        let snapshot: StripeSubscriptionSnapshot;
        try {
          snapshot = parseStripeSubscription(current, options.catalog);
        } catch {
          if (
            !(await options.store.revokeInvalidSubscription(
              subscriptionId,
              currentIdentity?.id === subscriptionId ? currentIdentity.customerId : null,
              lease,
              options.now().toISOString(),
            ))
          ) {
            return apiError(409, "billing_sync_stale", "Billing synchronization will be retried.", {
              "retry-after": "30",
            });
          }
          if (!(await options.store.finishEvent(claim.claim, "applied", options.now().toISOString()))) {
            return apiError(409, "billing_sync_stale", "Billing synchronization will be retried.", {
              "retry-after": "30",
            });
          }
          return json({ ok: true }, 200);
        }
        if (snapshot.id !== subscriptionId) {
          if (
            !(await options.store.revokeInvalidSubscription(subscriptionId, null, lease, options.now().toISOString()))
          ) {
            return apiError(409, "billing_sync_stale", "Billing synchronization will be retried.", {
              "retry-after": "30",
            });
          }
          if (!(await options.store.finishEvent(claim.claim, "applied", options.now().toISOString()))) {
            return apiError(409, "billing_sync_stale", "Billing synchronization will be retried.", {
              "retry-after": "30",
            });
          }
          return json({ ok: true }, 200);
        }
        const applied = await options.store.applySubscription(snapshot, lease, options.now().toISOString());
        if (!applied) {
          if (
            !(await options.store.revokeInvalidSubscription(
              subscriptionId,
              snapshot.customerId,
              lease,
              options.now().toISOString(),
            ))
          ) {
            return apiError(409, "billing_sync_stale", "Billing synchronization will be retried.", {
              "retry-after": "30",
            });
          }
        } else {
          for (const sessionId of await options.store.pendingCheckoutInvalidations(subscriptionId)) {
            await options.stripe.retireCheckout(sessionId);
            if (
              !(await options.store.completeCheckoutInvalidation(
                subscriptionId,
                sessionId,
                options.now().toISOString(),
              ))
            ) {
              return apiError(409, "billing_sync_stale", "Billing synchronization will be retried.", {
                "retry-after": "30",
              });
            }
          }
        }
        if (!(await options.store.finishEvent(claim.claim, "applied", options.now().toISOString()))) {
          return apiError(409, "billing_sync_stale", "Billing synchronization will be retried.", {
            "retry-after": "30",
          });
        }
        return json({ ok: true }, 200);
      } finally {
        await options.store.releaseLease(lease);
      }
    },
  };
}
