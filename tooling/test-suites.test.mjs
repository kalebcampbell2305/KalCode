import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  auditRustIntentionalIgnores,
  auditWorkspaceSuiteCoverage,
  detectWindowsSessionZero,
  flakyReport,
  loadTestSuiteInventory,
  parseCargoTestReport,
  parseNodeTestReport,
  parsePlaywrightReport,
  parseVitestReport,
  playwrightFlakyTitles,
  reportFailureNames,
  runSuite,
  selectProfile,
  selectSuites,
  validateInventory,
  validateSuiteResult,
  WINDOWS_SESSION_ZERO_PROFILE_ENV,
} from "./test-suites.mjs";

const inventory = loadTestSuiteInventory();

test("the registered Rust release gate includes the production speech engine and exact target ignore counts", () => {
  const rust = inventory.suites.find(({ id }) => id === "rust-workspace");
  assert.deepEqual(rust.command, ["cargo", "test", "--workspace", "--features", "kalcode-desktop/kalvoice-whisper"]);
  // The official Cursor installation probe is intentionally opt-in on every platform; so are the
  // real-Codex hook probes (AI quota) and the PTY/process-scan benchmarks (#238, #239).
  for (const [platform, expected] of [
    // The netstat CPU benchmark only compiles on Windows.
    ["win32", 36],
    ["darwin", 35],
    // The pinned runtime and local-reasoning probes only compile on Windows x64/Mac ARM64.
    ["linux", 32],
  ]) {
    const profile = selectProfile(rust, platform, {});
    assert.equal(profile.skippedMinimum, expected);
    assert.equal(profile.skippedMaximum, expected);
  }
  assert.equal(inventory.rustIntentionalIgnores.length, 36);
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

test("the Rust workspace suite builds the desktop crate with the Dev identity overlay", () => {
  const rust = inventory.suites.find(({ id }) => id === "rust-workspace");
  let launched = null;
  const spawn = (file, args, options) => {
    launched = { file, args, env: options.env };
    return { status: 1, signal: null, error: null, stdout: "", stderr: "" };
  };
  assert.throws(() => runSuite(rust, { platform: "win32", environment: { KEEP: "yes" }, spawn }));
  assert.equal(launched.file, "cargo");
  assert.deepEqual(launched.args, rust.command.slice(1));
  assert.equal(launched.env.KEEP, "yes");
  assert.equal(JSON.parse(launched.env.TAURI_CONFIG).identifier, "com.kalcode.desktop.dev");
});

test("the gate's Vitest worker budget reaches the child command and rejects invalid values", () => {
  const selected = inventory.suites.find(({ id }) => id === "protocol-unit");
  let launched;
  const spawn = (_file, args) => {
    launched = args;
    return { status: 1, signal: null, error: null, stdout: "", stderr: "" };
  };
  assert.throws(() => runSuite(selected, { platform: "linux", environment: { VITEST_MAX_WORKERS: "2" }, spawn }));
  assert.ok(launched.includes("--maxWorkers=2"));
  launched = null;
  assert.throws(
    () => runSuite(selected, { platform: "linux", environment: { VITEST_MAX_WORKERS: "2;bad" }, spawn }),
    /Invalid VITEST_MAX_WORKERS/,
  );
  assert.equal(launched, null);
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

test("a failed Vitest or Playwright run names its failed tests from the report", () => {
  const vitest = {
    testResults: [
      {
        name: "C:/repo/apps/desktop/src/a.test.tsx",
        status: "failed",
        assertionResults: [
          { status: "passed", fullName: "ok" },
          { status: "failed", fullName: "pane > restores", failureMessages: ["AssertionError: expected 1\n at x"] },
        ],
      },
      {
        name: "/repo/apps/desktop/src/b.test.ts",
        status: "failed",
        message: "Failed to load url ./missing",
        assertionResults: [],
      },
    ],
  };
  assert.deepEqual(reportFailureNames(vitest), [
    "desktop/src/a.test.tsx › pane > restores — AssertionError: expected 1",
    "desktop/src/b.test.ts — Failed to load url ./missing",
  ]);
  const unexpected = { status: "unexpected", results: [{ error: { message: "Timeout\nmore" } }] };
  const playwright = {
    suites: [{ specs: [{ file: "x.spec.ts", title: "drag", tests: [unexpected] }] }],
    errors: [{ message: "webServer failed" }],
  };
  assert.deepEqual(reportFailureNames(playwright), ["x.spec.ts › drag — Timeout", "run error — webServer failed"]);
  assert.deepEqual(reportFailureNames(null), []);
});

test("a flaky Playwright gate names its flaky tests", () => {
  const report = {
    suites: [
      {
        file: "home.spec.ts",
        specs: [
          { file: "home.spec.ts", title: "stable", tests: [{ status: "expected" }] },
          { file: "home.spec.ts", title: "demo opens", tests: [{ status: "flaky" }] },
        ],
        suites: [{ specs: [{ file: "nested.spec.ts", title: "tour", tests: [{ status: "flaky" }] }] }],
      },
    ],
  };
  assert.deepEqual(playwrightFlakyTitles(report), ["home.spec.ts › demo opens", "nested.spec.ts › tour"]);
  assert.deepEqual(playwrightFlakyTitles({}), []);
});

test("a flaky Playwright test carries the first line of its failed attempt's error", () => {
  const report = {
    suites: [
      {
        file: "pages.spec.ts",
        specs: [
          {
            file: "pages.spec.ts",
            title: "/kalvoice renders",
            tests: [
              {
                status: "flaky",
                results: [
                  {
                    status: "failed",
                    error: { message: "\u001b[31mError: expect(received).toEqual(expected)\u001b[39m\n\n- []" },
                  },
                  { status: "passed" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(playwrightFlakyTitles(report), [
    "pages.spec.ts › /kalvoice renders [Error: expect(received).toEqual(expected)]",
  ]);
});

test("the reviewed inventory covers every required workspace suite and Rust ignore", () => {
  assert.equal(inventory.suites.length, 13);
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
      "desktop-ui-functional-e2e",
      "desktop-ui-visual-e2e",
      "website-e2e",
      "website-checkout-enabled-e2e",
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

  const explicitUi = inventory.suites.filter(({ id }) => id.startsWith("desktop-ui-"));
  assert.deepEqual(
    explicitUi.map(({ script }) => script),
    ["test:ui:functional", "test:ui:visual-ci"],
  );
  assert.doesNotThrow(() => auditWorkspaceSuiteCoverage(inventory));
});

function listedDesktopUiTests(script, args = []) {
  const root = join(import.meta.dirname, "..");
  const commandArgs = ["--filter", "@kalcode/desktop", script, "--list", ...args];
  let file = "pnpm";
  let spawnArgs = commandArgs;
  if (process.platform === "win32") {
    const literal = (value) => `'${value.replaceAll("'", "''")}'`;
    const script = `& 'pnpm.cmd' ${commandArgs.map(literal).join(" ")}; exit $LASTEXITCODE`;
    file = "powershell.exe";
    spawnArgs = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  }
  const child = spawnSync(file, spawnArgs, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(child.error, undefined, "Playwright list command must complete within its bound");
  assert.equal(child.status, 0, "Playwright must list the desktop UI partition");
  return new Set(
    child.stdout
      .replaceAll("\r", "")
      .split("\n")
      .map((line) => /^\s*\[chromium\] › (.+)$/u.exec(line)?.[1])
      .filter(Boolean),
  );
}

function assertLinuxRustDiskReclaim(workflow) {
  const rustJob = workflow.split("\n  rust:\n")[1]?.split("\n  cargo-deny:\n")[0] ?? "";
  const checkout = rustJob.indexOf("      - uses: actions/checkout@");
  const reclaim = rustJob.indexOf("      - name: Reclaim unused Linux hosted SDK space\n");
  const systemLibraries = rustJob.indexOf("      - name: Linux system libraries for Tauri\n");
  assert.ok(checkout >= 0 && reclaim > checkout && systemLibraries > reclaim);

  const reclaimStep = rustJob.slice(reclaim, systemLibraries);
  assert.match(reclaimStep, /if: matrix\.os == 'ubuntu-latest'/u);
  assert.match(reclaimStep, /\[\[ "\$\{RUNNER_ENVIRONMENT:-\}" != "github-hosted" \]\]/u);

  const roots = /readonly -a sdk_roots=\(\n(?<roots>[\s\S]*?)\n\s+\)/u.exec(reclaimStep)?.groups?.roots;
  assert.deepEqual(
    roots
      ?.split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    ["/usr/local/lib/android", "/usr/share/dotnet"],
  );
  assert.ok(reclaimStep.includes('if [[ -L "$sdk_root" ]]; then'));
  assert.ok(reclaimStep.includes('resolved="$(realpath -e -- "$sdk_root")"'));
  assert.ok(reclaimStep.includes('if [[ "$resolved" != "$sdk_root" ]]; then'));
  assert.ok(
    reclaimStep.includes(
      'if [[ "$resolved" == "$protected_root" || "$resolved" == "$protected_root"/* || "$protected_root" == "$resolved"/* ]]; then',
    ),
  );
  assert.ok(reclaimStep.includes('sudo rm -rf --one-file-system -- "$resolved"'));
  assert.ok(reclaimStep.includes('if [[ -e "$resolved" || -L "$resolved" ]]; then'));
  assert.ok(reclaimStep.includes("removed_count > 0 && available_after <= available_before"));

  assert.match(rustJob, /matrix:\n\s+os: \[windows-latest, macos-latest, ubuntu-latest\]/u);
  for (const command of [
    "      - run: cargo fmt --all -- --check",
    "      - run: cargo clippy --workspace --all-targets -- -D warnings",
    "      - run: cargo test --workspace",
  ]) {
    assert.equal(rustJob.split(command).length - 1, 1, `${command.trim()} must remain exact`);
  }
}

test("Linux Rust CI reclaims only documented hosted SDK roots behind fail-closed guards", () => {
  const workflow = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8").replaceAll(
    "\r",
    "",
  );
  assert.doesNotThrow(() => assertLinuxRustDiskReclaim(workflow));

  for (const weakened of [
    workflow.replace('"github-hosted"', '"self-hosted"'),
    workflow.replace(' || "$protected_root" == "$resolved"/*', ""),
    workflow.replace(' || "$resolved" == "$protected_root"/*', ""),
    workflow.replace("/usr/share/dotnet", "/opt/ghc"),
    workflow.replace(" --one-file-system", ""),
  ]) {
    assert.throws(() => assertLinuxRustDiskReclaim(weakened));
  }
});

test("desktop UI functional and CI-visual gates exactly partition the established automated suite", () => {
  const functionalSuite = inventory.suites.find(({ id }) => id === "desktop-ui-functional-e2e");
  const visualSuite = inventory.suites.find(({ id }) => id === "desktop-ui-visual-e2e");
  assert.equal(selectProfile(functionalSuite, "win32", {}).minimumExecuted, 381);
  assert.equal(selectProfile(functionalSuite, "linux", {}).minimumExecuted, 381);
  assert.equal(selectProfile(visualSuite, "win32", {}).minimumExecuted, 56);
  assert.equal(selectProfile(visualSuite, "linux", {}).minimumExecuted, 56);

  const functional = listedDesktopUiTests("test:ui:functional");
  const visual = listedDesktopUiTests("test:ui:visual-ci");
  const established = listedDesktopUiTests("test:ui", ["--grep-invert", "@screenshots"]);

  // These are established coverage floors, not ceilings: adding regressions must
  // not fail inventory validation. Exact disjoint coverage is checked below.
  assert.ok(functional.size >= 381);
  assert.ok(visual.size >= 56);
  assert.equal(established.size, functional.size + visual.size);
  assert.deepEqual(
    [...functional].filter((id) => visual.has(id)),
    [],
  );
  assert.deepEqual([...new Set([...functional, ...visual])].sort(), [...established].sort());

  const workflow = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8").replaceAll(
    "\r",
    "",
  );
  const functionalJob = workflow.split("\n  desktop-ui:\n")[1]?.split("\n  desktop-ui-visual:\n")[0] ?? "";
  const visualJob = workflow.split("\n  desktop-ui-visual:\n")[1]?.split("\n  desktop-e2e:\n")[0] ?? "";
  assert.match(functionalJob, /run: pnpm --filter @kalcode\/desktop run test:ui:functional/u);
  assert.match(functionalJob, /run: pnpm --filter @kalcode\/desktop test:ui:widgets/u);
  assert.match(functionalJob, /run: pnpm --filter @kalcode\/ui test:ui:primitives/u);
  assert.doesNotMatch(functionalJob, /test:ui:visual-ci/u);
  assert.match(visualJob, /run: pnpm --filter @kalcode\/desktop run test:ui:visual-ci/u);
  assert.doesNotMatch(visualJob, /test:ui:functional|test:ui:widgets|test:ui:primitives/u);
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

test("result policy allows increases and flakes, and denies zero, reductions, failures, and skip drift", () => {
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
    // A test that failed on every attempt is a failure even when another test was flaky.
    { executed: 3, failed: 1, skipped: 0, flaky: 1, skipReasons: [] },
  ]) {
    assert.throws(() => validateSuiteResult(selected, profile, result));
  }
});

test("a test that passed only on its retry is reported as flaky and no longer fails its suite", () => {
  const selected = suite();
  const profile = selectProfile(selected, "win32", {});
  const result = { executed: 3, failed: 0, skipped: 0, flaky: 2, skipReasons: [] };
  assert.equal(validateSuiteResult(selected, profile, result).flaky, 2);
  assert.equal(
    flakyReport("desktop-e2e", { ...result, flakyNames: ["a.spec.ts › opens [Error: timeout]", "b.spec.ts › tour"] }),
    "[test-suites] desktop-e2e: FLAKY 2 test(s) failed and then passed on retry: a.spec.ts › opens [Error: timeout] | b.spec.ts › tour\n",
  );
  assert.equal(flakyReport("desktop-e2e", { ...result, flaky: 0 }), "");
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
  assert.equal(defaultProfile.minimumExecuted, 164);
  // 38: the #259 home/product rebuild retired more stage components from pages, so their specs
  // skip with the reviewed "<Component> is not on <page>" reasons below.
  assert.equal(defaultProfile.skippedMinimum, 38);
  assert.equal(defaultProfile.skippedMaximum, 38);
  assert.throws(
    () =>
      validateSuiteResult(website, defaultProfile, {
        executed: 163,
        failed: 0,
        skipped: 38,
        flaky: 0,
        skipReasons: ["TryKalCode is not on /"],
      }),
    /executed/,
  );
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

  const enabled = inventory.suites.find(({ id }) => id === "website-checkout-enabled-e2e");
  assert.throws(() => selectProfile(website, "win32", { KALCODE_CHECKOUT_ENABLED_GATE: "1" }), /BLOCKED/);
  assert.throws(() => selectProfile(website, "win32", { PUBLIC_CHECKOUT_ENABLED: "true" }), /BLOCKED/);
  assert.throws(() => selectProfile(enabled, "win32", {}), /BLOCKED/);
  assert.throws(() => selectProfile(enabled, "win32", { KALCODE_CHECKOUT_ENABLED_GATE: "1" }), /BLOCKED/);
  assert.throws(() => selectProfile(enabled, "win32", { PUBLIC_CHECKOUT_ENABLED: "true" }), /BLOCKED/);
  const enabledProfile = selectProfile(enabled, "win32", {
    KALCODE_CHECKOUT_ENABLED_GATE: "1",
    PUBLIC_CHECKOUT_ENABLED: "true",
  });
  assert.equal(enabledProfile.minimumExecuted, 3);
  assert.equal(enabledProfile.skippedMinimum, 0);
  assert.equal(enabledProfile.skippedMaximum, 0);
  assert.equal(enabledProfile.maximumFlaky, 0);
  assert.doesNotThrow(() =>
    validateSuiteResult(enabled, enabledProfile, {
      executed: 3,
      failed: 0,
      skipped: 0,
      flaky: 0,
      skipReasons: [],
    }),
  );
  assert.throws(() =>
    validateSuiteResult(enabled, enabledProfile, {
      executed: 3,
      failed: 0,
      skipped: 1,
      flaky: 0,
      skipReasons: ["silently disabled"],
    }),
  );
});

test("native E2E permits only the four reviewed Session 0 skips and keeps interactive runs skip-free", () => {
  const native = inventory.suites.find(({ id }) => id === "desktop-native-e2e");
  assert.throws(() => selectProfile(native, "darwin", {}), /BLOCKED.*native Mac harness/);
  const interactive = selectProfile(native, "win32", {});
  assert.equal(interactive.minimumExecuted, 24);
  assert.equal(interactive.skippedMinimum, 0);
  assert.equal(interactive.skippedMaximum, 0);

  const service = selectProfile(native, "win32", { KALCODE_TEST_WINDOWS_SESSION_0: "1" });
  assert.equal(service.minimumExecuted, 24);
  assert.equal(service.skippedMinimum, 4);
  assert.equal(service.skippedMaximum, 4);
  const reason = "skipped: session 0 has no interactive desktop; run in an interactive session";
  const reviewed = {
    executed: 27,
    failed: 0,
    skipped: 4,
    flaky: 0,
    skipReasons: Array(4).fill(reason),
  };
  assert.doesNotThrow(() => validateSuiteResult(native, service, reviewed));
  for (const skipped of [3, 5]) {
    assert.throws(
      () =>
        validateSuiteResult(native, service, {
          ...reviewed,
          skipped,
          skipReasons: Array(skipped).fill(reason),
        }),
      /reviewed bounds/,
    );
  }
  assert.throws(
    () =>
      validateSuiteResult(native, service, {
        ...reviewed,
        skipReasons: [reason, reason, reason, "Build the native E2E app first: target/e2e/release/kalcode.exe"],
      }),
    /unreviewed skip reason/,
  );
  assert.throws(
    () => validateSuiteResult(native, interactive, { ...reviewed, skipped: 1, skipReasons: [reason] }),
    /reviewed bounds/,
  );
});

test("the Windows Session 0 probe is bounded to this process and fails closed", () => {
  let invocation;
  const spawn = (file, args, options) => {
    invocation = { file, args, options };
    return { status: 0, signal: null, error: null, stdout: "0\r\n" };
  };
  assert.equal(detectWindowsSessionZero({ platform: "win32", pid: 4242, spawn }), true);
  assert.equal(invocation.file, "powershell.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(invocation.args.at(-1), /Get-Process -Id 4242 -ErrorAction Stop/);
  assert.equal(invocation.options.timeout, 2_000);
  assert.equal(invocation.options.maxBuffer, 1_024);
  assert.equal(invocation.options.windowsHide, true);

  assert.equal(
    detectWindowsSessionZero({
      platform: "win32",
      pid: 4242,
      spawn: () => ({ status: 0, signal: null, error: null, stdout: "1" }),
    }),
    false,
  );
  assert.equal(
    detectWindowsSessionZero({
      platform: "win32",
      pid: 4242,
      spawn: () => {
        throw new Error("probe unavailable");
      },
    }),
    false,
  );
  assert.equal(
    detectWindowsSessionZero({
      platform: "linux",
      pid: 4242,
      spawn: () => {
        throw new Error("must not probe");
      },
    }),
    false,
  );
});

test("the native runner ignores inherited session markers and never passes its derived marker to tests", () => {
  const native = inventory.suites.find(({ id }) => id === "desktop-native-e2e");
  const reason = "skipped: session 0 has no interactive desktop; run in an interactive session";
  const temporaryParent = mkdtempSync(join(tmpdir(), "kalcode-native-profile-"));
  const execute = ({ sessionZeroProbe, skipped = [], environment = {} }) => {
    let childEnvironment;
    const result = runSuite(native, {
      platform: "win32",
      environment,
      sessionZeroProbe,
      temporaryParent,
      spawn: (_file, _args, options) => {
        childEnvironment = options.env;
        writeFileSync(
          options.env.PLAYWRIGHT_JSON_OUTPUT_FILE,
          JSON.stringify(playwrightReport({ expected: skipped.length === 0 ? 31 : 27, skipped })),
        );
        return { status: 0, signal: null, error: null, stdout: "", stderr: "" };
      },
    });
    return { childEnvironment, result };
  };

  try {
    const interactive = execute({
      sessionZeroProbe: () => false,
      environment: {
        KEEP: "yes",
        [WINDOWS_SESSION_ZERO_PROFILE_ENV]: "spoofed",
        kalcode_test_windows_session_0: "also-spoofed",
      },
    });
    assert.equal(interactive.result.executed, 31);
    assert.equal(interactive.childEnvironment.KEEP, "yes");
    assert.equal(
      Object.keys(interactive.childEnvironment).some((name) => name.toUpperCase() === WINDOWS_SESSION_ZERO_PROFILE_ENV),
      false,
    );

    const service = execute({ sessionZeroProbe: () => true, skipped: Array(4).fill(reason) });
    assert.equal(service.result.executed, 27);
    assert.equal(service.result.skipped, 4);
    assert.equal(
      Object.keys(service.childEnvironment).some((name) => name.toUpperCase() === WINDOWS_SESSION_ZERO_PROFILE_ENV),
      false,
    );

    assert.throws(
      () =>
        execute({
          sessionZeroProbe: () => {
            throw new Error("probe unavailable");
          },
          skipped: Array(4).fill(reason),
          environment: { [WINDOWS_SESSION_ZERO_PROFILE_ENV]: "spoofed" },
        }),
      /reviewed bounds/,
    );
  } finally {
    rmSync(temporaryParent, { recursive: true, force: true });
  }
});

test("suite selection is explicit and cannot silently omit an unknown suite", () => {
  assert.equal(selectSuites(inventory, ["run", "unit"]).length, 8);
  assert.deepEqual(
    selectSuites(inventory, ["run", "e2e"]).map(({ id }) => id),
    [
      "desktop-native-e2e",
      "desktop-ui-functional-e2e",
      "desktop-ui-visual-e2e",
      "website-e2e",
      "website-checkout-enabled-e2e",
    ],
  );
  assert.equal(selectSuites(inventory, ["run", "all"]).length, 13);
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
