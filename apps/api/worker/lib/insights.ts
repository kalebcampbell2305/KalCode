/**
 * Private owner dashboard data (docs/OWNER_ANALYTICS.md): distribution counts from the website
 * Worker and recurring revenue from live-mode Stripe. Every route that serves this is OWNER-only
 * (router.ts `requireOwner`); this module never sees an unauthorized request.
 *
 * Revenue rules (owner directive 2026-10-02):
 *   - Stripe live mode is the only source. Test-mode objects are ignored.
 *   - MRR counts `active` subscriptions on KalCode Prices only, normalized to one month
 *     (a $100/year Pro counts $100 / 12). `past_due`, `trialing`, `incomplete` and `canceled`
 *     never count. A subscription scheduled to cancel counts until its paid period ends.
 *   - ARR = MRR × 12.
 *   - Cash collected is separate: succeeded charges minus refunds issued in the period.
 * Nothing is estimated: a figure that cannot be computed is reported as unavailable.
 */

import type { BillableTier, BillingPriceCatalog } from "./billing-plans";
import { apiError, json } from "./http";
import type { BillingGrantRow, MetricSnapshot, OwnerMetricsStore } from "./owner-metrics-store";

export type InsightsRange = "24h" | "7d" | "30d" | "90d" | "all";
const RANGES: readonly InsightsRange[] = ["24h", "7d", "30d", "90d", "all"];
const RANGE_DAYS: Record<Exclude<InsightsRange, "all">, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
const DAY = 86_400_000;
const TIERS: readonly BillableTier[] = ["pro", "max", "max2x"];
const RANK: Record<BillableTier, number> = { pro: 1, max: 2, max2x: 3 };

/** The website Worker's internal DistributionStatsEntrypoint (apps/website/worker/index.ts). */
export interface DistributionStatsBinding {
  distributionStats(input: { range: InsightsRange; tzOffsetMinutes: number }): Promise<unknown>;
}

export function isDistributionStatsBinding(value: unknown): value is DistributionStatsBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { distributionStats?: unknown }).distributionStats === "function"
  );
}

export interface InsightsStripe {
  listSubscriptions(): Promise<unknown[]>;
  listCharges(createdGteSeconds: number): Promise<unknown[]>;
  listRefunds(createdGteSeconds: number): Promise<unknown[]>;
}

// ---------------------------------------------------------------------------------------------
// Pure revenue math.

export interface ParsedSubscription {
  status: string;
  tier: BillableTier;
  interval: "month" | "year";
  /** Normalized monthly value in USD cents, after active recurring discounts. */
  mrrCents: number;
  startedAt: number;
  endedAt: number | null;
  trialEnd: number | null;
  cancelScheduled: boolean;
}

export interface SubscriptionScan {
  subscriptions: ParsedSubscription[];
  /** Live subscriptions on prices that are not KalCode's catalog (or not USD): never counted. */
  unrecognized: number;
  /** Test-mode objects seen (a misconfigured key); never counted. */
  testMode: number;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const seconds = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) * 1000 : null;

/** Months per billing interval, so any recurring amount normalizes to one month. */
function monthsPer(interval: unknown, count: unknown): number | null {
  const n = Number.isSafeInteger(count) && (count as number) > 0 ? (count as number) : 1;
  if (interval === "month") return n;
  if (interval === "year") return 12 * n;
  if (interval === "week") return (n * 12) / 52;
  if (interval === "day") return (n * 12) / 365;
  return null;
}

function discountedMonthly(monthlyCents: number, months: number, discounts: unknown, now: number): number {
  let value = monthlyCents;
  for (const discount of Array.isArray(discounts) ? discounts : []) {
    if (!isRecord(discount)) continue;
    const end = seconds(discount.end);
    if (end !== null && end <= now) continue;
    const source = isRecord(discount.source) ? discount.source : null;
    const coupon = isRecord(discount.coupon) ? discount.coupon : isRecord(source?.coupon) ? source.coupon : null;
    // A one-time coupon lowers one invoice, not the recurring run rate.
    if (!coupon || coupon.duration === "once") continue;
    if (typeof coupon.percent_off === "number" && coupon.percent_off > 0) {
      value *= 1 - Math.min(100, coupon.percent_off) / 100;
    } else if (typeof coupon.amount_off === "number" && coupon.amount_off > 0 && coupon.currency === "usd") {
      value -= coupon.amount_off / months;
    }
  }
  return Math.max(0, value);
}

