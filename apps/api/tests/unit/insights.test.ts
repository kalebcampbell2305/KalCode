/**
 * Owner revenue math (docs/OWNER_ANALYTICS.md): MRR/ARR normalization, what never counts as
 * revenue, cash collected, plan movements and the service's fail-closed behavior.
 */
import { describe, expect, it } from "vitest";
import { billingPriceCatalog } from "../../worker/lib/billing-plans";
import {
  cashBetween,
  type InsightsStripe,
  insightsService,
  localStarts,
  planMovements,
  scanSubscriptions,
  summarizeRevenue,
} from "../../worker/lib/insights";
import type { MetricSnapshot, OwnerMetricsStore } from "../../worker/lib/owner-metrics-store";

const PRICES = {
  STRIPE_PRICE_PRO: "price_pro_month",
  STRIPE_PRICE_MAX: "price_max_month",
  STRIPE_PRICE_MAX_2X: "price_max2x_month",
  STRIPE_PRICE_PRO_YEARLY: "price_pro_year",
  STRIPE_PRICE_MAX_YEARLY: "price_max_year",
  STRIPE_PRICE_MAX_2X_YEARLY: "price_max2x_year",
};
const catalogResult = billingPriceCatalog(PRICES);
if (!catalogResult.ok) throw new Error("catalog");
const catalog = catalogResult;

const NOW = new Date("2026-10-15T12:00:00.000Z");
const s = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const AMOUNTS: Record<string, [number, "month" | "year"]> = {
  price_pro_month: [1000, "month"],
  price_max_month: [2500, "month"],
  price_max2x_month: [5000, "month"],
  price_pro_year: [10000, "year"],
  price_max_year: [25000, "year"],
  price_max2x_year: [50000, "year"],
};

let seq = 0;
function sub(price: string, overrides: Record<string, unknown> = {}) {
  const [unit_amount, interval] = AMOUNTS[price] ?? [999, "month"];
  return {
    id: `sub_${++seq}`,
    object: "subscription",
    livemode: true,
    status: "active",
    start_date: s("2026-09-01T00:00:00Z"),
    ended_at: null,
    trial_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    discounts: [],
    items: {
      data: [
        { quantity: 1, price: { id: price, unit_amount, currency: "usd", recurring: { interval, interval_count: 1 } } },
      ],
    },
    ...overrides,
  };
}

const summary = (subs: unknown[], extra: Partial<Parameters<typeof summarizeRevenue>[0]> = {}) =>
  summarizeRevenue({
    scan: scanSubscriptions(subs, catalog, NOW),
    charges: [],
    refunds: [],
    grants: [],
    snapshots: [],
    range: "30d",
    tzOffsetMinutes: 0,
    now: NOW,
    ...extra,
  });

