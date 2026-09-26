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

test("invalid measurements cannot pass a performance gate", () => {
  for (const value of [null, "100", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const rows = checkMetrics({ "startup.cold.windowVisibleMs": { ...ms(100), value } as MetricValue }, budgets, null);
    assert.equal(rows[0]?.status, "fail", `invalid measurement: ${String(value)}`);
    assert.match(rows[0]?.reasons.join(" ") ?? "", /finite number/);
  }
});

test("invalid baseline measurements cannot hide regressions", () => {
  for (const value of [null, "100", Number.NaN, Number.POSITIVE_INFINITY]) {
    const rows = checkMetrics({ "startup.cold.windowVisibleMs": ms(1000) }, budgets, {
      "startup.cold.windowVisibleMs": { ...ms(100), value } as MetricValue,
    });
    assert.equal(rows[0]?.status, "fail", `invalid baseline: ${String(value)}`);
    assert.match(rows[0]?.reasons.join(" ") ?? "", /baseline.*finite number/);
  }
});

test("baseline units and improvement direction must match the current measurement", () => {
  for (const current of [
    { ...ms(1000), unit: "s" },
    { ...ms(1000), better: "higher" as const },
  ]) {
    const rows = checkMetrics({ "startup.cold.windowVisibleMs": current }, budgets, {
      "startup.cold.windowVisibleMs": ms(100),
    });
    assert.equal(rows[0]?.status, "fail");
    assert.match(rows[0]?.reasons.join(" ") ?? "", /baseline.*(unit|direction)/);
  }
});

test("measurements require units and a known improvement direction", () => {
  for (const current of [
    { ...ms(100), unit: "" },
    { ...ms(100), better: "unknown" },
  ]) {
    const rows = checkMetrics({ "startup.cold.windowVisibleMs": current as MetricValue }, budgets, null);
    assert.equal(rows[0]?.status, "fail");
  }
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

test("invalid budget thresholds cannot disable an absolute or regression check", () => {
  for (const field of ["min", "max", "regressionPct", "minDelta"]) {
    for (const value of [null, "20", Number.NaN, Number.POSITIVE_INFINITY]) {
      const invalid = {
        defaults: { regressionPct: 20 },
        metrics: { startup: { [field]: value } },
      } as BudgetFile;
      assert.throws(() => checkMetrics({ startup: ms(500) }, invalid, { startup: ms(100) }), /budget.*finite number/i);
    }
  }
});

test("malformed and contradictory budget definitions are rejected", () => {
  const invalidBudgets = [
    { defaults: { regressionPct: 20 }, metrics: {} },
    { defaults: { regressionPct: 20 }, metrics: [] },
    { defaults: { regressionPct: "not a number" }, metrics: { startup: { max: 2000 } } },
    { defaults: { regressionPct: -1 }, metrics: { startup: { max: 2000 } } },
    { defaults: { regressionPct: 20 }, metrics: { startup: { regressionPct: -1 } } },
    { defaults: { regressionPct: 20 }, metrics: { startup: { minDelta: -1 } } },
    { defaults: { regressionPct: 20 }, metrics: { startup: { min: 2000, max: 1000 } } },
    { defaults: { regressionPct: 20 }, metrics: { startup: "not a budget" } },
  ];
  for (const invalid of invalidBudgets) {
    assert.throws(() => checkMetrics({ startup: ms(500) }, invalid as BudgetFile, null), /budget/i);
  }
});

test("a metric cannot pass when no absolute limit or comparable baseline is available", () => {
  for (const budget of [{}, { regressionPct: 20 }]) {
    const rows = checkMetrics(
      { startup: ms(999999) },
      { defaults: { regressionPct: 20 }, metrics: { startup: budget } },
      null,
    );
    assert.equal(rows[0]?.status, "fail");
    assert.match(rows[0]?.reasons.join(" ") ?? "", /no absolute limit or baseline/);
  }
  const rows = checkMetrics(
    { startup: ms(110) },
    { defaults: { regressionPct: 20 }, metrics: { startup: {} } },
    { startup: ms(100) },
  );
  assert.equal(rows[0]?.status, "ok", "the default regression limit remains usable with a real baseline");
});

test("misspelled budget fields cannot silently disable limits", () => {
  for (const budget of [{ mx: 2000 }, { max: 2000, regresionPct: 1 }]) {
    assert.throws(
      () =>
        checkMetrics(
          { startup: ms(115) },
          { defaults: { regressionPct: 20 }, metrics: { startup: budget } } as BudgetFile,
          { startup: ms(100) },
        ),
      /budget.*unknown/i,
    );
  }
});

test("a present malformed baseline measurement cannot be treated as an absent sample", () => {
  for (const value of [null, false, 0, ""]) {
    const rows = checkMetrics(
      { startup: ms(1500) },
      { defaults: { regressionPct: 20 }, metrics: { startup: { max: 2000 } } },
      { startup: value } as unknown as Record<string, MetricValue>,
    );
    assert.equal(rows[0]?.status, "fail", `malformed baseline: ${String(value)}`);
    assert.match(rows[0]?.reasons.join(" ") ?? "", /baseline.*object/i);
  }
});
