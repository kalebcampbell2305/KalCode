/** Server-side entitlement resolution: the only place an account's tier is decided. */

import {
  ENTITLEMENT_DOCUMENT_TTL_SECONDS,
  ENTITLEMENT_DOCUMENT_VERSION,
  type Entitlement,
  type EntitlementTier,
  tierGrants,
} from "@kalcode/protocol/entitlements";
import type { ActiveGrant, EntitlementStore } from "./store";

export interface ResolvedEntitlement {
  tier: EntitlementTier;
  /** When the deciding grant ends (ISO), or null if it has no end (owner, free, open grants). */
  grantExpiresAt: string | null;
  /**
   * Start of the deciding paid subscription (ISO) — the KalVoice cycle anchor — or null when no
   * billing grant decides the tier (the account's creation time is the anchor then).
   */
  billingAnchor: string | null;
}

const RANK: Readonly<Record<EntitlementTier, number>> = { free: 0, pro: 1, max: 2, max2x: 3, owner: 4 };

/**
 * Precedence: an active OWNER operator grant, then the highest active public paid grant (billing or
 * operator), then Free. An `owner` row with any source other than `grant` is ignored — the
 * database already refuses such rows; this is defence in depth.
 */
export function pickEntitlement(grants: readonly ActiveGrant[]): ResolvedEntitlement {
  let best: ResolvedEntitlement = { tier: "free", grantExpiresAt: null, billingAnchor: null };
  for (const grant of grants) {
    if (grant.tier === "owner" && grant.source !== "grant") continue;
    const candidate: ResolvedEntitlement = {
      tier: grant.tier,
      grantExpiresAt: grant.tier === "owner" ? null : grant.expiresAt,
      billingAnchor: grant.source === "billing" ? grant.grantedAt : null,
    };
    const better =
      RANK[candidate.tier] > RANK[best.tier] ||
      (candidate.tier === best.tier && laterEnd(candidate.grantExpiresAt, best.grantExpiresAt));
    if (better) best = candidate;
  }
  return best;
}

/** True if `a` ends later than `b` (null = never ends). */
function laterEnd(a: string | null, b: string | null): boolean {
  if (b === null) return false;
  if (a === null) return true;
  return a > b;
}

export async function resolveEntitlement(
  store: EntitlementStore,
  accountId: string,
  now: Date,
): Promise<ResolvedEntitlement> {
  return pickEntitlement(await store.activeGrants(accountId, now.toISOString()));
}

/**
 * The document to sign. It is valid for `ENTITLEMENT_DOCUMENT_TTL_SECONDS` (the desktop's
 * offline grace), or until the deciding grant ends if that is sooner. OWNER documents still
 * expire and are re-issued — the grant never expires, only its signed snapshot does.
 */
export function buildEntitlement(
  accountId: string,
  resolved: ResolvedEntitlement,
  now: Date,
  keyId: string,
): Entitlement {
  const issuedAt = Math.floor(now.getTime() / 1000);
  let expiresAt = issuedAt + ENTITLEMENT_DOCUMENT_TTL_SECONDS;
  if (resolved.grantExpiresAt !== null) {
    const grantEnd = Math.floor(Date.parse(resolved.grantExpiresAt) / 1000);
    if (Number.isFinite(grantEnd)) expiresAt = Math.max(issuedAt + 1, Math.min(expiresAt, grantEnd));
  }
  const grants = tierGrants(resolved.tier);
  return {
    version: ENTITLEMENT_DOCUMENT_VERSION,
    accountId,
    tier: resolved.tier,
    unrestricted: grants.unrestricted,
    features: grants.features,
    limits: grants.limits,
    issuedAt,
    expiresAt,
    keyId,
  };
}