export function scanSubscriptions(
  raws: readonly unknown[],
  catalog: Extract<BillingPriceCatalog, { ok: true }>,
  now: Date,
): SubscriptionScan {
  const scan: SubscriptionScan = { subscriptions: [], unrecognized: 0, testMode: 0 };
  for (const raw of raws) {
    if (!isRecord(raw)) continue;
    if (raw.livemode !== true) {
      scan.testMode += 1;
      continue;
    }
    const items = isRecord(raw.items) && Array.isArray(raw.items.data) ? raw.items.data : [];
    let tier: BillableTier | null = null;
    let interval: "month" | "year" | null = null;
    let months = 1;
    let monthly = 0;
    let valid = items.length > 0;
    for (const item of items) {
      const price = isRecord(item) && isRecord(item.price) ? item.price : null;
      const plan = typeof price?.id === "string" ? catalog.planForPrice[price.id] : undefined;
      const recurring = isRecord(price?.recurring) ? price.recurring : null;
      const per = monthsPer(recurring?.interval, recurring?.interval_count);
      const quantity = Number.isSafeInteger(item.quantity) ? (item.quantity as number) : 1;
      if (!plan || price?.currency !== "usd" || typeof price.unit_amount !== "number" || per === null) {
        valid = false;
        break;
      }
      tier ??= plan.tier;
      interval ??= plan.interval;
      months = per;
      monthly += (price.unit_amount * quantity) / per;
    }
    const startedAt = seconds(raw.start_date) ?? seconds(raw.created);
    if (!valid || !tier || !interval || startedAt === null || typeof raw.status !== "string") {
      scan.unrecognized += 1;
      continue;
    }
    scan.subscriptions.push({
      status: raw.status,
      tier,
      interval,
      mrrCents: discountedMonthly(monthly, months, raw.discounts, now.getTime()),
      startedAt,
      endedAt: seconds(raw.ended_at),
      trialEnd: seconds(raw.trial_end),
      cancelScheduled: raw.cancel_at_period_end === true || seconds(raw.cancel_at) !== null,
    });
  }
  return scan;
}

/** A subscription that has actually been paid for (not an abandoned checkout or a bare trial). */
function wasPaid(sub: ParsedSubscription): boolean {
  if (sub.status === "incomplete" || sub.status === "incomplete_expired") return false;
  if (sub.status === "trialing") return false;
  return !(sub.trialEnd !== null && sub.endedAt !== null && sub.endedAt <= sub.trialEnd);
}

function paidAt(sub: ParsedSubscription, t: number): boolean {
  return wasPaid(sub) && sub.startedAt <= t && (sub.endedAt === null || sub.endedAt > t);
}

export interface PlanRevenue {
  subscribers: number;
  monthly: number;
  yearly: number;
  mrrCents: number;
  arrCents: number;
}

export interface CashPeriod {
  grossCents: number;
  refundedCents: number;
  netCents: number;
}

export function cashBetween(
  charges: readonly unknown[],
  refunds: readonly unknown[],
  from: number,
  to: number,
): CashPeriod {
  let gross = 0;
  let refunded = 0;
  for (const charge of charges) {
    if (!isRecord(charge) || charge.livemode !== true || charge.currency !== "usd") continue;
    if (charge.status !== "succeeded" || charge.paid !== true) continue;
    const at = seconds(charge.created);
    if (at === null || at < from || at >= to) continue;
    gross += typeof charge.amount_captured === "number" ? charge.amount_captured : Number(charge.amount) || 0;
  }
  for (const refund of refunds) {
    if (!isRecord(refund) || refund.livemode === false || refund.currency !== "usd") continue;
    if (refund.status !== "succeeded" && refund.status !== "pending") continue;
    const at = seconds(refund.created);
    if (at === null || at < from || at >= to) continue;
    refunded += Number(refund.amount) || 0;
  }
  return { grossCents: gross, refundedCents: refunded, netCents: gross - refunded };
}

