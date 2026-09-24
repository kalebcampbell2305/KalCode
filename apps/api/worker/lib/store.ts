/**
 * Read-only access to accounts and entitlement grants.
 *
 * The Worker never writes grants: there is no code path from an HTTP request to a tier change.
 * Grants are created and revoked only by trusted operator tooling (`tooling/admin/*`) and, from
 * Z13, by the verified billing webhook (Pro/MAX only — the database refuses billing OWNER).
 */

export type GrantTier = "pro" | "max" | "owner";
export type GrantSource = "billing" | "grant";

export interface ActiveGrant {
  tier: GrantTier;
  source: GrantSource;
  /** ISO timestamp, or null for grants without an end (always null for owner). */
  expiresAt: string | null;
}

export interface EntitlementStore {
  accountExists(accountId: string): Promise<boolean>;
  /** Grants that are not revoked and have not expired at `nowIso`. */
  activeGrants(accountId: string, nowIso: string): Promise<ActiveGrant[]>;
}

interface GrantRow {
  tier: string;
  source: string;
  expires_at: string | null;
}

export function d1Store(db: D1Database): EntitlementStore {
  return {
    async accountExists(accountId) {
      const row = await db
        .prepare("SELECT 1 AS found FROM accounts WHERE id = ?1")
        .bind(accountId)
        .first<{ found: number }>();
      return row !== null;
    },
    async activeGrants(accountId, nowIso) {
      const { results } = await db
        .prepare(
          "SELECT tier, source, expires_at FROM entitlement_grants WHERE account_id = ?1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?2)",
        )
        .bind(accountId, nowIso)
        .all<GrantRow>();
      return results.flatMap((row): ActiveGrant[] => {
        const tier = row.tier;
        const source = row.source;
        if ((tier !== "pro" && tier !== "max" && tier !== "owner") || (source !== "billing" && source !== "grant")) {
          return [];
        }
        return [{ tier, source, expiresAt: row.expires_at }];
      });
    },
  };
}
