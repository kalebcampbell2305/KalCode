/**
 * Signed KalVoice Request usage receipts.
 *
 * The API's usage ledger is authoritative. Every usage response carries a receipt signed with the
 * same Ed25519 key as entitlement documents, so the desktop can show usage, remaining allowance
 * and the renewal date, then apply its offline allowance without trusting client-computed limits
 * (docs/BILLING.md §7). The unit is a KalVoice Request — never provider model tokens.
 */

import { ENTITLEMENT_TIERS, type EntitlementTier, isValidKeyId } from "./entitlements.ts";

export const USAGE_RECEIPT_VERSION = 1;

/** A fresh receipt is valid for 72 hours, or until its cycle resets if that is sooner. */
export const USAGE_RECEIPT_TTL_SECONDS = 72 * 60 * 60;

/** Verifiers reject receipts claiming a longer validity than this. */
export const USAGE_RECEIPT_MAX_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

/** Usage in the current cycle. Field names match the `KalVoiceUsage` contract. */
export interface KalVoiceUsageSummary {
  used: number;
  /** Requests allowed per cycle; `null` = unlimited (OWNER). */
  allowance: number | null;
  /** ISO-8601 UTC with milliseconds. */
  periodStart: string;
  /** ISO-8601 UTC with milliseconds; the next cycle starts here. */
  resetsAt: string;
}

export interface UsageReceipt extends KalVoiceUsageSummary {
  version: typeof USAGE_RECEIPT_VERSION;
  accountId: string;
  tier: EntitlementTier;
  /** Unix epoch seconds. */
  issuedAt: number;
  /** Unix epoch seconds. */
  expiresAt: number;
  keyId: string;
}

export type UsageReceiptParseResult = { ok: true; value: UsageReceipt } | { ok: false; reason: string };

const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validates an untrusted receipt payload. Mirrors `UsageReceipt::validate` in `crates/entitlements`. */
export function parseUsageReceipt(value: unknown): UsageReceiptParseResult {
  const fail = (reason: string): UsageReceiptParseResult => ({ ok: false, reason });
  if (!isRecord(value)) return fail("not an object");
  const { version, accountId, tier, used, allowance, periodStart, resetsAt, issuedAt, expiresAt, keyId } = value;
  if (version !== USAGE_RECEIPT_VERSION) return fail("unsupported version");
  if (typeof accountId !== "string" || accountId.length === 0 || accountId.length > 128)
    return fail("invalid accountId");
  if (typeof tier !== "string" || !(ENTITLEMENT_TIERS as readonly string[]).includes(tier)) return fail("invalid tier");
  if (!isCount(used)) return fail("invalid used");
  if (allowance !== null && !isCount(allowance)) return fail("invalid allowance");
  if (tier === "owner" && allowance !== null) return fail("owner allowance must be unlimited");
  if (typeof periodStart !== "string" || !ISO_MILLIS.test(periodStart)) return fail("invalid periodStart");
  if (typeof resetsAt !== "string" || !ISO_MILLIS.test(resetsAt) || resetsAt <= periodStart) {
    return fail("invalid resetsAt");
  }
  if (!isCount(issuedAt) || !isCount(expiresAt) || expiresAt <= issuedAt) return fail("invalid times");
  if (expiresAt - issuedAt > USAGE_RECEIPT_MAX_LIFETIME_SECONDS) return fail("receipt lifetime too long");
  if (typeof keyId !== "string" || !isValidKeyId(keyId)) return fail("invalid keyId");
  return {
    ok: true,
    value: {
      version: USAGE_RECEIPT_VERSION,
      accountId,
      tier: tier as EntitlementTier,
      used,
      allowance,
      periodStart,
      resetsAt,
      issuedAt,
      expiresAt,
      keyId,
    },
  };
}
