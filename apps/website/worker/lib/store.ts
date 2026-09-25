/**
 * Persistence for the early-access list with double opt-in (migrations 0001 and 0002,
 * docs/DATA_MODEL.md §3). The interface lets unit tests use an in-memory fake; the D1
 * implementation is exercised against local D1 in tests/unit/store-d1.test.ts.
 *
 * Every operation that must not race is a single SQL statement or one D1 batch (a transaction):
 * the throttle and budget claims are conditional writes, and links are consumed by a statement
 * that deletes them, so a link can succeed at most once.
 */

export type SubscriberStatus = "pending" | "confirmed" | "legacy_unconfirmed";
export type TokenPurpose = "confirm" | "remove";

export interface Subscriber {
  id: number;
  status: SubscriberStatus;
}

export interface NewSignup {
  email: string;
  source: string | null;
  createdAt: string;
  consentVersion: string;
}

export interface TokenRecord {
  hash: string;
  subscriberId: number;
  purpose: TokenPurpose;
  createdAt: string;
  expiresAt: string;
}

export interface ThrottlePolicy {
  minIntervalMs: number;
  dailyPerAddress: number;
}

/** What a successful per-address claim replaced, so a failed send can give the slot back. */
export interface AddressClaim {
  subscriberId: number;
  claimedAt: string;
  previous: { lastEmailAt: string | null; emailDay: string | null; emailDayCount: number };
}

export type EmailAdmissionState = "claimed" | "sent" | "ambiguous" | "rejected";

export interface MarketingSendClaim {
  claimId: string;
  day: string;
}

export const EMAIL_ADMISSION_LIMITS = {
  hardDaily: 90,
  marketingDaily: 60,
  nonDeletionDaily: 80,
  accountNetworkPerPurposeDaily: 20,
  accountRecipientPerPurposeDaily: 5,
} as const;

/** A lower emergency limit preserves the same account/deletion reserves. */
export function emailAdmissionCaps(configuredLimit: number) {
  const hard = Number.isInteger(configuredLimit)
    ? Math.min(Math.max(configuredLimit, 0), EMAIL_ADMISSION_LIMITS.hardDaily)
    : 0;
  return {
    hard,
    marketing: Math.min(EMAIL_ADMISSION_LIMITS.marketingDaily, Math.max(0, hard - 30)),
    nonDeletion: Math.min(EMAIL_ADMISSION_LIMITS.nonDeletionDaily, Math.max(0, hard - 10)),
  } as const;
}

export interface EarlyAccessStore {
  /**
   * Deletes expired links, pending sign-ups older than `pendingCutoff` that have no live
   * confirmation link, and budget rows from earlier days.
   */
  purgeExpired(now: Date, pendingCutoff: Date): Promise<void>;
  find(email: string): Promise<Subscriber | null>;
  /**
   * Adds a pending sign-up. An existing, unconfirmed address keeps its row (and status) but takes
   * the current consent version; a confirmed one is untouched. `created` is true only when this
   * call inserted the row.
   */
  addPending(signup: NewSignup): Promise<{ subscriber: Subscriber; created: boolean }>;
  /** Deletes a row this request created, if it is still pending (used to undo a failed send). */
  deleteCreated(subscriberId: number): Promise<void>;
  /** Reserves one email to this address if the throttle allows; null when it does not. */
  claimAddressSend(subscriberId: number, now: Date, policy: ThrottlePolicy): Promise<AddressClaim | null>;
  releaseAddressSend(claim: AddressClaim): Promise<void>;
  /** Reserves one marketing email while preserving the account and deletion lanes. */
  claimMarketingSend(now: Date, limit: number): Promise<MarketingSendClaim | null>;
  /** Definite rejection refunds the claim; sent and ambiguous outcomes retain it. */
  finalizeMarketingSend(claim: MarketingSendClaim, state: Exclude<EmailAdmissionState, "claimed">): Promise<void>;
  addTokens(tokens: TokenRecord[]): Promise<void>;
  deleteTokens(hashes: string[]): Promise<void>;
  /**
   * Uses a confirmation link: deletes it and, if it had not expired, marks its address confirmed
   * and deletes the address's other confirmation links. True if confirmed.
   */
  confirmByToken(hash: string, now: Date): Promise<boolean>;
  /**
   * Uses a removal link: deletes it and, if it had not expired, deletes its address and all of
   * the address's links permanently. True if an address was removed.
   */
  removeByToken(hash: string, now: Date): Promise<boolean>;
}