/** Tier changes on the same subscription, read from the immutable billing grant history. */
export function planMovements(
  grants: readonly BillingGrantRow[],
  from: number,
): { upgrades: number; downgrades: number } {
  let upgrades = 0;
  let downgrades = 0;
  for (let i = 1; i < grants.length; i += 1) {
    const previous = grants[i - 1] as BillingGrantRow;
    const current = grants[i] as BillingGrantRow;
    if (previous.subscription !== current.subscription || previous.tier === current.tier) continue;
    if (Date.parse(current.grantedAt) < from) continue;
    if (RANK[current.tier] > RANK[previous.tier]) upgrades += 1;
    else downgrades += 1;
  }
  return { upgrades, downgrades };
}

/** Start of the owner's local day / month containing `now`, as UTC instants. */
export function localStarts(now: Date, tzOffsetMinutes: number) {
  const local = new Date(now.getTime() - tzOffsetMinutes * 60_000);
  const shift = (d: Date) => d.getTime() + tzOffsetMinutes * 60_000;
  const day = new Date(local);
  day.setUTCHours(0, 0, 0, 0);
  const month = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1));
  const lastMonth = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1));
  return { day: shift(day), month: shift(month), lastMonth: shift(lastMonth) };
}

export interface RevenueSummary {
  generatedAt: string;
  livemode: true;
  currency: "usd";
  activeSubscribers: number;
  mrrCents: number;
  arrCents: number;
  byPlan: Record<BillableTier, PlanRevenue>;
  pastDue: number;
  trialing: number;
  scheduledToCancel: number;
  unrecognized: number;
  cash: { thisMonth: CashPeriod; lastMonth: CashPeriod };
  movement: { newSubscriptions: number; cancellations: number; upgrades: number; downgrades: number };
  churn30d: { rate: number | null; canceled: number; startingSubscribers: number };
  series: { day: string; subscribers: number; mrrCents: number; arrCents: number }[];
  trackingSince: string | null;
}

export interface RevenueInputs {
  scan: SubscriptionScan;
  charges: readonly unknown[];
  refunds: readonly unknown[];
  grants: readonly BillingGrantRow[];
  snapshots: readonly MetricSnapshot[];
  range: InsightsRange;
  tzOffsetMinutes: number;
  now: Date;
}

export function currentSnapshot(scan: SubscriptionScan, now: Date): MetricSnapshot {
  const byPlan = Object.fromEntries(
    TIERS.map((tier) => [tier, { subscribers: 0, mrrCents: 0 }]),
  ) as MetricSnapshot["byPlan"];
  let subscribers = 0;
  let mrr = 0;
  for (const sub of scan.subscriptions) {
    if (sub.status !== "active") continue;
    subscribers += 1;
    mrr += sub.mrrCents;
    byPlan[sub.tier].subscribers += 1;
    byPlan[sub.tier].mrrCents += sub.mrrCents;
  }
  return {
    day: now.toISOString().slice(0, 10),
    capturedAt: now.toISOString(),
    paidSubscribers: subscribers,
    mrrCents: mrr,
    byPlan,
  };
}

