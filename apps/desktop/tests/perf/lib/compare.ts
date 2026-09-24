/**
 * Budget and regression checks for perf results. A metric fails when it breaks its absolute
 * budget, or when it is worse than the committed baseline by more than `regressionPct` percent
 * AND by more than `minDelta` units (so tiny absolute changes on small numbers are not noise
 * failures).
 */

export interface MetricValue {
  unit: string;
  better: "lower" | "higher";
  value: number;
}

export interface Budget {
  /** Absolute ceiling (lower-is-better metrics). */
  max?: number;
  /** Absolute floor (higher-is-better metrics). */
  min?: number;
  /** Allowed regression vs. the baseline, percent. Falls back to the file default. */
  regressionPct?: number;
  /** Regressions smaller than this (metric units) are ignored. Default 0. */
  minDelta?: number;
}

export interface BudgetFile {
  defaults: { regressionPct: number };
  metrics: Record<string, Budget>;
}

export interface CheckRow {
  metric: string;
  value: number | null;
  baseline: number | null;
  unit: string;
  status: "ok" | "fail" | "missing";
  reasons: string[];
}

export function checkMetrics(
  results: Record<string, MetricValue>,
  budgets: BudgetFile,
  baseline: Record<string, MetricValue> | null,
): CheckRow[] {
  const rows: CheckRow[] = [];
  for (const [metric, budget] of Object.entries(budgets.metrics)) {
    const current = results[metric];
    const base = baseline?.[metric] ?? null;
    if (!current) {
      rows.push({
        metric,
        value: null,
        baseline: base?.value ?? null,
        unit: "",
        status: "missing",
        reasons: ["not measured"],
      });
      continue;
    }
    const reasons: string[] = [];
    const lower = current.better === "lower";
    if (budget.max !== undefined && current.value > budget.max) {
      reasons.push(`over budget ${budget.max} ${current.unit}`);
    }
    if (budget.min !== undefined && current.value < budget.min) {
      reasons.push(`under budget ${budget.min} ${current.unit}`);
    }
    if (base) {
      const pct = budget.regressionPct ?? budgets.defaults.regressionPct;
      const minDelta = budget.minDelta ?? 0;
      const worseBy = lower ? current.value - base.value : base.value - current.value;
      const limit = Math.abs(base.value) * (pct / 100);
      if (worseBy > limit && worseBy > minDelta) {
        const change = base.value === 0 ? "∞" : ((worseBy / Math.abs(base.value)) * 100).toFixed(1);
        reasons.push(`regressed ${change}% vs baseline ${base.value} (allowed ${pct}%, min Δ ${minDelta})`);
      }
    }
    rows.push({
      metric,
      value: current.value,
      baseline: base?.value ?? null,
      unit: current.unit,
      status: reasons.length > 0 ? "fail" : "ok",
      reasons,
    });
  }
  return rows;
}
