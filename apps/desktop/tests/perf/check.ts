/**
 * Fails (exit 1) when a perf result breaks a budget or regresses beyond its threshold against
 * the committed baseline for this platform.
 *
 *   node apps/desktop/tests/perf/check.ts <results.json> [--baseline file] [--budgets file] [--no-baseline]
 *
 * Budgets: tests/perf/budgets.json. Baselines: tests/perf/baselines/<platform>.json (a full
 * results.json from the reference machine; see docs/PERFORMANCE.md for how to refresh it).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type BudgetFile, checkMetrics, type MetricValue } from "./lib/compare.ts";
import { round } from "./lib/stats.ts";

interface ResultsFile {
  kind: string;
  platform: string;
  createdAt: string;
  metrics: Record<string, MetricValue>;
}

function load<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadResults(path: string): ResultsFile {
  const report = load<ResultsFile>(path);
  if (report?.kind !== "kalcode-perf") {
    throw new Error(`${path} is not a KalCode perf results file`);
  }
  if (!report.metrics || typeof report.metrics !== "object" || Array.isArray(report.metrics)) {
    throw new Error(`${path} must contain a metrics object`);
  }
  return report;
}

function main(): number {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      baseline: { type: "string" },
      budgets: { type: "string" },
      "no-baseline": { type: "boolean", default: false },
    },
  });
  const here = import.meta.dirname;
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const [resultsArg] = positionals;
  if (!resultsArg) {
    throw new Error("Usage: node apps/desktop/tests/perf/check.ts <results.json> [--baseline file] [--budgets file]");
  }
  const results = loadResults(resolve(cwd, resultsArg));
  const budgets = load<BudgetFile>(values.budgets ? resolve(cwd, values.budgets) : join(here, "budgets.json"));
  const baselinePath = values.baseline
    ? resolve(cwd, values.baseline)
    : join(here, "baselines", `${results.platform}.json`);
  let baseline: ResultsFile | null = null;
  if (!values["no-baseline"]) {
    if (existsSync(baselinePath)) {
      baseline = loadResults(baselinePath);
      if (baseline.platform !== results.platform) {
        throw new Error(`Baseline platform ${baseline.platform} does not match results platform ${results.platform}`);
      }
    } else if (values.baseline) {
      throw new Error(`Explicit baseline does not exist: ${baselinePath}`);
    } else console.warn(`No baseline for ${results.platform} (${baselinePath}); checking absolute budgets only.`);
  }

  const rows = checkMetrics(results.metrics, budgets, baseline?.metrics ?? null);
  console.log(
    `Perf check: ${results.platform}, run ${results.createdAt}` +
      (baseline ? ` vs baseline ${baseline.createdAt}` : " (no baseline)"),
  );
  for (const row of rows) {
    const status = row.status === "ok" ? "ok  " : row.status === "fail" ? "FAIL" : "MISS";
    const value = row.value === null ? "—" : `${round(row.value)} ${row.unit}`;
    const base = row.baseline === null ? "" : ` (baseline ${row.baseline})`;
    console.log(
      `  ${status} ${row.metric}: ${value}${base}${row.reasons.length ? ` — ${row.reasons.join("; ")}` : ""}`,
    );
  }
  const failed = rows.filter((row) => row.status !== "ok");
  if (failed.length > 0) {
    console.error(`\n${failed.length} perf check(s) failed.`);
    return 1;
  }
  console.log(`\nAll ${rows.length} perf checks passed.`);
  return 0;
}

// Let Node drain diagnostics and close its handles normally, including on Windows.
try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid performance input");
  process.exitCode = 2;
}