export function summarizeRevenue(inputs: RevenueInputs): RevenueSummary {
  const { scan, now } = inputs;
  const nowMs = now.getTime();
  const from = inputs.range === "all" ? Number.NEGATIVE_INFINITY : nowMs - RANGE_DAYS[inputs.range] * DAY;
  const starts = localStarts(now, inputs.tzOffsetMinutes);
  const byPlan = Object.fromEntries(
    TIERS.map((tier) => [tier, { subscribers: 0, monthly: 0, yearly: 0, mrrCents: 0, arrCents: 0 }]),
  ) as Record<BillableTier, PlanRevenue>;
  let pastDue = 0;
  let trialing = 0;
  let scheduledToCancel = 0;
  for (const sub of scan.subscriptions) {
    if (sub.status === "past_due") pastDue += 1;
    if (sub.status === "trialing") trialing += 1;
    if (sub.status !== "active") continue;
    const plan = byPlan[sub.tier];
    plan.subscribers += 1;
    plan[sub.interval === "year" ? "yearly" : "monthly"] += 1;
    plan.mrrCents += sub.mrrCents;
    if (sub.cancelScheduled) scheduledToCancel += 1;
  }
  for (const plan of Object.values(byPlan)) plan.arrCents = plan.mrrCents * 12;
  const live = currentSnapshot(scan, now);

  const churnStart = nowMs - 30 * DAY;
  const starting = scan.subscriptions.filter((sub) => paidAt(sub, churnStart));
  const canceled = starting.filter((sub) => sub.endedAt !== null && sub.endedAt <= nowMs).length;

  const series = inputs.snapshots
    .filter((s) => s.day !== live.day)
    .concat(live)
    .filter((s) => inputs.range === "all" || Date.parse(`${s.day}T23:59:59.999Z`) >= from)
    .map((s) => ({ day: s.day, subscribers: s.paidSubscribers, mrrCents: s.mrrCents, arrCents: s.mrrCents * 12 }));

  return {
    generatedAt: now.toISOString(),
    livemode: true,
    currency: "usd",
    activeSubscribers: live.paidSubscribers,
    mrrCents: live.mrrCents,
    arrCents: live.mrrCents * 12,
    byPlan,
    pastDue,
    trialing,
    scheduledToCancel,
    unrecognized: scan.unrecognized,
    cash: {
      thisMonth: cashBetween(inputs.charges, inputs.refunds, starts.month, Number.POSITIVE_INFINITY),
      lastMonth: cashBetween(inputs.charges, inputs.refunds, starts.lastMonth, starts.month),
    },
    movement: {
      newSubscriptions: scan.subscriptions.filter((sub) => wasPaid(sub) && sub.startedAt >= from).length,
      cancellations: scan.subscriptions.filter((sub) => sub.endedAt !== null && sub.endedAt >= from && wasPaid(sub))
        .length,
      ...planMovements(inputs.grants, from),
    },
    churn30d: {
      rate: starting.length > 0 ? canceled / starting.length : null,
      canceled,
      startingSubscribers: starting.length,
    },
    series,
    trackingSince: inputs.snapshots[0]?.day ?? live.day,
  };
}

// ---------------------------------------------------------------------------------------------
// Service.

export interface InsightsDeps {
  store: OwnerMetricsStore;
  distribution: DistributionStatsBinding | null;
  /** Null when live billing is not configured: revenue then answers 503, never a guess. */
  stripe: InsightsStripe | null;
  catalog: Extract<BillingPriceCatalog, { ok: true }> | null;
  now: () => Date;
  log: (entry: Record<string, string>) => void;
}

export interface InsightsService {
  distribution(request: Request): Promise<Response>;
  revenue(request: Request): Promise<Response>;
  /** Daily cron: stores today's aggregate snapshot. */
  snapshot(): Promise<void>;
}

interface StripeData {
  at: number;
  subscriptions: unknown[];
  charges: unknown[];
  refunds: unknown[];
}

const CACHE_MS = 60_000;

function parseQuery(request: Request): { range: InsightsRange; tzOffsetMinutes: number; fresh: boolean } | null {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") ?? "7d";
  const tzText = url.searchParams.get("tz") ?? "0";
  if (!(RANGES as readonly string[]).includes(range) || !/^-?\d{1,3}$/.test(tzText)) return null;
  const tzOffsetMinutes = Number(tzText);
  if (tzOffsetMinutes < -840 || tzOffsetMinutes > 840) return null;
  return { range: range as InsightsRange, tzOffsetMinutes, fresh: url.searchParams.get("fresh") === "1" };
}

