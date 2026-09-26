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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBudgetFile(budgets: BudgetFile): void {
  if (!isRecord(budgets) || !isRecord(budgets.defaults) || !isRecord(budgets.metrics)) {
    throw new Error("Invalid performance budget: defaults and metrics must be objects");
  }
  if (!Number.isFinite(budgets.defaults.regressionPct) || budgets.defaults.regressionPct < 0) {
    throw new Error("Invalid performance budget: default regressionPct must be a nonnegative finite number");
  }
  if (Object.keys(budgets.metrics).length === 0) {
    throw new Error("Invalid performance budget: at least one metric is required");
  }
  for (const [metric, budget] of Object.entries(budgets.metrics)) {
    if (!isRecord(budget)) throw new Error(`Invalid performance budget for ${metric}: expected an object`);
    for (const field of Object.keys(budget)) {
      if (!["min", "max", "regressionPct", "minDelta"].includes(field)) {
        throw new Error(`Invalid performance budget for ${metric}: unknown field ${field}`);
      }
    }
    for (const field of ["min", "max", "regressionPct", "minDelta"] as const) {
      if (budget[field] !== undefined && !Number.isFinite(budget[field])) {
        throw new Error(`Invalid performance budget for ${metric}: ${field} must be a finite number`);
      }
    }
    if (
      (typeof budget.regressionPct === "number" && budget.regressionPct < 0) ||
      (typeof budget.minDelta === "number" && budget.minDelta < 0)
    ) {
      throw new Error(`Invalid performance budget for ${metric}: regressionPct and minDelta must be nonnegative`);
    }
    if (typeof budget.min === "number" && typeof budget.max === "number" && budget.min > budget.max) {
      throw new Error(`Invalid performance budget for ${metric}: min must not exceed max`);
    }
  }
}

export function checkMetrics(
  results: Record<string, MetricValue>,
  budgets: BudgetFile,
  baseline: Record<string, MetricValue> | null,
): CheckRow[] {
  validateBudgetFile(budgets);
  const rows: CheckRow[] = [];
  for (const [metric, budget] of Object.entries(budgets.metrics)) {
    const current = results[metric];
    const hasBaseline = baseline !== null && Object.hasOwn(baseline, metric);
    const base = hasBaseline ? baseline[metric] : null;
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
    if (hasBaseline && !isRecord(base)) reasons.push("baseline measurement must be an object");
    if (!hasBaseline && budget.min === undefined && budget.max === undefined) {
      reasons.push("no absolute limit or baseline is available for this metric");
    }
    if (!Number.isFinite(current.value)) reasons.push("measurement must be a finite number");
    if (typeof current.unit !== "string" || current.unit.trim().length === 0) {
      reasons.push("measurement must have a unit");
    }
    if (current.better !== "lower" && current.better !== "higher") {
      reasons.push("measurement must have a known improvement direction");
    }
    if (base) {
      if (!Number.isFinite(base.value)) reasons.push("baseline measurement must be a finite number");
      if (base.unit !== current.unit) reasons.push("baseline unit does not match measurement");
      if (base.better !== current.better) reasons.push("baseline improvement direction does not match measurement");
    }
    if (reasons.length > 0) {
      rows.push({
        metric,
        value: Number.isFinite(current.value) ? current.value : null,
        baseline: base && Number.isFinite(base.value) ? base.value : null,
        unit: typeof current.unit === "string" ? current.unit : "",
        status: "fail",
        reasons,
      });
      continue;
    }
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
