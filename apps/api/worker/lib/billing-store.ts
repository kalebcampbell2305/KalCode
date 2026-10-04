import type { BillableTier } from "./billing-plans";
import type { StripeClient, StripeSubscriptionSnapshot } from "./stripe";

type CheckoutParameters = Parameters<StripeClient["createCheckout"]>[0];

export interface BillingCustomer {
  accountId: string;
  email: string;
  stripeCustomerId: string | null;
  createIdempotencyKey: string;
}

export interface BillingLease {
  subscriptionId: string;
  token: string;
  version: number;
  expiresAt: string;
}

export type CheckoutReservation =
  | { status: "reserved"; idempotencyKey: string }
  | { status: "subscribed" }
  | { status: "owner" }
  | { status: "busy" };

export interface BillingEventClaim {
  eventId: string;
  token: string;
  version: number;
}

const ACTIVE = new Set(["active", "trialing"]);

export function d1BillingStore(db: D1Database) {
  return {
    async reserveCustomer(input: {
      accountId: string;
      idempotencyKey: string;
      now: string;
    }): Promise<BillingCustomer | null> {
      await db
        .prepare(
          `INSERT INTO billing_customers (account_id, create_idempotency_key, created_at, updated_at)
           SELECT id, ?2, ?3, ?3 FROM accounts WHERE id = ?1 AND deleted_at IS NULL
           ON CONFLICT (account_id) DO NOTHING`,
        )
        .bind(input.accountId, input.idempotencyKey, input.now)
        .run();
      const row = await db
        .prepare(
          `SELECT c.account_id, a.email, c.stripe_customer_id, c.create_idempotency_key
           FROM billing_customers c JOIN accounts a ON a.id = c.account_id WHERE c.account_id = ?1`,
        )
        .bind(input.accountId)
        .first<{
          account_id: string;
          email: string;
          stripe_customer_id: string | null;
          create_idempotency_key: string;
        }>();
      return row
        ? {
            accountId: row.account_id,
            email: row.email,
            stripeCustomerId: row.stripe_customer_id,
            createIdempotencyKey: row.create_idempotency_key,
          }
        : null;
    },

    async bindCustomer(accountId: string, customerId: string, now: string): Promise<boolean> {
      const result = await db
        .prepare(
          `UPDATE billing_customers SET stripe_customer_id = ?2, updated_at = ?3
           WHERE account_id = ?1 AND (stripe_customer_id IS NULL OR stripe_customer_id = ?2)`,
        )
        .bind(accountId, customerId, now)
        .run();
      return (result.meta.changes ?? 0) === 1;
    },

    async customerForAccount(accountId: string): Promise<string | null> {
      const row = await db
        .prepare("SELECT stripe_customer_id FROM billing_customers WHERE account_id = ?1")
        .bind(accountId)
        .first<{ stripe_customer_id: string | null }>();
      return row?.stripe_customer_id ?? null;
    },

    /** Only the caller's current subscription; never expose another customer's Stripe identity. */
    async subscriptionForAccount(accountId: string): Promise<{ id: string; customerId: string } | null> {
      const row = await db
        .prepare(
          `SELECT stripe_subscription_id, stripe_customer_id FROM billing_subscriptions
           WHERE account_id = ?1 AND status NOT IN ('canceled', 'incomplete_expired')
           ORDER BY reconciled_at DESC LIMIT 1`,
        )
        .bind(accountId)
        .first<{ stripe_subscription_id: string; stripe_customer_id: string }>();
      return row ? { id: row.stripe_subscription_id, customerId: row.stripe_customer_id } : null;
    },

    async reserveCheckout(input: {
      accountId: string;
      tier: BillableTier;
      requestHash: string;
      idempotencyKey: string;
      now: string;
      expiresAt: string;
    }): Promise<CheckoutReservation> {
      await db
        .prepare(
          `INSERT INTO billing_checkout_intents
             (account_id, tier, request_hash, idempotency_key, created_at, expires_at, creation_parameters)
           SELECT a.id, ?2, ?3, ?4, ?5, ?6, '{}' FROM accounts a
           WHERE a.id = ?1 AND a.deleted_at IS NULL AND NOT EXISTS (
             SELECT 1 FROM billing_subscriptions s
             WHERE s.account_id = a.id AND s.status NOT IN ('canceled', 'incomplete_expired')
           ) AND NOT EXISTS (
             SELECT 1 FROM active_owner_accounts o WHERE o.account_id = a.id
           )
           ON CONFLICT (account_id) DO UPDATE SET
             tier = excluded.tier, request_hash = excluded.request_hash,
             idempotency_key = excluded.idempotency_key, created_at = excluded.created_at,
             expires_at = excluded.expires_at,
             stripe_checkout_session_id = NULL, finalized_at = NULL,
             creation_parameters = '{}', checkout_url = NULL
           WHERE billing_checkout_intents.expires_at <= ?5`,
        )
        .bind(input.accountId, input.tier, input.requestHash, input.idempotencyKey, input.now, input.expiresAt)
        .run();
      const active = await db
        .prepare(
          "SELECT 1 AS active FROM billing_subscriptions WHERE account_id = ?1 AND status NOT IN ('canceled', 'incomplete_expired') LIMIT 1",
        )
        .bind(input.accountId)
        .first<{ active: number }>();
      if (active) return { status: "subscribed" };
      const owner = await db
        .prepare("SELECT 1 AS active FROM active_owner_accounts WHERE account_id = ?1 LIMIT 1")
        .bind(input.accountId)
        .first<{ active: number }>();
      if (owner) return { status: "owner" };
      const row = await db
        .prepare(
          "SELECT tier, request_hash, idempotency_key FROM billing_checkout_intents WHERE account_id = ?1 AND expires_at > ?2",
        )
        .bind(input.accountId, input.now)
        .first<{ tier: BillableTier; request_hash: string; idempotency_key: string }>();
      if (row?.tier === input.tier && row.request_hash === input.requestHash) {
        return { status: "reserved", idempotencyKey: row.idempotency_key };
      }
      return { status: "busy" };
    },

    async bindCheckoutParameters(input: {
      accountId: string;
      tier: BillableTier;
      requestHash: string;
      now: string;
      parameters: CheckoutParameters;
    }): Promise<{ parameters: CheckoutParameters; checkoutUrl: string | null } | null> {
      // One conditional write freezes concurrent callers to the same operation. The persisted
      // reservation expiry, not the caller's clock, supplies Stripe's expiration parameter.
      // Legacy NULL bindings are held until expiry; guessing their prior parameters is unsafe.
      const row = await db
        .prepare(
          `UPDATE billing_checkout_intents AS i
         SET creation_parameters = CASE WHEN creation_parameters = '{}'
           THEN json_set(?6, '$.expiresAt', CAST(strftime('%s', expires_at) AS INTEGER))
           ELSE creation_parameters END
         WHERE account_id = ?1 AND tier = ?2 AND request_hash = ?3 AND idempotency_key = ?4
           AND expires_at > ?5 AND creation_parameters IS NOT NULL
           AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = ?1 AND a.deleted_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM billing_subscriptions s
             WHERE s.account_id = ?1 AND s.status NOT IN ('canceled', 'incomplete_expired'))
           AND NOT EXISTS (SELECT 1 FROM active_owner_accounts o WHERE o.account_id = ?1)
         RETURNING creation_parameters, checkout_url`,
        )
        .bind(
          input.accountId,
          input.tier,
          input.requestHash,
          input.parameters.idempotencyKey,
          input.now,
          JSON.stringify(input.parameters),
        )
        .first<{ creation_parameters: string; checkout_url: string | null }>();
      return row
        ? { parameters: JSON.parse(row.creation_parameters) as CheckoutParameters, checkoutUrl: row.checkout_url }
        : null;
    },

    async checkoutStillReserved(input: {
      accountId: string;
      tier: BillableTier;
      requestHash: string;
      now: string;
      idempotencyKey?: string;
    }): Promise<boolean> {
      const row = await db
        .prepare(
          `SELECT 1 AS reserved FROM billing_checkout_intents i JOIN accounts a ON a.id = i.account_id
           WHERE i.account_id = ?1 AND i.tier = ?2 AND i.request_hash = ?3 AND i.expires_at > ?4
             AND (?5 IS NULL OR i.idempotency_key = ?5) AND a.deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM billing_subscriptions s
               WHERE s.account_id = ?1 AND s.status NOT IN ('canceled', 'incomplete_expired')
             )
             AND NOT EXISTS (
               SELECT 1 FROM active_owner_accounts o WHERE o.account_id = ?1
             )`,
        )
        .bind(input.accountId, input.tier, input.requestHash, input.now, input.idempotencyKey ?? null)
        .first<{ reserved: number }>();
      return Boolean(row);
    },

    async finalizeCheckout(input: {
      accountId: string;
      tier: BillableTier;
      requestHash: string;
      stripeSessionId: string;
      checkoutUrl?: string;
      idempotencyKey?: string;
      now: string;
    }): Promise<boolean> {
      const result = await db
        .prepare(
          `UPDATE billing_checkout_intents AS i
           SET stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, ?4),
               finalized_at = COALESCE(finalized_at, ?5),
               checkout_url = COALESCE(checkout_url, ?6)
           WHERE account_id = ?1 AND tier = ?2 AND request_hash = ?3 AND expires_at > ?5
             AND (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id = ?4)
             AND (?7 IS NULL OR idempotency_key = ?7)
             AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = ?1 AND a.deleted_at IS NULL)
             AND NOT EXISTS (
               SELECT 1 FROM billing_subscriptions s
               WHERE s.account_id = ?1 AND s.status NOT IN ('canceled', 'incomplete_expired')
             )
             AND NOT EXISTS (
               SELECT 1 FROM active_owner_accounts o WHERE o.account_id = ?1
             )`,
        )
        .bind(
          input.accountId,
          input.tier,
          input.requestHash,
          input.stripeSessionId,
          input.now,
          input.checkoutUrl ?? null,
          input.idempotencyKey ?? null,
        )
        .run();
      return (result.meta.changes ?? 0) === 1;
    },

    async claimEvent(input: {
      eventId: string;
      eventType: string;
      eventSubject: string | null;
      token: string;
      receivedAt: string;
      claimExpiresAt: string;
    }): Promise<
      | { status: "claimed"; claim: BillingEventClaim }
      | { status: "pending" }
      | { status: "done" }
      | { status: "mismatch" }
    > {
      const claimed = await db
        .prepare(
          `INSERT INTO billing_webhook_events
             (event_id, event_type, event_subject, received_at, claim_token, claim_version, claim_expires_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
           ON CONFLICT (event_id) DO UPDATE SET
             claim_token = excluded.claim_token,
             claim_version = billing_webhook_events.claim_version + 1,
             claim_expires_at = excluded.claim_expires_at
           WHERE billing_webhook_events.processed_at IS NULL
             AND billing_webhook_events.claim_expires_at <= ?4
             AND billing_webhook_events.event_type = ?2
             AND billing_webhook_events.event_subject IS ?3
           RETURNING claim_version`,
        )
        .bind(input.eventId, input.eventType, input.eventSubject, input.receivedAt, input.token, input.claimExpiresAt)
        .first<{ claim_version: number }>();
      if (claimed) {
        return {
          status: "claimed",
          claim: { eventId: input.eventId, token: input.token, version: claimed.claim_version },
        };
      }
      const row = await db
        .prepare(
          "SELECT event_type, event_subject, received_at, processed_at FROM billing_webhook_events WHERE event_id = ?1",
        )
        .bind(input.eventId)
        .first<{
          event_type: string;
          event_subject: string | null;
          received_at: string;
          processed_at: string | null;
        }>();
      if (row && (row.event_type !== input.eventType || row.event_subject !== input.eventSubject)) {
        return { status: "mismatch" };
      }
      if (row?.processed_at) return { status: "done" };
      return { status: "pending" };
    },

    async allowAction(input: {
      accountId: string;
      action: "checkout" | "portal";
      now: string;
      windowStart: string;
      retentionStart: string;
      limit: number;
    }): Promise<boolean> {
      await db
        .prepare("DELETE FROM billing_action_limits WHERE window_started_at < ?1")
        .bind(input.retentionStart)
        .run();
      const row = await db
        .prepare(
          `INSERT INTO billing_action_limits (account_id, action, window_started_at, request_count)
           SELECT id, ?2, ?3, 1 FROM accounts WHERE id = ?1
           ON CONFLICT (account_id, action) DO UPDATE SET
             window_started_at = CASE
               WHEN billing_action_limits.window_started_at <= ?4 THEN excluded.window_started_at
               ELSE billing_action_limits.window_started_at
             END,
             request_count = CASE
               WHEN billing_action_limits.window_started_at <= ?4 THEN 1
               ELSE MIN(billing_action_limits.request_count + 1, 100000)
             END
           RETURNING request_count`,
        )
        .bind(input.accountId, input.action, input.now, input.windowStart)
        .first<{ request_count: number }>();
      return Boolean(row && row.request_count <= input.limit);
    },

    async finishEvent(claim: BillingEventClaim, result: "applied" | "ignored", now: string): Promise<boolean> {
      const update = await db
        .prepare(
          `UPDATE billing_webhook_events SET processed_at = ?4, result = ?5
           WHERE event_id = ?1 AND claim_token = ?2 AND claim_version = ?3
             AND claim_expires_at > ?4 AND processed_at IS NULL`,
        )
        .bind(claim.eventId, claim.token, claim.version, now, result)
        .run();
      return (update.meta.changes ?? 0) === 1;
    },

    async acquireLease(input: {
      subscriptionId: string;
      token: string;
      now: string;
      expiresAt: string;
    }): Promise<BillingLease | null> {
      const row = await db
        .prepare(
          `INSERT INTO billing_sync_leases (stripe_subscription_id, lease_token, version, expires_at)
           VALUES (?1, ?2, 1, ?4)
           ON CONFLICT (stripe_subscription_id) DO UPDATE SET
             lease_token = ?2, version = billing_sync_leases.version + 1, expires_at = ?4
           WHERE billing_sync_leases.expires_at <= ?3
           RETURNING version`,
        )
        .bind(input.subscriptionId, input.token, input.now, input.expiresAt)
        .first<{ version: number }>();
      return row
        ? { subscriptionId: input.subscriptionId, token: input.token, version: row.version, expiresAt: input.expiresAt }
        : null;
    },

    async applySubscription(snapshot: StripeSubscriptionSnapshot, lease: BillingLease, now: string): Promise<boolean> {
      if (snapshot.id !== lease.subscriptionId) return false;
      const customer = await db
        .prepare(
          `SELECT c.account_id FROM billing_customers c JOIN accounts a ON a.id = c.account_id
           WHERE c.stripe_customer_id = ?1 AND a.deleted_at IS NULL`,
        )
        .bind(snapshot.customerId)
        .first<{ account_id: string }>();
      if (!customer) return false;
      const existing = await db
        .prepare("SELECT account_id, stripe_customer_id FROM billing_subscriptions WHERE stripe_subscription_id = ?1")
        .bind(snapshot.id)
        .first<{ account_id: string; stripe_customer_id: string }>();
      if (
        existing &&
        (existing.account_id !== customer.account_id || existing.stripe_customer_id !== snapshot.customerId)
      ) {
        return false;
      }
      const active = ACTIVE.has(snapshot.status);
      const fence = `EXISTS (SELECT 1 FROM billing_sync_leases l
        WHERE l.stripe_subscription_id = ?1 AND l.lease_token = ?2 AND l.version = ?3 AND l.expires_at > ?4)`;
      const statements: D1PreparedStatement[] = [
        db
          .prepare(
            `UPDATE billing_sync_leases SET lease_token = lease_token
             WHERE stripe_subscription_id = ?1 AND lease_token = ?2 AND version = ?3 AND expires_at > ?4`,
          )
          .bind(lease.subscriptionId, lease.token, lease.version, now),
        db
          .prepare(
            `INSERT INTO billing_subscriptions
               (stripe_subscription_id, account_id, stripe_customer_id, tier, status, period_start, period_end, reconciled_at)
             SELECT ?1, ?5, ?6, ?7, ?8, ?9, ?10, ?4 WHERE ${fence}
             ON CONFLICT (stripe_subscription_id) DO UPDATE SET
               account_id = excluded.account_id, stripe_customer_id = excluded.stripe_customer_id,
               tier = excluded.tier, status = excluded.status, period_start = excluded.period_start,
               period_end = excluded.period_end, reconciled_at = excluded.reconciled_at
             WHERE ${fence}`,
          )
          .bind(
            lease.subscriptionId,
            lease.token,
            lease.version,
            now,
            customer.account_id,
            snapshot.customerId,
            snapshot.tier,
            snapshot.status,
            snapshot.periodStart,
            snapshot.periodEnd,
          ),
        db
          .prepare(
            `UPDATE entitlement_grants SET revoked_at = ?4, revoked_by = 'billing', revoke_reason = 'subscription inactive or changed'
             WHERE billing_subscription_id = ?1 AND revoked_at IS NULL AND (?5 = 0 OR tier <> ?6) AND ${fence}`,
          )
          .bind(lease.subscriptionId, lease.token, lease.version, now, active ? 1 : 0, snapshot.tier),
      ];
      if (active) {
        statements.push(
          db
            .prepare(`UPDATE accounts SET activated_at = COALESCE(activated_at, ?4) WHERE id = ?5 AND ${fence}`)
            .bind(lease.subscriptionId, lease.token, lease.version, now, customer.account_id),
          db
            .prepare(
              `UPDATE entitlement_grants SET expires_at = ?5
               WHERE billing_subscription_id = ?1 AND tier = ?6 AND revoked_at IS NULL AND ${fence}`,
            )
            .bind(lease.subscriptionId, lease.token, lease.version, now, snapshot.periodEnd, snapshot.tier),
          db
            .prepare(
              `INSERT INTO entitlement_grants
                 (account_id, tier, source, granted_by, reason, granted_at, expires_at, billing_subscription_id)
               SELECT ?5, ?6, 'billing', 'billing', 'verified Stripe subscription', ?7, ?8, ?1
               WHERE ${fence} AND NOT EXISTS (
                 SELECT 1 FROM entitlement_grants WHERE billing_subscription_id = ?1 AND revoked_at IS NULL
               )`,
            )
            .bind(
              lease.subscriptionId,
              lease.token,
              lease.version,
              now,
              customer.account_id,
              snapshot.tier,
              snapshot.periodStart,
              snapshot.periodEnd,
            ),
        );
        statements.push(
          db
            .prepare(
              `INSERT INTO billing_checkout_invalidations
                 (stripe_checkout_session_id, account_id, source_subscription_id, created_at)
               SELECT i.stripe_checkout_session_id, ?5, ?1, ?4
               FROM billing_checkout_intents i
               WHERE i.account_id = ?5 AND i.stripe_checkout_session_id IS NOT NULL
                 AND i.expires_at > ?4 AND ${fence}
               ON CONFLICT (stripe_checkout_session_id) DO UPDATE SET
                 source_subscription_id = excluded.source_subscription_id,
                 created_at = excluded.created_at
               WHERE billing_checkout_invalidations.account_id = excluded.account_id
                 AND billing_checkout_invalidations.completed_at IS NULL`,
            )
            .bind(lease.subscriptionId, lease.token, lease.version, now, customer.account_id),
          db
            .prepare(`DELETE FROM billing_checkout_intents WHERE account_id = ?5 AND ${fence}`)
            .bind(lease.subscriptionId, lease.token, lease.version, now, customer.account_id),
        );
      }
      const results = await db.batch(statements);
      return (results[0]?.meta.changes ?? 0) === 1;
    },

    async pendingCheckoutInvalidations(subscriptionId: string): Promise<string[]> {
      const rows = await db
        .prepare(
          `SELECT stripe_checkout_session_id FROM billing_checkout_invalidations
           WHERE source_subscription_id = ?1 AND completed_at IS NULL ORDER BY created_at`,
        )
        .bind(subscriptionId)
        .all<{ stripe_checkout_session_id: string }>();
      return (rows.results ?? []).map((row) => row.stripe_checkout_session_id);
    },

    async completeCheckoutInvalidation(subscriptionId: string, sessionId: string, now: string): Promise<boolean> {
      const result = await db
        .prepare(
          `UPDATE billing_checkout_invalidations SET completed_at = ?3
           WHERE source_subscription_id = ?1 AND stripe_checkout_session_id = ?2 AND completed_at IS NULL`,
        )
        .bind(subscriptionId, sessionId, now)
        .run();
      return (result.meta.changes ?? 0) === 1;
    },

    async revokeInvalidSubscription(
      subscriptionId: string,
      customerId: string | null,
      lease: BillingLease,
      now: string,
    ): Promise<boolean> {
      if (subscriptionId !== lease.subscriptionId) return false;
      const customer = customerId
        ? await db
            .prepare(
              `SELECT c.account_id FROM billing_customers c JOIN accounts a ON a.id = c.account_id
               WHERE c.stripe_customer_id = ?1 AND a.deleted_at IS NULL`,
            )
            .bind(customerId)
            .first<{ account_id: string }>()
        : null;
      const existing = await db
        .prepare("SELECT account_id, stripe_customer_id FROM billing_subscriptions WHERE stripe_subscription_id = ?1")
        .bind(subscriptionId)
        .first<{ account_id: string; stripe_customer_id: string }>();
      const fence = `EXISTS (SELECT 1 FROM billing_sync_leases l
        WHERE l.stripe_subscription_id = ?1 AND l.lease_token = ?2 AND l.version = ?3 AND l.expires_at > ?4)`;
      const results = await db.batch([
        db
          .prepare(
            `UPDATE billing_sync_leases SET lease_token = lease_token
             WHERE stripe_subscription_id = ?1 AND lease_token = ?2 AND version = ?3 AND expires_at > ?4`,
          )
          .bind(lease.subscriptionId, lease.token, lease.version, now),
        db
          .prepare(
            `INSERT INTO billing_subscriptions
               (stripe_subscription_id, account_id, stripe_customer_id, tier, status, period_start, period_end, reconciled_at)
             SELECT ?1, ?5, ?6, NULL, 'invalid', NULL, NULL, ?4
             WHERE ?5 IS NOT NULL AND ?6 IS NOT NULL AND ${fence}
             ON CONFLICT (stripe_subscription_id) DO UPDATE SET
               tier = NULL, status = 'invalid', period_start = NULL, period_end = NULL, reconciled_at = excluded.reconciled_at
             WHERE billing_subscriptions.account_id = excluded.account_id
               AND billing_subscriptions.stripe_customer_id = excluded.stripe_customer_id AND ${fence}`,
          )
          .bind(
            lease.subscriptionId,
            lease.token,
            lease.version,
            now,
            existing?.account_id ?? customer?.account_id ?? null,
            existing?.stripe_customer_id ?? customerId ?? null,
          ),
        db
          .prepare(
            `UPDATE entitlement_grants
             SET revoked_at = ?4, revoked_by = 'billing', revoke_reason = 'subscription snapshot invalid'
             WHERE billing_subscription_id = ?1 AND revoked_at IS NULL AND ${fence}`,
          )
          .bind(lease.subscriptionId, lease.token, lease.version, now),
      ]);
      return (results[0]?.meta.changes ?? 0) === 1;
    },

    async releaseLease(lease: BillingLease): Promise<void> {
      await db
        .prepare(
          `UPDATE billing_sync_leases SET expires_at = '1970-01-01T00:00:00.000Z'
           WHERE stripe_subscription_id = ?1 AND lease_token = ?2 AND version = ?3`,
        )
        .bind(lease.subscriptionId, lease.token, lease.version)
        .run();
    },
  };
}

export type BillingStore = ReturnType<typeof d1BillingStore>;

export function isBillableTier(value: string): value is BillableTier {
  return value === "pro" || value === "max" || value === "max2x";
}
