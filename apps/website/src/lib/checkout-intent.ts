/**
 * The plan a visitor chose on /pricing, carried to /account so they never pick it twice:
 * Pricing → CHECK OUT NOW → /account?plan=max&interval=year → sign in if needed → checkout.
 *
 * The intent is only a convenience. The account page validates it against the catalog, the API
 * resolves the Stripe Price from (tier, interval) on the server, and entitlements come only from
 * the backend. Nothing here grants anything.
 *
 * Browser-safe: no Node, Astro or Worker imports.
 */
import { BILLING_INTERVALS, type BillingInterval, PLANS, type PlanId } from "@kalcode/protocol/plans";

export interface CheckoutIntent {
  plan: PlanId;
  interval: BillingInterval;
}

/** localStorage key: shared by every tab of the same browser, so an email link opened in a new tab still sees it. */
export const CHECKOUT_INTENT_KEY = "kalcode:checkout-intent";

/** Long enough to read an email or finish an OAuth round trip; short enough to never surprise anyone later. */
export const CHECKOUT_INTENT_TTL_MS = 60 * 60 * 1000;

function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && PLANS.some((plan) => plan.id === value);
}

function isInterval(value: unknown): value is BillingInterval {
  return typeof value === "string" && (BILLING_INTERVALS as readonly string[]).includes(value);
}

/** Where a plan card's CHECK OUT NOW goes. */
export function checkoutIntentHref(plan: PlanId, interval: BillingInterval): string {
  return `/account?plan=${plan}&interval=${interval}`;
}

/**
 * Reads `?plan=…&interval=…`. Each must appear at most once; the plan must be a public catalog id
 * and the interval `month` or `year` (`month` when absent). Anything else is ignored.
 */
export function parseCheckoutIntent(params: URLSearchParams): CheckoutIntent | null {
  const plans = params.getAll("plan");
  const intervals = params.getAll("interval");
  if (plans.length !== 1 || intervals.length > 1) return null;
  const plan = plans[0];
  const interval = intervals[0] ?? "month";
  return isPlanId(plan) && isInterval(interval) ? { plan, interval } : null;
}

/** The stored form: the intent plus an absolute expiry. */
export function serializeCheckoutIntent(intent: CheckoutIntent, now: number): string {
  return JSON.stringify({ plan: intent.plan, interval: intent.interval, expiresAt: now + CHECKOUT_INTENT_TTL_MS });
}

/** A stored intent, or null when it is missing, malformed or expired. */
export function readCheckoutIntent(raw: string | null, now: number): CheckoutIntent | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value !== "object" ||
      value === null ||
      Object.keys(value).length !== 3 ||
      !isPlanId(value.plan) ||
      !isInterval(value.interval) ||
      typeof value.expiresAt !== "number" ||
      value.expiresAt <= now ||
      value.expiresAt > now + CHECKOUT_INTENT_TTL_MS
    ) {
      return null;
    }
    return { plan: value.plan, interval: value.interval };
  } catch {
    return null;
  }
}

/**
 * sessionStorage key prefix for the Checkout request id of one (plan, interval). The API keys a
 * Checkout reservation by a hash of the request id and returns the same Stripe session for a
 * repeated id, so reusing it lets someone who left Stripe (Back, cancel) click the same plan again
 * and land on that session instead of `409 checkout_in_progress`.
 */
export const CHECKOUT_REQUEST_KEY_PREFIX = "kalcode:checkout-request:";

/** The API's Checkout reservation lifetime; an older id names a reservation that no longer exists. */
export const CHECKOUT_REQUEST_TTL_MS = 35 * 60 * 1000;

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function checkoutRequestKey(plan: PlanId, interval: BillingInterval): string {
  return `${CHECKOUT_REQUEST_KEY_PREFIX}${plan}:${interval}`;
}

/**
 * The request id to send for a Checkout of (plan, interval): the stored one while it is younger
 * than the reservation lifetime, otherwise `create()`, stored for the next click. Blocked or
 * missing storage only loses the reuse; Checkout still starts.
 */
export function checkoutRequestId(
  storage: RequestStorage | null,
  plan: PlanId,
  interval: BillingInterval,
  now: number,
  create: () => string,
): string {
  const key = checkoutRequestKey(plan, interval);
  try {
    const stored = JSON.parse(storage?.getItem(key) ?? "null") as { id?: unknown; createdAt?: unknown } | null;
    if (
      stored &&
      typeof stored.id === "string" &&
      REQUEST_ID.test(stored.id) &&
      typeof stored.createdAt === "number" &&
      stored.createdAt <= now &&
      now - stored.createdAt < CHECKOUT_REQUEST_TTL_MS
    ) {
      return stored.id;
    }
  } catch {
    // Unreadable or malformed: start a new request.
  }
  const id = create();
  try {
    storage?.setItem(key, JSON.stringify({ id, createdAt: now }));
  } catch {
    // Storage blocked: this click still works, the next one starts a new request.
  }
  return id;
}

/** Forgets every stored Checkout request id (a paid plan is active, or the account has one). */
export function forgetCheckoutRequests(storage: RequestStorage | null): void {
  try {
    for (const plan of PLANS) {
      for (const interval of BILLING_INTERVALS) storage?.removeItem(checkoutRequestKey(plan.id, interval));
    }
  } catch {
    // Storage blocked: nothing was stored.
  }
}