const badQuery = () => apiError(400, "invalid_request", "Use ?range=24h|7d|30d|90d|all&tz=<minutes>.");

export function insightsService(deps: InsightsDeps): InsightsService {
  let cached: StripeData | null = null;

  /** Live Stripe lists, reused for a minute unless the owner asks for fresh data. */
  async function stripeData(fresh: boolean): Promise<{ data: StripeData; fetched: boolean }> {
    const now = deps.now().getTime();
    if (!fresh && cached && now - cached.at < CACHE_MS) return { data: cached, fetched: false };
    const stripe = deps.stripe as InsightsStripe;
    // Two months back covers "this month" and "last month" in any owner time zone.
    const since = Math.floor((now - 64 * DAY) / 1000);
    const [subscriptions, charges, refunds] = await Promise.all([
      stripe.listSubscriptions(),
      stripe.listCharges(since),
      stripe.listRefunds(since),
    ]);
    cached = { at: now, subscriptions, charges, refunds };
    return { data: cached, fetched: true };
  }

  async function saveSnapshot(scan: SubscriptionScan, now: Date): Promise<void> {
    try {
      await deps.store.saveSnapshot(currentSnapshot(scan, now));
    } catch (error) {
      deps.log({
        level: "warn",
        event: "insights.snapshot_failed",
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  return {
    async distribution(request) {
      const query = parseQuery(request);
      if (!query) return badQuery();
      const now = deps.now();
      const starts = localStarts(now, query.tzOffsetMinutes);
      const since =
        query.range === "all" ? null : new Date(now.getTime() - RANGE_DAYS[query.range] * DAY).toISOString();
      const [distribution, accounts] = await Promise.allSettled([
        deps.distribution
          ? deps.distribution.distributionStats({ range: query.range, tzOffsetMinutes: query.tzOffsetMinutes })
          : Promise.reject(new Error("distribution unavailable")),
        deps.store.accountStats(new Date(starts.day).toISOString(), since),
      ]);
      if (distribution.status === "rejected") deps.log({ level: "warn", event: "insights.distribution_unavailable" });
      return json(
        {
          ok: true,
          range: query.range,
          distribution: distribution.status === "fulfilled" ? distribution.value : null,
          accounts: accounts.status === "fulfilled" ? accounts.value : null,
        },
        200,
      );
    },

    async revenue(request) {
      const query = parseQuery(request);
      if (!query) return badQuery();
      if (!deps.stripe || !deps.catalog) {
        return apiError(503, "billing_unavailable", "Live billing is not configured, so revenue is not shown.");
      }
      const now = deps.now();
      let data: StripeData;
      let fetched: boolean;
      try {
        ({ data, fetched } = await stripeData(query.fresh));
      } catch (error) {
        deps.log({
          level: "warn",
          event: "insights.stripe_unavailable",
          error: error instanceof Error ? error.message : "unknown",
        });
        return apiError(503, "billing_unavailable", "Stripe did not answer. Revenue is not shown rather than guessed.");
      }
      const scan = scanSubscriptions(data.subscriptions, deps.catalog, now);
      if (fetched) await saveSnapshot(scan, now);
      const [grants, snapshots] = await Promise.all([deps.store.billingGrants(), deps.store.snapshots(null)]);
      const revenue = summarizeRevenue({
        scan,
        charges: data.charges,
        refunds: data.refunds,
        grants,
        snapshots,
        range: query.range,
        tzOffsetMinutes: query.tzOffsetMinutes,
        now,
      });
      return json({ ok: true, range: query.range, revenue, cachedAt: new Date(data.at).toISOString() }, 200);
    },

    async snapshot() {
      if (!deps.stripe || !deps.catalog) return;
      const now = deps.now();
      const { data } = await stripeData(true);
      await saveSnapshot(scanSubscriptions(data.subscriptions, deps.catalog, now), now);
    },
  };
}
