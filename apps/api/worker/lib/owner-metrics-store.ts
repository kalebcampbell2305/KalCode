/**
 * Owner dashboard storage (docs/OWNER_ANALYTICS.md). The only write is the aggregate daily
 * revenue snapshot; everything else is a read of account and grant history for reporting.
 * Returns counts and timestamps only — never emails, account ids or Stripe ids.
 */

import type { BillableTier } from "./billing-plans";

export interface MetricSnapshot {
  day: string;
  capturedAt: string;
  paidSubscribers: number;
  mrrCents: number;
  byPlan: Record<BillableTier, { subscribers: number; mrrCents: number }>;
}

export interface BillingGrantRow {
  subscription: string;
  tier: BillableTier;
  grantedAt: string;
}

export interface AccountStats {
  /** Live (not deleted) accounts. */
  accounts: number;
  /** Live accounts that finished setup (chose Free or paid). */
  activated: number;
  /** Live accounts created at or after `since`. */
  newSince: number;
  /** Live accounts that have ever held a billing grant. */
  everPaid: number;
  /** Accounts whose first desktop sign-in happened at or after `today` / `since`. */
  firstDesktopToday: number;
  firstDesktopSince: number;
}

export interface OwnerMetricsStore {
  saveSnapshot(snapshot: MetricSnapshot): Promise<void>;
  snapshots(sinceDay: string | null): Promise<MetricSnapshot[]>;
  billingGrants(): Promise<BillingGrantRow[]>;
  accountStats(todayIso: string, sinceIso: string | null): Promise<AccountStats>;
}

export function d1OwnerMetricsStore(db: D1Database): OwnerMetricsStore {
  return {
    async saveSnapshot(snapshot) {
      await db
        .prepare(
          `INSERT INTO owner_metric_snapshots (day, captured_at, paid_subscribers, mrr_cents, by_plan)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (day) DO UPDATE SET captured_at = excluded.captured_at,
             paid_subscribers = excluded.paid_subscribers, mrr_cents = excluded.mrr_cents,
             by_plan = excluded.by_plan
           WHERE excluded.captured_at >= owner_metric_snapshots.captured_at`,
        )
        .bind(
          snapshot.day,
          snapshot.capturedAt,
          snapshot.paidSubscribers,
          Math.round(snapshot.mrrCents),
          JSON.stringify(snapshot.byPlan),
        )
        .run();
    },
    async snapshots(sinceDay) {
      const { results } = await db
        .prepare(
          "SELECT day, captured_at, paid_subscribers, mrr_cents, by_plan FROM owner_metric_snapshots WHERE ?1 IS NULL OR day >= ?1 ORDER BY day",
        )
        .bind(sinceDay)
        .all<{ day: string; captured_at: string; paid_subscribers: number; mrr_cents: number; by_plan: string }>();
      return results.map((row) => ({
        day: row.day,
        capturedAt: row.captured_at,
        paidSubscribers: row.paid_subscribers,
        mrrCents: row.mrr_cents,
        byPlan: JSON.parse(row.by_plan) as MetricSnapshot["byPlan"],
      }));
    },
    async billingGrants() {
      const { results } = await db
        .prepare(
          `SELECT billing_subscription_id AS subscription, tier, granted_at FROM entitlement_grants
           WHERE source = 'billing' AND billing_subscription_id IS NOT NULL AND tier IN ('pro', 'max', 'max2x')
           ORDER BY billing_subscription_id, granted_at, id`,
        )
        .all<{ subscription: string; tier: BillableTier; granted_at: string }>();
      return results.map((row) => ({ subscription: row.subscription, tier: row.tier, grantedAt: row.granted_at }));
    },
    async accountStats(todayIso, sinceIso) {
      const row = await db
        .prepare(
          `SELECT
             (SELECT count(*) FROM accounts WHERE deleted_at IS NULL) AS accounts,
             (SELECT count(*) FROM accounts WHERE deleted_at IS NULL AND activated_at IS NOT NULL) AS activated,
             (SELECT count(*) FROM accounts WHERE deleted_at IS NULL AND (?2 IS NULL OR created_at >= ?2)) AS new_since,
             (SELECT count(DISTINCT g.account_id) FROM entitlement_grants g JOIN accounts a ON a.id = g.account_id
                WHERE g.source = 'billing' AND a.deleted_at IS NULL) AS ever_paid,
             (SELECT count(*) FROM (SELECT min(created_at) AS first FROM account_sessions
                WHERE client_kind = 'desktop' GROUP BY account_id) WHERE first >= ?1) AS first_desktop_today,
             (SELECT count(*) FROM (SELECT min(created_at) AS first FROM account_sessions
                WHERE client_kind = 'desktop' GROUP BY account_id) WHERE ?2 IS NULL OR first >= ?2) AS first_desktop_since`,
        )
        .bind(todayIso, sinceIso)
        .first<Record<string, number>>();
      return {
        accounts: row?.accounts ?? 0,
        activated: row?.activated ?? 0,
        newSince: row?.new_since ?? 0,
        everPaid: row?.ever_paid ?? 0,
        firstDesktopToday: row?.first_desktop_today ?? 0,
        firstDesktopSince: row?.first_desktop_since ?? 0,
      };
    },
  };
}
