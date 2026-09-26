import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  auditRustIntentionalIgnores,
  auditWorkspaceSuiteCoverage,
  loadTestSuiteInventory,
  parseCargoTestReport,
  parseNodeTestReport,
  parsePlaywrightReport,
  parseVitestReport,
  runSuite,
  selectProfile,
  selectSuites,
  validateInventory,
  validateSuiteResult,
} from "./test-suites.mjs";

const inventory = loadTestSuiteInventory();

test("the registered Rust release gate includes the production speech engine and exact target ignore counts", () => {
  const rust = inventory.suites.find(({ id }) => id === "rust-workspace");
  assert.deepEqual(rust.command, ["cargo", "test", "--workspace", "--features", "kalcode-desktop/kalvoice-whisper"]);
  for (const [platform, expected] of [
    ["win32", 16],
    ["darwin", 16],
    // The pinned runtime and local-reasoning probes only compile on Windows x64/Mac ARM64.
    ["linux", 14],
  ]) {
    const profile = selectProfile(rust, platform, {});
    assert.equal(profile.skippedMinimum, expected);
    assert.equal(profile.skippedMaximum, expected);
  }
  assert.equal(inventory.rustIntentionalIgnores.length, 16);
});

test("the registered Vitest command writes and validates its real JSON report", () => {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = runSuite(
    inventory.suites.find(({ id }) => id === "protocol-unit"),
    { environment },
  );
  assert.ok(result.executed >= 56);
  assert.equal(result.failed, 0);
});

