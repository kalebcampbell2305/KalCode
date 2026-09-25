/**
 * Fail-closed mapping between Stripe Price ids and KalCode's public paid tiers.
 *
 * This module does not call Stripe and cannot mutate entitlements. A future verified webhook and
 * checkout route must resolve prices through this catalog rather than accepting a tier from a
 * client or from untrusted Stripe metadata. OWNER and Free deliberately have no price mapping.
 */

import type { PlanId } from "@kalcode/protocol/plans";

export type BillableTier = Exclude<PlanId, "free">;

export interface BillingPriceEnvironment {
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_MAX?: string;
  STRIPE_PRICE_MAX_2X?: string;
}

export type BillingPriceCatalog =
  | {
      ok: true;
      priceForTier: Readonly<Record<BillableTier, string>>;
      tierForPrice: Readonly<Record<string, BillableTier>>;
    }
  | { ok: false; reason: string };

const STRIPE_PRICE_ID = /^price_[A-Za-z0-9_]+$/;

/** Missing, malformed or duplicate ids disable billing resolution completely. */
export function billingPriceCatalog(env: BillingPriceEnvironment): BillingPriceCatalog {
  const priceForTier: Record<BillableTier, string | undefined> = {
    pro: env.STRIPE_PRICE_PRO,
    max: env.STRIPE_PRICE_MAX,
    max2x: env.STRIPE_PRICE_MAX_2X,
  };
  for (const [tier, price] of Object.entries(priceForTier)) {
    if (!price || !STRIPE_PRICE_ID.test(price)) {
      return { ok: false, reason: `missing or invalid Stripe price for ${tier}` };
    }
  }
  const prices = Object.values(priceForTier) as string[];
  if (new Set(prices).size !== prices.length) {
    return { ok: false, reason: "Stripe price ids must be unique" };
  }
  const complete = priceForTier as Record<BillableTier, string>;
  return {
    ok: true,
    priceForTier: complete,
    tierForPrice: Object.fromEntries(
      (Object.entries(complete) as [BillableTier, string][]).map(([tier, price]) => [price, tier]),
    ),
  };
}