/** UTC calendar day, `YYYY-MM-DD`. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The throttle rule, shared by the D1 store and the in-memory fake. */
export function throttleAllows(
  previous: AddressClaim["previous"],
  now: Date,
  policy: ThrottlePolicy,
): { allowed: boolean; nextCount: number } {
  const day = utcDay(now);
  const countToday = previous.emailDay === day ? previous.emailDayCount : 0;
  const recent =
    previous.lastEmailAt !== null && now.getTime() - Date.parse(previous.lastEmailAt) < policy.minIntervalMs;
  return { allowed: !recent && countToday < policy.dailyPerAddress, nextCount: countToday + 1 };
}

interface ThrottleRow {
  last_email_at: string | null;
  email_day: string | null;
  email_day_count: number;
}

/**
 * Deletes one link and returns what it pointed at. The delete is the use: two concurrent
 * requests with the same code cannot both get the row back.
 */
async function consumeToken(
  db: D1Database,
  hash: string,
  purpose: TokenPurpose,
): Promise<{ early_access_id: number; expires_at: string } | null> {
  return db
    .prepare(
      "DELETE FROM early_access_tokens WHERE token_hash = ?1 AND purpose = ?2 RETURNING early_access_id, expires_at",
    )
    .bind(hash, purpose)
    .first<{ early_access_id: number; expires_at: string }>();
}

