import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const report = {
  kind: "kalcode-perf",
  platform: "windows-x64",
  createdAt: "2026-09-25T00:00:00Z",
  metrics: { startup: { value: 100, unit: "ms", better: "lower" } },
};

function check(
  current: unknown,
  baseline: unknown,
  options: string[] = [],
  budgets: unknown = { defaults: { regressionPct: 20 }, metrics: { startup: { max: 2000 } } },
) {
  const dir = mkdtempSync(join(tmpdir(), "kalcode-perf-gate-"));
  try {
    const resultsPath = join(dir, "results.json");
    const baselinePath = join(dir, "baseline.json");
    const budgetsPath = join(dir, "budgets.json");
    writeFileSync(resultsPath, JSON.stringify(current));
    if (baseline !== undefined) writeFileSync(baselinePath, JSON.stringify(baseline));
    writeFileSync(budgetsPath, JSON.stringify(budgets));
    return spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "check.ts"),
        resultsPath,
        "--budgets",
        budgetsPath,
        "--baseline",
        baselinePath,
        ...options,
      ],
      { encoding: "utf8", windowsHide: true },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("performance CLI accepts compatible valid reports", () => {
  const result = check(report, report);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /All 1 perf checks passed/);
});

test("performance CLI rejects JSON null produced by a non-finite measurement", () => {
  const result = check({ ...report, metrics: { startup: { ...report.metrics.startup, value: Number.NaN } } }, report);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /finite number/);
});

test("performance CLI refuses a baseline from a different platform", () => {
  const result = check(report, { ...report, platform: "macos-arm64" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /platform/);
});

test("performance CLI refuses a baseline of a different report kind", () => {
  const result = check(report, { ...report, kind: "unrelated-report" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /KalCode perf/);
});

test("performance CLI does not silently ignore an explicitly missing baseline", () => {
  const result = check(report, undefined);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /baseline/i);
});

test("performance CLI allows explicitly disabling the baseline", () => {
  const result = check(report, undefined, ["--no-baseline"]);
  assert.equal(result.status, 0, result.stderr);
});

test("performance CLI rejects an empty budget instead of passing zero checks", () => {
  const result = check(report, report, [], { defaults: { regressionPct: 20 }, metrics: {} });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /budget.*at least one/i);
  assert.doesNotMatch(result.stdout, /passed/);
});

test("performance CLI rejects invalid budget limits instead of disabling comparisons", () => {
  for (const max of ["fast", null]) {
    const result = check(report, report, [], { defaults: { regressionPct: 20 }, metrics: { startup: { max } } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /budget.*finite number/i);
  }
});

test("performance CLI refuses a supplied baseline without its measurement map", () => {
  for (const metrics of [undefined, null, [], "missing"]) {
    const result = check(report, { ...report, metrics });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /metrics/i);
  }
});
