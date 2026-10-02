/**
 * Fail-closed mapping between Stripe Price ids and KalCode's public paid tiers.
 *
 * This module does not call Stripe and cannot mutate entitlements. A future verified webhook and
 * checkout route must resolve prices through this catalog rather than accepting a tier from a
 * client or from untrusted Stripe metadata. OWNER and Free deliberately have no price mapping.
 *
 * Every paid tier has a monthly and a yearly Price. Both resolve to the same tier: the billing
 * interval changes only how often Stripe charges, never what the account is entitled to.
 */

import type { BillingInterval, PlanId } from "@kalcode/protocol/plans";

export type BillableTier = Exclude<PlanId, "free">;
export type { BillingInterval };

export interface BillingPriceEnvironment {
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_MAX?: string;
  STRIPE_PRICE_MAX_2X?: string;
  STRIPE_PRICE_PRO_YEARLY?: string;
  STRIPE_PRICE_MAX_YEARLY?: string;
  STRIPE_PRICE_MAX_2X_YEARLY?: string;
}

export interface BillingPricePlan {
  tier: BillableTier;
  interval: BillingInterval;
}

export type BillingPriceCatalog =
  | {
      ok: true;
      priceFor: Readonly<Record<BillableTier, Readonly<Record<BillingInterval, string>>>>;
      tierForPrice: Readonly<Record<string, BillableTier>>;
      planForPrice: Readonly<Record<string, BillingPricePlan>>;
    }
  | { ok: false; reason: string };

const STRIPE_PRICE_ID = /^price_[A-Za-z0-9_]+$/;

/** Missing, malformed or duplicate ids disable billing resolution completely. */
export function billingPriceCatalog(env: BillingPriceEnvironment): BillingPriceCatalog {
  const configured: Record<BillableTier, Record<BillingInterval, string | undefined>> = {
    pro: { month: env.STRIPE_PRICE_PRO, year: env.STRIPE_PRICE_PRO_YEARLY },
    max: { month: env.STRIPE_PRICE_MAX, year: env.STRIPE_PRICE_MAX_YEARLY },
    max2x: { month: env.STRIPE_PRICE_MAX_2X, year: env.STRIPE_PRICE_MAX_2X_YEARLY },
  };
  const entries: [string, BillingPricePlan][] = [];
  for (const [tier, intervals] of Object.entries(configured) as [
    BillableTier,
    Record<BillingInterval, string | undefined>,
  ][]) {
    for (const [interval, price] of Object.entries(intervals) as [BillingInterval, string | undefined][]) {
      if (!price || !STRIPE_PRICE_ID.test(price)) {
        return { ok: false, reason: `missing or invalid ${interval}ly Stripe price for ${tier}` };
      }
      entries.push([price, { tier, interval }]);
    }
  }
  if (new Set(entries.map(([price]) => price)).size !== entries.length) {
    return { ok: false, reason: "Stripe price ids must be unique" };
  }
  return {
    ok: true,
    priceFor: configured as Record<BillableTier, Record<BillingInterval, string>>,
    tierForPrice: Object.fromEntries(entries.map(([price, plan]) => [price, plan.tier])),
    planForPrice: Object.fromEntries(entries),
  };
}

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === "month" || value === "year";
}
