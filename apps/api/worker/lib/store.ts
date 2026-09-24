/**
 * D1 access for the Worker.
 *
 * Entitlements are read-only here: there is no code path from an HTTP request to a tier change.
 * Grants are created and revoked only by trusted operator tooling (`tooling/admin/*`) and, from
 * Z13, by the verified billing webhook (Pro/MAX only — the database refuses billing OWNER).
 *
 * The only table the Worker writes is the KalVoice Request ledger (`kalvoice_requests`), and only
 * for the authenticated caller (tests/unit/source-invariants.test.ts pins this).
 */

export type GrantTier = "pro" | "max" | "owner";
export type GrantSource = "billing" | "grant";

export interface ActiveGrant {
  tier: GrantTier;
  source: GrantSource;
  /** ISO timestamp the grant started (a billing grant's cycle anchor). */
  grantedAt: string;
  /** ISO timestamp, or null for grants without an end (always null for owner). */
  expiresAt: string | null;
}

export interface AccountRecord {
  id: string;
  /** ISO timestamp; the cycle anchor when no paid subscription decides the tier. */
  createdAt: string;
}

export interface EntitlementStore {
  account(accountId: string): Promise<AccountRecord | null>;
  /** Grants that are not revoked and have not expired at `nowIso`. */
  activeGrants(accountId: string, nowIso: string): Promise<ActiveGrant[]>;
}

export type RequestSource = "online" | "offline_replay";

export interface RecordRequestInput {
  accountId: string;
  clientRequestId: string;
  recordedAt: string;
  source: RequestSource;
  /** The cycle allowance; null = unlimited. */
  allowance: number | null;
  periodStart: string;
  periodEnd: string;
}

export interface RecordRequestResult {
  /**
   * `recorded`: counted now. `duplicate`: this client request id was already counted (retry or
   * replay). `denied`: online request with the allowance exhausted; nothing was counted.
   */
  outcome: "recorded" | "duplicate" | "denied";
  /** Requests counted in the cycle after this call. */
  used: number;
}

export interface UsageStore {
  countRequests(accountId: string, fromIso: string, toIso: string): Promise<number>;
  recordRequest(input: RecordRequestInput): Promise<RecordRequestResult>;
}

interface GrantRow {
  tier: string;
  source: string;
  granted_at: string;
  expires_at: string | null;
}

const COUNT_IN_PERIOD =
  "SELECT COUNT(*) AS used FROM kalvoice_requests WHERE account_id = ?1 AND recorded_at >= ?2 AND recorded_at < ?3";

/**
 * One statement: the allowance check and the insert are atomic, so concurrent requests cannot
 * both take the last unit. Online requests are inserted only while under the allowance; offline
 * replays (already served on the device) are always recorded, flagged when over the allowance.
 */
const RECORD_REQUEST = `INSERT INTO kalvoice_requests (account_id, client_request_id, recorded_at, source, over_allowance)
SELECT ?1, ?2, ?3, ?4,
  CASE WHEN ?5 IS NOT NULL AND (SELECT COUNT(*) FROM kalvoice_requests WHERE account_id = ?1 AND recorded_at >= ?6 AND recorded_at < ?7) >= ?5 THEN 1 ELSE 0 END
WHERE ?4 = 'offline_replay' OR ?5 IS NULL
  OR (SELECT COUNT(*) FROM kalvoice_requests WHERE account_id = ?1 AND recorded_at >= ?6 AND recorded_at < ?7) < ?5
ON CONFLICT (account_id, client_request_id) DO NOTHING`;

export function d1Store(db: D1Database): EntitlementStore & UsageStore {
  return {
    async account(accountId) {
      const row = await db
        .prepare("SELECT id, created_at FROM accounts WHERE id = ?1")
        .bind(accountId)
        .first<{ id: string; created_at: string }>();
      return row ? { id: row.id, createdAt: row.created_at } : null;
    },

    async activeGrants(accountId, nowIso) {
      const { results } = await db
        .prepare(
          "SELECT tier, source, granted_at, expires_at FROM entitlement_grants WHERE account_id = ?1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?2)",
        )
        .bind(accountId, nowIso)
        .all<GrantRow>();
      return results.flatMap((row): ActiveGrant[] => {
        const { tier, source } = row;
        if ((tier !== "pro" && tier !== "max" && tier !== "owner") || (source !== "billing" && source !== "grant")) {
          return [];
        }
        return [{ tier, source, grantedAt: row.granted_at, expiresAt: row.expires_at }];
      });
    },

    async countRequests(accountId, fromIso, toIso) {
      const row = await db.prepare(COUNT_IN_PERIOD).bind(accountId, fromIso, toIso).first<{ used: number }>();
      return row?.used ?? 0;
    },

    async recordRequest(input) {
      const [inserted, existing, count] = await db.batch([
        db
          .prepare(RECORD_REQUEST)
          .bind(
            input.accountId,
            input.clientRequestId,
            input.recordedAt,
            input.source,
            input.allowance,
            input.periodStart,
            input.periodEnd,
          ),
        db
          .prepare("SELECT 1 AS found FROM kalvoice_requests WHERE account_id = ?1 AND client_request_id = ?2")
          .bind(input.accountId, input.clientRequestId),
        db.prepare(COUNT_IN_PERIOD).bind(input.accountId, input.periodStart, input.periodEnd),
      ]);
      const used = (count?.results[0] as { used: number } | undefined)?.used ?? 0;
      if ((inserted?.meta.changes ?? 0) > 0) return { outcome: "recorded", used };
      if ((existing?.results.length ?? 0) > 0) return { outcome: "duplicate", used };
      return { outcome: "denied", used };
    },
  };
}
