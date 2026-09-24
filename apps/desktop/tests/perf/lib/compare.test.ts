// Run with `node --test` (wired into `pnpm test` through the tooling package).
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BudgetFile, checkMetrics, type MetricValue } from "./compare.ts";
import { percentile, summarize } from "./stats.ts";

const ms = (value: number): MetricValue => ({ unit: "ms", better: "lower", value });
const rate = (value: number): MetricValue => ({ unit: "events/s", better: "higher", value });

const budgets: BudgetFile = {
  defaults: { regressionPct: 20 },
  metrics: {
    "startup.cold.windowVisibleMs": { max: 2000, minDelta: 50 },
    "events.append.perSecond": { min: 100, regressionPct: 30 },
  },
};

test("passes within budget and threshold", () => {
  const rows = checkMetrics(
    { "startup.cold.windowVisibleMs": ms(800), "events.append.perSecond": rate(400) },
    budgets,
    { "startup.cold.windowVisibleMs": ms(750), "events.append.perSecond": rate(420) },
  );
  assert.deepEqual(
    rows.map((r) => r.status),
    ["ok", "ok"],
  );
});

test("fails an absolute budget without a baseline", () => {
  const rows = checkMetrics(
    { "startup.cold.windowVisibleMs": ms(2500), "events.append.perSecond": rate(50) },
    budgets,
    null,
  );
  assert.deepEqual(
    rows.map((r) => r.status),
    ["fail", "fail"],
  );
  assert.match(rows[0]?.reasons[0] ?? "", /over budget 2000/);
  assert.match(rows[1]?.reasons[0] ?? "", /under budget 100/);
});

test("fails a regression beyond the percentage and the minimum delta", () => {
  const rows = checkMetrics(
    { "startup.cold.windowVisibleMs": ms(1000), "events.append.perSecond": rate(250) },
    budgets,
    { "startup.cold.windowVisibleMs": ms(700), "events.append.perSecond": rate(400) },
  );
  assert.equal(rows[0]?.status, "fail");
  assert.match(rows[0]?.reasons[0] ?? "", /regressed 42\.9%/);
  assert.equal(rows[1]?.status, "fail", "higher-is-better metric dropped 37.5% > 30%");
});

test("ignores a large relative change below the minimum delta", () => {
  const rows = checkMetrics({ "startup.cold.windowVisibleMs": ms(90), "events.append.perSecond": rate(400) }, budgets, {
    "startup.cold.windowVisibleMs": ms(50),
    "events.append.perSecond": rate(400),
  });
  assert.equal(rows[0]?.status, "ok", "+40 ms is under minDelta 50 even though it is +80%");
});

test("reports a budgeted metric that was not measured", () => {
  const rows = checkMetrics({ "events.append.perSecond": rate(400) }, budgets, null);
  assert.equal(rows[0]?.status, "missing");
});

test("improvements never fail", () => {
  const rows = checkMetrics(
    { "startup.cold.windowVisibleMs": ms(100), "events.append.perSecond": rate(4000) },
    budgets,
    { "startup.cold.windowVisibleMs": ms(700), "events.append.perSecond": rate(400) },
  );
  assert.deepEqual(
    rows.map((r) => r.status),
    ["ok", "ok"],
  );
});

test("stats: interpolated percentiles and summary", () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([10], 95), 10);
  assert.ok(Math.abs(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95) - 9.55) < 1e-9);
  assert.deepEqual(summarize([3, 1, 2]), { n: 3, min: 1, median: 2, mean: 2, p95: 2.9, max: 3 });
  assert.throws(() => summarize([]));
});