describe("MRR and ARR", () => {
  it("normalizes every canonical price to monthly value: yearly counts amount / 12", () => {
    const r = summary(Object.keys(AMOUNTS).map((price) => sub(price)));
    expect(r.byPlan.pro).toMatchObject({ subscribers: 2, monthly: 1, yearly: 1 });
    expect(r.byPlan.pro.mrrCents).toBeCloseTo(1000 + 10000 / 12, 6);
    expect(r.byPlan.max.mrrCents).toBeCloseTo(2500 + 25000 / 12, 6);
    expect(r.byPlan.max2x.mrrCents).toBeCloseTo(5000 + 50000 / 12, 6);
    const mrr = 1000 + 2500 + 5000 + (10000 + 25000 + 50000) / 12;
    expect(r.mrrCents).toBeCloseTo(mrr, 6);
    expect(r.arrCents).toBeCloseTo(mrr * 12, 6);
    expect(r.byPlan.max.arrCents).toBeCloseTo((2500 + 25000 / 12) * 12, 6);
    expect(r.activeSubscribers).toBe(6);
  });

  it("$100/year Pro is exactly $100/12 MRR", () => {
    const r = summary([sub("price_pro_year")]);
    expect(r.mrrCents).toBeCloseTo(10000 / 12, 9);
    expect(r.arrCents).toBeCloseTo(10000, 9);
  });

  it("never counts past-due, trialing, incomplete, canceled, test-mode or foreign-price subscriptions", () => {
    const r = summary([
      sub("price_pro_month", { status: "past_due" }),
      sub("price_pro_month", { status: "trialing" }),
      sub("price_pro_month", { status: "incomplete" }),
      sub("price_pro_month", { status: "incomplete_expired" }),
      sub("price_pro_month", { status: "canceled", ended_at: s("2026-10-01T00:00:00Z") }),
      sub("price_pro_month", { status: "unpaid" }),
      sub("price_pro_month", { livemode: false }),
      sub("price_someone_else"),
      sub("price_pro_month", {
        items: {
          data: [
            {
              quantity: 1,
              price: { id: "price_pro_month", unit_amount: 900, currency: "eur", recurring: { interval: "month" } },
            },
          ],
        },
      }),
    ]);
    expect(r.mrrCents).toBe(0);
    expect(r.activeSubscribers).toBe(0);
    expect(r.pastDue).toBe(1);
    expect(r.trialing).toBe(1);
    expect(r.unrecognized).toBe(2);
  });

  it("keeps a subscription scheduled to cancel until its paid period ends", () => {
    const r = summary([sub("price_max_month", { cancel_at_period_end: true })]);
    expect(r.mrrCents).toBe(2500);
    expect(r.scheduledToCancel).toBe(1);
  });

  it("applies recurring discounts, ignores one-time and expired ones", () => {
    const r = summary([
      sub("price_max_month", { discounts: [{ coupon: { duration: "forever", percent_off: 20 } }] }),
      sub("price_pro_year", { discounts: [{ coupon: { duration: "repeating", amount_off: 1200, currency: "usd" } }] }),
      sub("price_pro_month", { discounts: [{ coupon: { duration: "once", percent_off: 100 } }] }),
      sub("price_pro_month", {
        discounts: [{ end: s("2026-10-01T00:00:00Z"), coupon: { duration: "repeating", percent_off: 50 } }],
      }),
      sub("price_pro_month", { discounts: [{ source: { coupon: { duration: "forever", percent_off: 100 } } }] }),
    ]);
    expect(r.mrrCents).toBeCloseTo(2000 + (10000 - 1200) / 12 + 1000 + 1000 + 0, 6);
  });
});

describe("cash collected", () => {
  const charge = (iso: string, amount: number, overrides: Record<string, unknown> = {}) => ({
    object: "charge",
    livemode: true,
    currency: "usd",
    status: "succeeded",
    paid: true,
    created: s(iso),
    amount,
    amount_captured: amount,
    ...overrides,
  });

  it("is succeeded live charges minus refunds issued in the period, never failed or test payments", () => {
    const from = Date.parse("2026-10-01T00:00:00Z");
    const charges = [
      charge("2026-10-02T00:00:00Z", 1000),
      charge("2026-10-03T00:00:00Z", 2500),
      charge("2026-10-04T00:00:00Z", 5000, { status: "failed", paid: false }),
      charge("2026-10-05T00:00:00Z", 5000, { livemode: false }),
      charge("2026-09-30T23:59:59Z", 1000),
    ];
    const refunds = [
      { object: "refund", status: "succeeded", currency: "usd", amount: 1000, created: s("2026-10-06T00:00:00Z") },
      { object: "refund", status: "failed", currency: "usd", amount: 2500, created: s("2026-10-06T00:00:00Z") },
    ];
    expect(cashBetween(charges, refunds, from, Number.POSITIVE_INFINITY)).toEqual({
      grossCents: 3500,
      refundedCents: 1000,
      netCents: 2500,
    });
  });

  it("separates this month and last month in the owner's time zone", () => {
    // 2026-10-01T03:00Z is still September 30 at UTC-5 (tz offset +300).
    const r = summary([], {
      tzOffsetMinutes: 300,
      charges: [charge("2026-10-01T03:00:00Z", 1000), charge("2026-10-02T12:00:00Z", 2500)],
    });
    expect(r.cash.thisMonth.netCents).toBe(2500);
    expect(r.cash.lastMonth.netCents).toBe(1000);
  });

  it("is reported separately from MRR", () => {
    const r = summary([sub("price_pro_year")], { charges: [charge("2026-10-02T00:00:00Z", 10000)] });
    expect(r.cash.thisMonth.netCents).toBe(10000);
    expect(r.mrrCents).toBeCloseTo(10000 / 12, 6);
  });
});

