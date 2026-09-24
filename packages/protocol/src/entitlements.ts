/**
 * The KalCode entitlement model: what an account may use, as issued by the API.
 *
 * The public catalog in `plans.ts` lists what can be bought (Free, Pro, MAX). An *entitlement*
 * is the server-authoritative answer for one account. It adds one tier that is not in the
 * catalog: `owner` — non-billable, non-expiring, never purchasable, granted only by trusted
 * operator tooling against the database (see docs/BILLING.md).
 *
 * Evaluation is pure and identical in TypeScript (here) and Rust (`crates/entitlements`):
 *
 * - `unrestricted === true` grants **every** feature and **unlimited** limits by construction.
 *   Nothing is enumerated for it, so features added in the future are covered automatically.
 * - Otherwise a feature is available only if the signed document lists it, and a limit is the
 *   documented number (`null` = unlimited). Unknown features and missing limits fail closed.
 *
 * Nothing in the client can raise an entitlement: the desktop app only accepts documents signed
 * by the API (Ed25519) and falls back to Free otherwise.
 */

import { getPlan, type PlanId } from "./plans.ts";

/** Every tier an account can hold. `owner` is deliberately not a `PlanId`: it is never sold. */
export type EntitlementTier = PlanId | "owner";

export const ENTITLEMENT_TIERS: readonly EntitlementTier[] = ["free", "pro", "max", "owner"];

/** Features gated by plan today. Adding one here never needs an owner change. */
export const FEATURES = [
  "persistentAgents",
  "multiAgentWorkflows",
  "scheduledAutomations",
  "eventAutomations",
  "advancedMissions",
] as const;
export type FeatureId = (typeof FEATURES)[number];

/** Numeric limits gated by plan today. */
export const LIMITS = ["concurrentThreads"] as const;
export type LimitId = (typeof LIMITS)[number];

/** Current entitlement document format. */
export const ENTITLEMENT_DOCUMENT_VERSION = 1;

/**
 * How long a freshly issued document is valid for (its offline grace). This is *document*
 * validity — the desktop must refresh before it lapses — not subscription expiry. The owner
 * grant itself never expires; only the signed copy of it does.
 */
export const ENTITLEMENT_DOCUMENT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Verifiers reject documents claiming a longer validity than this, whatever the signature. */
export const ENTITLEMENT_MAX_DOCUMENT_LIFETIME_SECONDS = 14 * 24 * 60 * 60;

/** Tolerated clock difference when a document's `issuedAt` is slightly in the future. */
export const ENTITLEMENT_CLOCK_SKEW_SECONDS = 5 * 60;

/**
 * A signed entitlement document's payload. Times are Unix epoch **seconds**.
 * `keyId` names the Ed25519 key that signed it (it must equal the signature header's `kid`).
 */
export interface Entitlement {
  version: typeof ENTITLEMENT_DOCUMENT_VERSION;
  accountId: string;
  tier: EntitlementTier;
  /** True exactly when `tier === "owner"`. Grants everything, including future features. */
  unrestricted: boolean;
  /** Features granted to a restricted tier. Empty (and ignored) when unrestricted. */
  features: readonly string[];
  /** Limits for a restricted tier; `null` = unlimited. Empty (and ignored) when unrestricted. */
  limits: Readonly<Record<string, number | null>>;
  issuedAt: number;
  expiresAt: number;
  keyId: string;
}

/** What a tier grants, independent of account and time. */
export interface TierGrants {
  unrestricted: boolean;
  features: readonly string[];
  limits: Readonly<Record<string, number | null>>;
}

/**
 * The grants for a tier. Free/Pro/MAX derive from the public catalog in `plans.ts` (the single
 * source of truth for prices and plan entitlements). Owner enumerates nothing: it is
 * unrestricted by construction.
 */