export function d1Store(db: D1Database): EarlyAccessStore {
  return {
    async purgeExpired(now, pendingCutoff) {
      const nowIso = now.toISOString();
      await db.batch([
        db.prepare("DELETE FROM early_access_tokens WHERE expires_at <= ?1").bind(nowIso),
        db
          .prepare(
            "DELETE FROM early_access WHERE status = 'pending' AND created_at <= ?1 AND NOT EXISTS (" +
              "SELECT 1 FROM early_access_tokens t WHERE t.early_access_id = early_access.id AND t.purpose = 'confirm')",
          )
          .bind(pendingCutoff.toISOString()),
        db.prepare("DELETE FROM email_send_budget WHERE day < ?1").bind(utcDay(now)),
        db.prepare("DELETE FROM marketing_email_dispatches WHERE claimed_day < ?1").bind(utcDay(now)),
      ]);
    },

    async find(email) {
      const row = await db
        .prepare("SELECT id, status FROM early_access WHERE email = ?1")
        .bind(email)
        .first<{ id: number; status: SubscriberStatus }>();
      return row ? { id: row.id, status: row.status } : null;
    },

    async addPending(signup) {
      const inserted = await db
        .prepare(
          "INSERT INTO early_access (email, created_at, source, consent_version, status) VALUES (?1, ?2, ?3, ?4, 'pending') " +
            "ON CONFLICT(email) DO NOTHING RETURNING id, status",
        )
        .bind(signup.email, signup.createdAt, signup.source, signup.consentVersion)
        .first<{ id: number; status: SubscriberStatus }>();
      if (inserted) return { subscriber: { id: inserted.id, status: inserted.status }, created: true };

      const existing = await db
        .prepare(
          "UPDATE early_access SET consent_version = CASE WHEN status = 'confirmed' THEN consent_version ELSE ?2 END " +
            "WHERE email = ?1 RETURNING id, status",
        )
        .bind(signup.email, signup.consentVersion)
        .first<{ id: number; status: SubscriberStatus }>();
      if (!existing) throw new Error("early_access row vanished during sign-up");
      return { subscriber: { id: existing.id, status: existing.status }, created: false };
    },

    async deleteCreated(subscriberId) {
      await db.batch([
        db.prepare("DELETE FROM early_access_tokens WHERE early_access_id = ?1").bind(subscriberId),
        db.prepare("DELETE FROM early_access WHERE id = ?1 AND status = 'pending'").bind(subscriberId),
      ]);
    },

    async claimAddressSend(subscriberId, now, policy) {
      const row = await db
        .prepare("SELECT last_email_at, email_day, email_day_count FROM early_access WHERE id = ?1")
        .bind(subscriberId)
        .first<ThrottleRow>();
      if (!row) return null;
      const previous = { lastEmailAt: row.last_email_at, emailDay: row.email_day, emailDayCount: row.email_day_count };
      const { allowed, nextCount } = throttleAllows(previous, now, policy);
      if (!allowed) return null;
      const claimedAt = now.toISOString();
      // Optimistic concurrency: only succeeds if nobody claimed since the read above.
      const result = await db
        .prepare(
          "UPDATE early_access SET last_email_at = ?2, email_day = ?3, email_day_count = ?4 " +
            "WHERE id = ?1 AND last_email_at IS ?5 AND email_day IS ?6 AND email_day_count = ?7",
        )
        .bind(
          subscriberId,
          claimedAt,
          utcDay(now),
          nextCount,
          previous.lastEmailAt,
          previous.emailDay,
          previous.emailDayCount,
        )
        .run();
      return result.meta.changes === 1 ? { subscriberId, claimedAt, previous } : null;
    },

    async releaseAddressSend(claim) {
      await db
        .prepare(
          "UPDATE early_access SET last_email_at = ?3, email_day = ?4, email_day_count = ?5 " +
            "WHERE id = ?1 AND last_email_at = ?2",
        )
        .bind(
          claim.subscriberId,
          claim.claimedAt,
          claim.previous.lastEmailAt,
          claim.previous.emailDay,
          claim.previous.emailDayCount,
        )
        .run();
    },

    async claimMarketingSend(now, limit) {
      const caps = emailAdmissionCaps(limit);
      if (caps.hard <= 0 || caps.marketing <= 0) return null;
      const claimId = crypto.randomUUID();
      try {
        await db
          .prepare(
            `INSERT INTO marketing_email_dispatches
             (claim_id, claimed_day, budget_limit, marketing_limit, non_deletion_limit, state, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'claimed', ?6)`,
          )
          .bind(claimId, utcDay(now), caps.hard, caps.marketing, caps.nonDeletion, now.toISOString())
          .run();
        return { claimId, day: utcDay(now) };
      } catch {
        return null;
      }
    },

    async finalizeMarketingSend(claim, state) {
      await db
        .prepare(
          "UPDATE marketing_email_dispatches SET state = ?2, completed_at = CURRENT_TIMESTAMP " +
            "WHERE claim_id = ?1 AND state = 'claimed'",
        )
        .bind(claim.claimId, state)
        .run();
    },

    async addTokens(tokens) {
      if (tokens.length === 0) return;
      await db.batch(
        tokens.map((token) =>
          db
            .prepare(
              "INSERT INTO early_access_tokens (token_hash, early_access_id, purpose, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .bind(token.hash, token.subscriberId, token.purpose, token.createdAt, token.expiresAt),
        ),
      );
    },

    async deleteTokens(hashes) {
      if (hashes.length === 0) return;
      await db.batch(
        hashes.map((hash) => db.prepare("DELETE FROM early_access_tokens WHERE token_hash = ?1").bind(hash)),
      );
    },

    async confirmByToken(hash, now) {
      const token = await consumeToken(db, hash, "confirm");
      if (!token || token.expires_at <= now.toISOString()) return false;
      const [confirmed] = await db.batch([
        db
          .prepare("UPDATE early_access SET status = 'confirmed', confirmed_at = ?2 WHERE id = ?1")
          .bind(token.early_access_id, now.toISOString()),
        db
          .prepare("DELETE FROM early_access_tokens WHERE early_access_id = ?1 AND purpose = 'confirm'")
          .bind(token.early_access_id),
      ]);
      return (confirmed?.meta.changes ?? 0) === 1;
    },

    async removeByToken(hash, now) {
      const token = await consumeToken(db, hash, "remove");
      if (!token || token.expires_at <= now.toISOString()) return false;
      const [, removed] = await db.batch([
        db.prepare("DELETE FROM early_access_tokens WHERE early_access_id = ?1").bind(token.early_access_id),
        db.prepare("DELETE FROM early_access WHERE id = ?1").bind(token.early_access_id),
      ]);
      return (removed?.meta.changes ?? 0) === 1;
    },
  };
}