describe("growth, churn and plan movements", () => {
  it("counts new paid subscriptions and cancellations in range; abandoned checkouts are neither", () => {
    const r = summary([
      sub("price_pro_month", { start_date: s("2026-10-10T00:00:00Z") }),
      sub("price_pro_month", { start_date: s("2026-10-10T00:00:00Z"), status: "incomplete_expired" }),
      sub("price_max_month", {
        start_date: s("2026-08-01T00:00:00Z"),
        status: "canceled",
        ended_at: s("2026-10-12T00:00:00Z"),
      }),
    ]);
    expect(r.movement.newSubscriptions).toBe(1);
    expect(r.movement.cancellations).toBe(1);
  });

  it("computes 30-day churn only when there were subscribers at the start", () => {
    expect(summary([]).churn30d).toEqual({ rate: null, canceled: 0, startingSubscribers: 0 });
    const r = summary([
      sub("price_pro_month", { start_date: s("2026-08-01T00:00:00Z") }),
      sub("price_pro_month", {
        start_date: s("2026-08-01T00:00:00Z"),
        status: "canceled",
        ended_at: s("2026-10-05T00:00:00Z"),
      }),
      sub("price_pro_month", { start_date: s("2026-10-05T00:00:00Z") }),
    ]);
    expect(r.churn30d).toEqual({ rate: 0.5, canceled: 1, startingSubscribers: 2 });
  });

  it("reads upgrades and downgrades from the billing grant history of each subscription", () => {
    const grants = [
      { subscription: "sub_a", tier: "pro" as const, grantedAt: "2026-09-01T00:00:00.000Z" },
      { subscription: "sub_a", tier: "max" as const, grantedAt: "2026-10-10T00:00:00.000Z" },
      { subscription: "sub_a", tier: "max2x" as const, grantedAt: "2026-10-11T00:00:00.000Z" },
      { subscription: "sub_b", tier: "max" as const, grantedAt: "2026-09-01T00:00:00.000Z" },
      { subscription: "sub_b", tier: "pro" as const, grantedAt: "2026-10-12T00:00:00.000Z" },
      { subscription: "sub_c", tier: "max" as const, grantedAt: "2026-10-12T00:00:00.000Z" },
    ];
    expect(planMovements(grants, Date.parse("2026-10-01T00:00:00Z"))).toEqual({ upgrades: 2, downgrades: 1 });
    expect(planMovements(grants, Date.parse("2026-10-11T00:00:00Z"))).toEqual({ upgrades: 1, downgrades: 1 });
  });

  it("charts stored daily snapshots plus today's live value, ARR = MRR × 12", () => {
    const snapshot = (day: string, mrrCents: number): MetricSnapshot => ({
      day,
      capturedAt: `${day}T23:55:00.000Z`,
      paidSubscribers: 1,
      mrrCents,
      byPlan: {
        pro: { subscribers: 1, mrrCents },
        max: { subscribers: 0, mrrCents: 0 },
        max2x: { subscribers: 0, mrrCents: 0 },
      },
    });
    const r = summary([sub("price_max_month")], {
      range: "7d",
      snapshots: [snapshot("2026-09-01", 1000), snapshot("2026-10-14", 1000), snapshot("2026-10-15", 1)],
    });
    expect(r.series).toEqual([
      { day: "2026-10-14", subscribers: 1, mrrCents: 1000, arrCents: 12000 },
      { day: "2026-10-15", subscribers: 1, mrrCents: 2500, arrCents: 30000 },
    ]);
    expect(r.trackingSince).toBe("2026-09-01");
  });

  it("finds the owner's local day and month starts", () => {
    const at = new Date("2026-10-01T03:00:00.000Z");
    expect(new Date(localStarts(at, 300).day).toISOString()).toBe("2026-09-30T05:00:00.000Z");
    expect(new Date(localStarts(at, 300).month).toISOString()).toBe("2026-09-01T05:00:00.000Z");
    expect(new Date(localStarts(at, 0).lastMonth).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});

function memoryStore(): OwnerMetricsStore & { saved: MetricSnapshot[] } {
  const saved: MetricSnapshot[] = [];
  return {
    saved,
    async saveSnapshot(snapshot) {
      saved.push(snapshot);
    },
    async snapshots() {
      return [];
    },
    async billingGrants() {
      return [];
    },
    async accountStats() {
      return { accounts: 3, activated: 2, newSince: 1, everPaid: 1, firstDesktopToday: 0, firstDesktopSince: 1 };
    },
  };
}

function fakeStripe(subscriptions: unknown[] = [sub("price_pro_month")]) {
  const calls = { subscriptions: 0 };
  const stripe: InsightsStripe = {
    async listSubscriptions() {
      calls.subscriptions += 1;
      return subscriptions;
    },
    async listCharges() {
      return [];
    },
    async listRefunds() {
      return [];
    },
  };
  return { stripe, calls };
}

const request = (path: string) => new Request(`https://api.kalcoded.com${path}`);

describe("insights service", () => {
  it("answers 503 for revenue without live billing instead of guessing", async () => {
    const service = insightsService({
      store: memoryStore(),
      distribution: null,
      stripe: null,
      catalog,
      now: () => NOW,
      log: () => {},
    });
    const response = await service.revenue(request("/v1/insights/revenue?range=7d"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: "billing_unavailable" });
  });

  it("answers 503 when Stripe fails, and never leaks the error to the client", async () => {
    const stripe: InsightsStripe = {
      listSubscriptions: () => Promise.reject(new Error("sk_live_secret leaked?")),
      listCharges: async () => [],
      listRefunds: async () => [],
    };
    const logs: Record<string, string>[] = [];
    const service = insightsService({
      store: memoryStore(),
      distribution: null,
      stripe,
      catalog,
      now: () => NOW,
      log: (e) => logs.push(e),
    });
    const response = await service.revenue(request("/v1/insights/revenue"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("sk_live");
  });

  it("rejects malformed queries", async () => {
    const service = insightsService({
      store: memoryStore(),
      distribution: null,
      stripe: null,
      catalog,
      now: () => NOW,
      log: () => {},
    });
    for (const query of ["?range=1y", "?tz=abc", "?tz=9999", "?range=7d&tz=1.5"]) {
      expect((await service.distribution(request(`/v1/insights/distribution${query}`))).status).toBe(400);
    }
  });

  it("serves revenue from live Stripe, caches it a minute, refreshes on demand and snapshots each fetch", async () => {
    const store = memoryStore();
    const { stripe, calls } = fakeStripe();
    let now = NOW;
    const service = insightsService({ store, distribution: null, stripe, catalog, now: () => now, log: () => {} });
    const first = await service.revenue(request("/v1/insights/revenue?range=30d"));
    expect(first.status).toBe(200);
    const body = (await first.json()) as { revenue: { mrrCents: number; arrCents: number } };
    expect(body.revenue.mrrCents).toBe(1000);
    expect(body.revenue.arrCents).toBe(12000);
    expect(first.headers.get("cache-control")).toBe("no-store");
    now = new Date(NOW.getTime() + 30_000);
    await service.revenue(request("/v1/insights/revenue?range=7d"));
    expect(calls.subscriptions).toBe(1);
    await service.revenue(request("/v1/insights/revenue?range=7d&fresh=1"));
    expect(calls.subscriptions).toBe(2);
    expect(store.saved.map((snap) => [snap.day, snap.paidSubscribers, snap.mrrCents])).toEqual([
      ["2026-10-15", 1, 1000],
      ["2026-10-15", 1, 1000],
    ]);
  });

  it("returns distribution counts and account stats, and degrades when the website binding fails", async () => {
    const distribution = { distributionStats: async () => ({ downloads: { today: 4 } }) };
    const service = insightsService({
      store: memoryStore(),
      distribution,
      stripe: null,
      catalog,
      now: () => NOW,
      log: () => {},
    });
    const ok = (await (
      await service.distribution(request("/v1/insights/distribution?range=24h&tz=-60"))
    ).json()) as Record<string, unknown>;
    expect(ok).toMatchObject({
      ok: true,
      range: "24h",
      distribution: { downloads: { today: 4 } },
      accounts: { accounts: 3 },
    });

    const broken = { distributionStats: () => Promise.reject(new Error("down")) };
    const degraded = insightsService({
      store: memoryStore(),
      distribution: broken,
      stripe: null,
      catalog,
      now: () => NOW,
      log: () => {},
    });
    const body = (await (await degraded.distribution(request("/v1/insights/distribution"))).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ ok: true, distribution: null, accounts: { accounts: 3 } });
  });
});
