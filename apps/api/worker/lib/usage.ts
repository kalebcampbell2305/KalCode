/**
 * KalVoice Request allowances, decided server-side (docs/BILLING.md §7).
 *
 * One top-level request to the KalVoice assistant is one KalVoice Request, however many internal
 * steps it takes. Dictation is never counted and provider model tokens are never counted — this
 * module only ever sees opaque client request ids.
 */

import { type EntitlementTier, limitFor, tierGrants } from "@kalcode/protocol/entitlements";
import {
  type KalVoiceUsageSummary,
  USAGE_RECEIPT_TTL_SECONDS,
  USAGE_RECEIPT_VERSION,
  type UsageReceipt,
} from "@kalcode/protocol/usage-receipts";
import { resolveEntitlement } from "./entitlement";
import { type Period, periodContaining } from "./period";
import type { AccountRecord, EntitlementStore } from "./store";

export const KALVOICE_LIMIT = "kalvoiceRequestsPerMonth";

/** Opaque, client-generated idempotency key (e.g. a UUID). Never request text. */
export const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

export interface UsageContext {
  accountId: string;
  tier: EntitlementTier;
  /** Requests per cycle; null = unlimited (OWNER never has a number here). */
  allowance: number | null;
  period: Period;
}

export async function usageContext(store: EntitlementStore, account: AccountRecord, now: Date): Promise<UsageContext> {
  const resolved = await resolveEntitlement(store, account.id, now);
  const allowance = limitFor(tierGrants(resolved.tier), KALVOICE_LIMIT);
  const anchor = new Date(resolved.billingAnchor ?? account.createdAt);
  return { accountId: account.id, tier: resolved.tier, allowance, period: periodContaining(anchor, now) };
}

export function usageSummary(context: UsageContext, used: number): KalVoiceUsageSummary {
  return {
    used,
    allowance: context.allowance,
    periodStart: context.period.start.toISOString(),
    resetsAt: context.period.end.toISOString(),
  };
}

/** A receipt valid for `USAGE_RECEIPT_TTL_SECONDS`, or until the cycle resets if sooner. */
export function buildUsageReceipt(context: UsageContext, used: number, now: Date, keyId: string): UsageReceipt {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const resetsAt = Math.floor(context.period.end.getTime() / 1000);
  const expiresAt = Math.max(issuedAt + 1, Math.min(issuedAt + USAGE_RECEIPT_TTL_SECONDS, resetsAt));
  return {
    version: USAGE_RECEIPT_VERSION,
    accountId: context.accountId,
    tier: context.tier,
    ...usageSummary(context, used),
    issuedAt,
    expiresAt,
    keyId,
  };
}
