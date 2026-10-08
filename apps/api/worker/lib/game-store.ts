/**
 * The canonical store for KalCode games (migration 0012): ownership, the payments behind it, perk
 * claims, device sign-in and game license sessions. Every write for these tables lives here
 * (tests/unit/source-invariants.test.ts).
 *
 * The database itself refuses ownership without a counting payment and revocation while one remains,
 * so the policy below cannot be bypassed by a bug elsewhere.
 */

import type { GameId, GameOwnershipSource, GamePerk, GamePerkTier } from "@kalcode/protocol/games";

export type GamePaymentStatus = "paid" | "refunded_late" | "refunded" | "fraud" | "dispute_lost";
export type GameRevocationReason = "refund" | "fraud" | "dispute_lost";
export type PaidSource = Exclude<GameOwnershipSource, "owner">;

export interface GameOwnership {
  gameId: GameId;
  source: PaidSource;
  grantedAt: string;
  status: "active" | "revoked";
  revokedAt: string | null;
  revokedReason: GameRevocationReason | null;
}

export interface GamePerkClaim {
  perkId: string;
  tier: Exclude<GamePerkTier, "standalone">;
  claimedAt: string;
}

export interface QualifyingPayment {
  paymentRef: string;
  paymentIntent: string;
  accountId: string;
  gameId: GameId;
  source: PaidSource;
  amountCents: number;
  currency: string;
  paidAt: string;
}

export type DeviceTokenState =
  | { state: "invalid" }
  | { state: "expired" }
  | { state: "slow_down" }
  | { state: "pending" }
  | { state: "consumed" }
  | { state: "approved"; accountId: string; gameId: GameId; deviceHash: string | null };

export type GameRateAction =
  | "device_start"
  | "device_poll"
  | "device_approve"
  | "license_refresh"
  | "checkout"
  | "download";

/** Status precedence: a payment's status only ever moves to a stronger one. */
const STATUS_RANK: Readonly<Record<GamePaymentStatus, number>> = {
  paid: 0,
  refunded_late: 1,
  refunded: 2,
  fraud: 3,
  dispute_lost: 3,
};

const REVOCATION_REASON: Readonly<Record<Exclude<GamePaymentStatus, "paid" | "refunded_late">, GameRevocationReason>> =
  {
    refunded: "refund",
    fraud: "fraud",
    dispute_lost: "dispute_lost",
  };

const COUNTING = "('paid', 'refunded_late')";