test("the registered runner launches a real package suite and retains its exit status", () => {
  const root = mkdtempSync(join(tmpdir(), "kalcode gate fixture "));
  const environment = { ...process.env };
  // Launch an independent CLI gate, rather than Node's nested-test IPC reporter.
  delete environment.NODE_TEST_CONTEXT;
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "@kalcode/gate-fixture",
        private: true,
        scripts: { test: "node --test fixture.test.cjs", fail: 'node -e "process.exit(2)"' },
      }),
    );
    writeFileSync(
      join(root, "fixture.test.cjs"),
      "const test = require('node:test'); test('one', () => {}); test('two', () => {});\n",
    );
    const selected = suite({ package: "@kalcode/gate-fixture" });
    assert.equal(runSuite(selected, { root, environment }).executed, 2);
    assert.throws(
      () => runSuite({ ...selected, script: "fail" }, { root, environment }),
      /did not complete successfully/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function suite(overrides = {}) {
  return {
    id: "fixture-unit",
    group: "unit",
    runner: "node",
    package: "@kalcode/tooling",
    script: "test",
    command: null,
    timeoutMs: 10_000,
    profiles: [
      {
        platforms: ["win32", "darwin", "linux"],
        environment: {},
        minimumExecuted: 2,
        skippedMinimum: 0,
        skippedMaximum: 0,
        allowedSkipReasons: [],
        maximumFlaky: 0,
      },
    ],
    unavailableReason: null,
    ...overrides,
  };
}

function nodeSummary({ tests, pass, fail = 0, skipped = 0, cancelled = 0, todo = 0 }) {
  return `
ℹ tests ${tests}
ℹ suites 0
ℹ pass ${pass}
ℹ fail ${fail}
ℹ cancelled ${cancelled}
ℹ skipped ${skipped}
ℹ todo ${todo}
`;
}

function playwrightReport({ expected = 2, unexpected = 0, flaky = 0, skipped = [] } = {}) {
  const tests = Array.from({ length: expected + unexpected + flaky }, (_, index) => ({
    expectedStatus: "passed",
    annotations: [],
    results: [{ status: index < unexpected ? "failed" : "passed" }],
  }));
  tests.push(
    ...skipped.map((description) => ({
      expectedStatus: "skipped",
      annotations: [{ type: "skip", description }],
      results: [{ status: "skipped" }],
    })),
  );
  return {
    suites: [{ specs: [{ tests }] }],
    stats: { expected, unexpected, flaky, skipped: skipped.length },
  };
}

test("the reviewed inventory covers every required workspace suite and Rust ignore", () => {
  assert.equal(inventory.suites.length, 10);
  assert.deepEqual(
    inventory.suites.map(({ id }) => id),
    [
      "desktop-unit",
      "website-unit",
      "api-unit",
      "protocol-unit",
      "testing-unit",
      "ui-unit",
      "tooling-unit",
      "rust-workspace",
      "desktop-native-e2e",
      "website-e2e",
    ],
  );
  auditWorkspaceSuiteCoverage(inventory);
  auditRustIntentionalIgnores(inventory);
});

test("a removed package suite or registered script requires inventory review", () => {
  const missing = structuredClone(inventory);
  missing.suites = missing.suites.filter(({ id }) => id !== "protocol-unit");
  assert.throws(() => auditWorkspaceSuiteCoverage(missing), /does not match workspace scripts/);

  const stale = structuredClone(inventory);
  stale.suites.find(({ id }) => id === "protocol-unit").script = "missing-test";
  assert.throws(() => auditWorkspaceSuiteCoverage(stale), /does not match workspace scripts/);
});

test("inventory validation rejects a zero floor and overlapping authority fields", () => {
  const zero = structuredClone(inventory);
  zero.suites[0].profiles[0].minimumExecuted = 0;
  assert.throws(() => validateInventory(zero), /fail closed above zero/);

  const duplicate = structuredClone(inventory);
  duplicate.suites.push(structuredClone(duplicate.suites[0]));
  assert.throws(() => validateInventory(duplicate), /duplicate test suite id/);
});

test("Vitest JSON counts executed tests and rejects inconsistent summaries", () => {
  assert.deepEqual(
    parseVitestReport({
      numPassedTests: 8,
      numFailedTests: 0,
      numPendingTests: 1,
      numTodoTests: 1,
      numTotalTests: 10,
    }),
    { executed: 8, failed: 0, skipped: 2, flaky: 0, skipReasons: [] },
  );
  assert.throws(
    () =>
      parseVitestReport({
        numPassedTests: 8,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        numTotalTests: 9,
      }),
    /inconsistent/,
  );
});

test("Node summaries are exact and ambiguous or partial output fails closed", () => {
  assert.deepEqual(parseNodeTestReport(nodeSummary({ tests: 3, pass: 2, skipped: 1 })), {
    executed: 2,
    failed: 0,
    skipped: 1,
    flaky: 0,
    skipReasons: [],
  });
  assert.throws(() => parseNodeTestReport("# tests 3\n# pass 3\n"), /missing or ambiguous/);
  assert.throws(() => parseNodeTestReport(`${nodeSummary({ tests: 2, pass: 2 })}\n# tests 2`), /missing or ambiguous/);
});

test("Cargo parsing aggregates harnesses and rejects filtering", () => {
  assert.deepEqual(
    parseCargoTestReport(`
test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`),
    { executed: 5, failed: 0, skipped: 1, flaky: 0, skipReasons: [] },
  );
  assert.throws(
    () => parseCargoTestReport("test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out"),
    /filtered/,
  );
  assert.throws(() => parseCargoTestReport("Finished test profile"), /no harness summaries/);
});

test("Playwright JSON preserves failures, flaky results, and explicit skip reasons", () => {
  assert.deepEqual(parsePlaywrightReport(playwrightReport({ expected: 2, skipped: ["No stage components on /"] })), {
    executed: 2,
    failed: 0,
    skipped: 1,
    flaky: 0,
    skipReasons: ["No stage components on /"],
  });
  assert.throws(
    () => parsePlaywrightReport({ suites: [], stats: { expected: 2, unexpected: 0, flaky: 0, skipped: 0 } }),
    /inconsistent/,
  );
});

test("result policy allows increases and denies zero, reductions, failures, flakes, and skip drift", () => {
  const selected = suite();
  const profile = selectProfile(selected, "win32", {});
  assert.equal(
    validateSuiteResult(selected, profile, {
      executed: 3,
      failed: 0,
      skipped: 0,
      flaky: 0,
      skipReasons: [],
    }).executed,
    3,
  );
  for (const result of [
    { executed: 0, failed: 0, skipped: 0, flaky: 0, skipReasons: [] },
    { executed: 1, failed: 0, skipped: 0, flaky: 0, skipReasons: [] },
    { executed: 2, failed: 1, skipped: 0, flaky: 0, skipReasons: [] },
    { executed: 2, failed: 0, skipped: 1, flaky: 0, skipReasons: [] },
    { executed: 2, failed: 0, skipped: 0, flaky: 1, skipReasons: [] },
  ]) {
    assert.throws(() => validateSuiteResult(selected, profile, result));
  }
});

test("tooling profiles account exactly for Windows-only signer and workflow execution", () => {
  const tooling = inventory.suites.find(({ id }) => id === "tooling-unit");
  assert.equal(selectProfile(tooling, "win32", {}).skippedMaximum, 0);
  for (const platform of ["darwin", "linux"]) {
    const profile = selectProfile(tooling, platform, {});
    const result = { executed: profile.minimumExecuted, failed: 0, skipped: 2, flaky: 0, skipReasons: [] };
    assert.doesNotThrow(() => validateSuiteResult(tooling, profile, result));
    for (const skipped of [1, 3]) {
      assert.throws(() => validateSuiteResult(tooling, profile, { ...result, skipped }), /reviewed bounds/);
    }
  }
});

test("website skip profiles require reviewed counts and runtime reasons", () => {
  const website = inventory.suites.find(({ id }) => id === "website-e2e");
  const defaultProfile = selectProfile(website, "win32", {});
  assert.equal(defaultProfile.skippedMinimum, 8);
  const configuredProfile = selectProfile(website, "win32", { STAGE_URL: "/product" });
  assert.equal(configuredProfile.skippedMaximum, 16);
  assert.doesNotThrow(() =>
    validateSuiteResult(website, configuredProfile, {
      executed: 152,
      failed: 0,
      skipped: 1,
      flaky: 0,
      skipReasons: ["TryKalCode is not on /product"],
    }),
  );
  assert.throws(
    () =>
      validateSuiteResult(website, configuredProfile, {
        executed: 152,
        failed: 0,
        skipped: 1,
        flaky: 0,
        skipReasons: ["silently disabled"],
      }),
    /unreviewed skip reason/,
  );
});

test("native E2E is explicitly blocked where no reviewed harness exists", () => {
  const native = inventory.suites.find(({ id }) => id === "desktop-native-e2e");
  assert.throws(() => selectProfile(native, "darwin", {}), /BLOCKED.*native Mac harness/);
  assert.equal(selectProfile(native, "win32", {}).minimumExecuted, 23);
});

test("suite selection is explicit and cannot silently omit an unknown suite", () => {
  assert.equal(selectSuites(inventory, ["run", "unit"]).length, 8);
  assert.equal(selectSuites(inventory, ["run", "e2e"]).length, 2);
  assert.equal(selectSuites(inventory, ["run", "all"]).length, 10);
  assert.deepEqual(
    selectSuites(inventory, ["--suite", "api-unit"]).map(({ id }) => id),
    ["api-unit"],
  );
  assert.throws(() => selectSuites(inventory, ["--suite", "missing"]), /usage/);
});

test("subprocess failures suppress captured output and zero-test success is denied", () => {
  const selected = suite();
  const failedSpawn = () => ({
    status: 2,
    signal: null,
    error: null,
    stdout: "private prompt contents",
    stderr: "secret-shaped test fixture",
  });
  assert.throws(
    () => runSuite(selected, { platform: "win32", environment: {}, spawn: failedSpawn }),
    (error) =>
      error instanceof Error &&
      /output suppressed/.test(error.message) &&
      !error.message.includes("private prompt") &&
      !error.message.includes("secret-shaped"),
  );

  const zeroSpawn = () => ({
    status: 0,
    signal: null,
    error: null,
    stdout: nodeSummary({ tests: 0, pass: 0 }),
    stderr: "",
  });
  assert.throws(
    () => runSuite(selected, { platform: "win32", environment: {}, spawn: zeroSpawn }),
    /executed zero tests/,
  );
});