export function tierGrants(tier: EntitlementTier): TierGrants {
  if (tier === "owner") {
    return { unrestricted: true, features: [], limits: {} };
  }
  const plan = getPlan(tier).entitlements;
  const flags: Record<FeatureId, boolean> = {
    persistentAgents: plan.persistentAgents,
    multiAgentWorkflows: plan.multiAgentWorkflows,
    scheduledAutomations: plan.automations !== "none",
    eventAutomations: plan.automations === "scheduled_and_event",
    advancedMissions: plan.advancedMissions,
  };
  const limits: Record<LimitId, number | null> = { concurrentThreads: plan.concurrentThreads };
  return { unrestricted: false, features: FEATURES.filter((feature) => flags[feature]), limits };
}

/** True if the entitlement grants `feature`. Unrestricted (owner) grants every feature. */
export function hasFeature(entitlement: TierGrants, feature: FeatureId | (string & {})): boolean {
  if (entitlement.unrestricted) {
    return true;
  }
  return entitlement.features.includes(feature);
}

/**
 * The limit value: a number, or `null` for unlimited. Unrestricted (owner) is always unlimited.
 * A limit a restricted document does not mention is `0` (fail closed).
 */
export function limitFor(entitlement: TierGrants, limit: LimitId | (string & {})): number | null {
  if (entitlement.unrestricted) {
    return null;
  }
  if (!Object.hasOwn(entitlement.limits, limit)) {
    return 0;
  }
  return entitlement.limits[limit] ?? null;
}

export type EntitlementParseResult = { ok: true; value: Entitlement } | { ok: false; reason: string };

const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_ID_LENGTH = 128;
const MAX_ITEMS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validates an untrusted entitlement payload. Mirrors `Entitlement::validate` in
 * `crates/entitlements`; both reject the same documents (shared test vectors). Unknown extra
 * fields are ignored so newer servers stay compatible with older clients.
 */
export function parseEntitlement(value: unknown): EntitlementParseResult {
  const fail = (reason: string): EntitlementParseResult => ({ ok: false, reason });
  if (!isRecord(value)) return fail("not an object");
  const { version, accountId, tier, unrestricted, features, limits, issuedAt, expiresAt, keyId } = value;
  if (version !== ENTITLEMENT_DOCUMENT_VERSION) return fail("unsupported version");
  if (typeof accountId !== "string" || accountId.length === 0 || accountId.length > MAX_ID_LENGTH) {
    return fail("invalid accountId");
  }
  if (typeof tier !== "string" || !(ENTITLEMENT_TIERS as readonly string[]).includes(tier)) {
    return fail("invalid tier");
  }
  if (typeof unrestricted !== "boolean") return fail("invalid unrestricted");
  if (unrestricted !== (tier === "owner")) return fail("unrestricted must be true exactly for owner");
  if (
    !Array.isArray(features) ||
    features.length > MAX_ITEMS ||
    !features.every((f) => typeof f === "string" && f.length > 0 && f.length <= MAX_ID_LENGTH)
  ) {
    return fail("invalid features");
  }
  if (!isRecord(limits) || Object.keys(limits).length > MAX_ITEMS) return fail("invalid limits");
  for (const [name, limit] of Object.entries(limits)) {
    if (name.length === 0 || name.length > MAX_ID_LENGTH) return fail("invalid limits");
    if (limit !== null && !isNonNegativeInteger(limit)) return fail("invalid limits");
  }
  if (!isNonNegativeInteger(issuedAt) || !isNonNegativeInteger(expiresAt)) return fail("invalid times");
  if (expiresAt <= issuedAt) return fail("expiresAt must be after issuedAt");
  if (expiresAt - issuedAt > ENTITLEMENT_MAX_DOCUMENT_LIFETIME_SECONDS) return fail("document lifetime too long");
  if (typeof keyId !== "string" || !KEY_ID.test(keyId)) return fail("invalid keyId");
  return {
    ok: true,
    value: {
      version: ENTITLEMENT_DOCUMENT_VERSION,
      accountId,
      tier: tier as EntitlementTier,
      unrestricted,
      features: [...(features as string[])],
      limits: { ...(limits as Record<string, number | null>) },
      issuedAt,
      expiresAt,
      keyId,
    },
  };
}

/** True for key ids accepted in documents and key sets: 1–64 of `[a-z0-9._-]`, starting alphanumeric. */
export function isValidKeyId(keyId: string): boolean {
  return KEY_ID.test(keyId);
}