export function d1GameStore(db: D1Database) {
  /** Revokes ownership in the same batch when no counting payment remains (the trigger re-checks). */
  const revokeIfUncovered = (accountId: string, gameId: GameId, reason: GameRevocationReason, now: string) =>
    db
      .prepare(
        `UPDATE game_entitlements SET status = 'revoked', revoked_at = ?3, revoked_reason = ?4, updated_at = ?3
         WHERE account_id = ?1 AND game_id = ?2 AND status = 'active' AND NOT EXISTS (
           SELECT 1 FROM game_payments
           WHERE account_id = ?1 AND game_id = ?2 AND status IN ${COUNTING}
         )`,
      )
      .bind(accountId, gameId, now, reason);

  const accountIsLive = async (accountId: string): Promise<boolean> => {
    const row = await db
      .prepare("SELECT 1 AS live FROM accounts WHERE id = ?1 AND deleted_at IS NULL")
      .bind(accountId)
      .first();
    return row !== null;
  };

  const paymentByIntent = async (
    paymentIntent: string,
  ): Promise<{ accountId: string; gameId: GameId; paidAt: string; status: GamePaymentStatus } | null> => {
    const row = await db
      .prepare("SELECT account_id, game_id, paid_at, status FROM game_payments WHERE payment_intent = ?1")
      .bind(paymentIntent)
      .first<{ account_id: string; game_id: GameId; paid_at: string; status: GamePaymentStatus }>();
    return row ? { accountId: row.account_id, gameId: row.game_id, paidAt: row.paid_at, status: row.status } : null;
  };

  /** Moves a payment to a stronger status only (never back). */
  const statusStatements = (paymentIntent: string, status: GamePaymentStatus, now: string): D1PreparedStatement[] => {
    const weaker = (Object.entries(STATUS_RANK) as [GamePaymentStatus, number][])
      .filter(([, rank]) => rank < STATUS_RANK[status])
      .map(([name]) => `'${name}'`);
    if (weaker.length === 0) return [];
    return [
      db
        .prepare(
          `UPDATE game_payments SET status = ?2, status_at = ?3
           WHERE payment_intent = ?1 AND status IN (${weaker.join(", ")})`,
        )
        .bind(paymentIntent, status, now),
    ];
  };

  return {
    /** The live account behind a Stripe customer, from the canonical billing mapping (read only). */
    async accountForCustomer(customerId: string): Promise<string | null> {
      const row = await db
        .prepare(
          `SELECT c.account_id FROM billing_customers c JOIN accounts a ON a.id = c.account_id
           WHERE c.stripe_customer_id = ?1 AND a.deleted_at IS NULL`,
        )
        .bind(customerId)
        .first<{ account_id: string }>();
      return row?.account_id ?? null;
    },

    async customerForAccount(accountId: string): Promise<string | null> {
      const row = await db
        .prepare("SELECT stripe_customer_id FROM billing_customers WHERE account_id = ?1")
        .bind(accountId)
        .first<{ stripe_customer_id: string | null }>();
      return row?.stripe_customer_id ?? null;
    },

    async accountEmail(accountId: string): Promise<string | null> {
      const row = await db
        .prepare("SELECT email FROM accounts WHERE id = ?1 AND deleted_at IS NULL")
        .bind(accountId)
        .first<{ email: string }>();
      return row?.email ?? null;
    },

    accountIsLive,

    async ownership(accountId: string, gameId: GameId): Promise<GameOwnership | null> {
      const row = await db
        .prepare(
          `SELECT e.game_id, e.source, e.granted_at, e.status, e.revoked_at, e.revoked_reason
           FROM game_entitlements e JOIN accounts a ON a.id = e.account_id
           WHERE e.account_id = ?1 AND e.game_id = ?2 AND a.deleted_at IS NULL`,
        )
        .bind(accountId, gameId)
        .first<{
          game_id: GameId;
          source: PaidSource;
          granted_at: string;
          status: "active" | "revoked";
          revoked_at: string | null;
          revoked_reason: GameRevocationReason | null;
        }>();
      return row
        ? {
            gameId: row.game_id,
            source: row.source,
            grantedAt: row.granted_at,
            status: row.status,
            revokedAt: row.revoked_at,
            revokedReason: row.revoked_reason,
          }
        : null;
    },

    paymentByIntent,

    /**
     * Records a qualifying payment with its current status (from Stripe, so an out-of-order refund is
     * never lost) and grants or restores ownership when it counts — all in one D1 batch. Idempotent:
     * replaying the same payment changes nothing.
     */
    async recordPayment(payment: QualifyingPayment, status: GamePaymentStatus, now: string): Promise<boolean> {
      const live = await accountIsLive(payment.accountId);
      if (!live) return false;
      const statements = [
        db
          .prepare(
            `INSERT INTO game_payments
               (payment_ref, payment_intent, account_id, game_id, source, amount_cents, currency, paid_at, status, status_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (payment_ref) DO NOTHING`,
          )
          .bind(
            payment.paymentRef,
            payment.paymentIntent,
            payment.accountId,
            payment.gameId,
            payment.source,
            payment.amountCents,
            payment.currency,
            payment.paidAt,
            status,
            now,
          ),
        ...statusStatements(payment.paymentIntent, status, now),
        db
          .prepare(
            `INSERT INTO game_entitlements
               (account_id, game_id, source, granted_at, granting_payment_ref, status, updated_at)
             SELECT p.account_id, p.game_id, p.source, ?3, p.payment_ref, 'active', ?3
             FROM game_payments p JOIN accounts a ON a.id = p.account_id
             WHERE p.payment_ref = ?1 AND p.account_id = ?2 AND p.status IN ${COUNTING} AND a.deleted_at IS NULL
             ON CONFLICT (account_id, game_id) DO UPDATE SET
               status = 'active', revoked_at = NULL, revoked_reason = NULL,
               source = excluded.source, granted_at = excluded.granted_at,
               granting_payment_ref = excluded.granting_payment_ref, updated_at = excluded.updated_at
             WHERE game_entitlements.status = 'revoked'`,
          )
          .bind(payment.paymentRef, payment.accountId, payment.paidAt > now ? now : payment.paidAt),
      ];
      if (status !== "paid" && status !== "refunded_late") {
        statements.push(revokeIfUncovered(payment.accountId, payment.gameId, REVOCATION_REASON[status], now));
      }
      await db.batch(statements);
      return true;
    },

    /**
     * Applies a refund, fraud or lost-dispute status to a recorded payment and revokes ownership
     * if nothing else counts. Returns false when the payment is unknown (it is reconciled when its
     * paid event arrives, because recording always reads the current status).
     */
    async applyPaymentStatus(paymentIntent: string, status: GamePaymentStatus, now: string): Promise<boolean> {
      const payment = await paymentByIntent(paymentIntent);
      if (!payment) return false;
      const statements = statusStatements(paymentIntent, status, now);
      if (status !== "paid" && status !== "refunded_late") {
        statements.push(revokeIfUncovered(payment.accountId, payment.gameId, REVOCATION_REASON[status], now));
      }
      if (statements.length > 0) await db.batch(statements);
      return true;
    },

    /** Claims every listed perk the account has not claimed yet. Returns all of the account's claims. */
    async claimPerks(
      accountId: string,
      gameId: GameId,
      perks: readonly GamePerk[],
      now: string,
    ): Promise<GamePerkClaim[]> {
      const inserts = perks.map((perk) =>
        db
          .prepare(
            `INSERT INTO game_perk_claims (account_id, game_id, perk_id, tier, claimed_at)
             SELECT id, ?2, ?3, ?4, ?5 FROM accounts WHERE id = ?1 AND deleted_at IS NULL
             ON CONFLICT (account_id, game_id, perk_id) DO NOTHING`,
          )
          .bind(accountId, gameId, perk.id, perk.tier, now),
      );
      if (inserts.length > 0) await db.batch(inserts);
      const rows = await db
        .prepare(
          `SELECT perk_id, tier, claimed_at FROM game_perk_claims
           WHERE account_id = ?1 AND game_id = ?2 ORDER BY claimed_at, perk_id`,
        )
        .bind(accountId, gameId)
        .all<{ perk_id: string; tier: GamePerkClaim["tier"]; claimed_at: string }>();
      return rows.results.map((row) => ({ perkId: row.perk_id, tier: row.tier, claimedAt: row.claimed_at }));
    },

    async recordedEvent(eventId: string): Promise<boolean> {
      const row = await db
        .prepare("SELECT 1 AS seen FROM game_webhook_events WHERE event_id = ?1")
        .bind(eventId)
        .first();
      return row !== null;
    },

    async finishEvent(eventId: string, eventType: string, result: "applied" | "ignored", now: string): Promise<void> {
      await db
        .prepare(
          `INSERT INTO game_webhook_events (event_id, event_type, received_at, result) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (event_id) DO NOTHING`,
        )
        .bind(eventId, eventType, now, result)
        .run();
    },

    async allow(input: {
      bucket: string;
      action: GameRateAction;
      now: string;
      windowStart: string;
      retentionStart: string;
      limit: number;
    }): Promise<boolean> {
      const [, result] = await db.batch([
        db.prepare("DELETE FROM game_rate_limits WHERE window_started_at < ?1").bind(input.retentionStart),
        db
          .prepare(
            `INSERT INTO game_rate_limits (bucket, action, window_started_at, request_count) VALUES (?1, ?2, ?3, 1)
             ON CONFLICT (bucket, action) DO UPDATE SET
               window_started_at = CASE WHEN window_started_at < ?4 THEN ?3 ELSE window_started_at END,
               request_count = CASE WHEN window_started_at < ?4 THEN 1 ELSE MIN(request_count + 1, 100000) END
             RETURNING request_count`,
          )
          .bind(input.bucket, input.action, input.now, input.windowStart),
      ]);
      const row = result?.results[0] as { request_count: number } | undefined;
      return row !== undefined && row.request_count <= input.limit;
    },

    /** Stores a new device authorization. False on a (rare) user-code collision: retry with a new code. */
    async createDeviceAuthorization(input: {
      deviceCodeHash: string;
      userCodeHash: string;
      gameId: GameId;
      deviceHash: string | null;
      now: string;
      expiresAt: string;
    }): Promise<boolean> {
      const [, insert] = await db.batch([
        db.prepare("DELETE FROM game_device_authorizations WHERE expires_at <= ?1").bind(input.now),
        db
          .prepare(
            `INSERT INTO game_device_authorizations
               (device_code_hash, user_code_hash, game_id, device_hash, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING`,
          )
          .bind(input.deviceCodeHash, input.userCodeHash, input.gameId, input.deviceHash, input.now, input.expiresAt),
      ]);
      return (insert?.meta.changes ?? 0) === 1;
    },

    /** Binds a pending, unexpired code to the approving live account. */
    async approveDevice(userCodeHash: string, accountId: string, now: string): Promise<"approved" | "invalid"> {
      const result = await db
        .prepare(
          `UPDATE game_device_authorizations SET approved_at = ?3, account_id = ?2
           WHERE user_code_hash = ?1 AND approved_at IS NULL AND expires_at > ?3
             AND EXISTS (SELECT 1 FROM accounts WHERE id = ?2 AND deleted_at IS NULL)`,
        )
        .bind(userCodeHash, accountId, now)
        .run();
      return (result.meta.changes ?? 0) === 1 ? "approved" : "invalid";
    },

    /**
     * One poll of the game. Approved codes are consumed exactly once (compare-and-set); polling
     * faster than `intervalSeconds` answers slow_down.
     */
    async pollDevice(deviceCodeHash: string, now: string, intervalSeconds: number): Promise<DeviceTokenState> {
      const row = await db
        .prepare(
          `SELECT d.game_id, d.device_hash, d.expires_at, d.last_polled_at, d.approved_at, d.account_id, d.consumed_at,
                  a.deleted_at
           FROM game_device_authorizations d LEFT JOIN accounts a ON a.id = d.account_id
           WHERE d.device_code_hash = ?1`,
        )
        .bind(deviceCodeHash)
        .first<{
          game_id: GameId;
          device_hash: string | null;
          expires_at: string;
          last_polled_at: string | null;
          approved_at: string | null;
          account_id: string | null;
          consumed_at: string | null;
          deleted_at: string | null;
        }>();
      if (!row) return { state: "invalid" };
      if (row.consumed_at) return { state: "consumed" };
      if (row.expires_at <= now) return { state: "expired" };
      const tooSoon =
        row.last_polled_at !== null && Date.parse(now) - Date.parse(row.last_polled_at) < intervalSeconds * 1000 - 250;
      await db
        .prepare("UPDATE game_device_authorizations SET last_polled_at = ?2 WHERE device_code_hash = ?1")
        .bind(deviceCodeHash, now)
        .run();
      if (tooSoon) return { state: "slow_down" };
      if (!row.approved_at || !row.account_id || row.deleted_at) return { state: "pending" };
      const consumed = await db
        .prepare(
          `UPDATE game_device_authorizations SET consumed_at = ?2
           WHERE device_code_hash = ?1 AND consumed_at IS NULL AND approved_at IS NOT NULL`,
        )
        .bind(deviceCodeHash, now)
        .run();
      if ((consumed.meta.changes ?? 0) !== 1) return { state: "consumed" };
      return { state: "approved", accountId: row.account_id, gameId: row.game_id, deviceHash: row.device_hash };
    },

    async createLicenseSession(input: {
      tokenHash: string;
      accountId: string;
      gameId: GameId;
      deviceHash: string | null;
      now: string;
      expiresAt: string;
    }): Promise<boolean> {
      const result = await db
        .prepare(
          `INSERT INTO game_license_sessions
             (token_hash, account_id, game_id, device_hash, created_at, last_used_at, expires_at)
           SELECT ?1, id, ?3, ?4, ?5, ?5, ?6 FROM accounts WHERE id = ?2 AND deleted_at IS NULL`,
        )
        .bind(input.tokenHash, input.accountId, input.gameId, input.deviceHash, input.now, input.expiresAt)
        .run();
      return (result.meta.changes ?? 0) === 1;
    },

    /** An active session of a live account, extended (sliding) on use. */
    async useLicenseSession(
      tokenHash: string,
      now: string,
      expiresAt: string,
    ): Promise<{ accountId: string; gameId: GameId; deviceHash: string | null } | null> {
      const row = await db
        .prepare(
          `UPDATE game_license_sessions SET last_used_at = ?2, expires_at = ?3
           WHERE token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2
             AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = game_license_sessions.account_id AND a.deleted_at IS NULL)
           RETURNING account_id, game_id, device_hash`,
        )
        .bind(tokenHash, now, expiresAt)
        .first<{ account_id: string; game_id: GameId; device_hash: string | null }>();
      return row ? { accountId: row.account_id, gameId: row.game_id, deviceHash: row.device_hash } : null;
    },

    async endLicenseSession(tokenHash: string, now: string): Promise<void> {
      await db
        .prepare("UPDATE game_license_sessions SET revoked_at = ?2 WHERE token_hash = ?1 AND revoked_at IS NULL")
        .bind(tokenHash, now)
        .run();
    },
  };
}

export type GameStore = ReturnType<typeof d1GameStore>;
