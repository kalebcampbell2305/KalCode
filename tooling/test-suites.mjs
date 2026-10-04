#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoEnvironment } from "../apps/desktop/scripts/cargo.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_INVENTORY_PATH = join(ROOT, "tooling", "test-suites.json");
const SUPPORTED_PLATFORMS = new Set(["win32", "darwin", "linux"]);
const GROUPS = new Set(["unit", "e2e"]);
const RUNNERS = new Set(["vitest", "node", "cargo", "playwright"]);
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has an invalid field set`);
  }
}

function safeToken(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9:-]{0,79}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function validateProfile(profile, label) {
  exactKeys(
    profile,
    [
      "platforms",
      "environment",
      "minimumExecuted",
      "skippedMinimum",
      "skippedMaximum",
      "allowedSkipReasons",
      "maximumFlaky",
    ],
    label,
  );
  if (
    !Array.isArray(profile.platforms) ||
    profile.platforms.length === 0 ||
    new Set(profile.platforms).size !== profile.platforms.length ||
    profile.platforms.some((platform) => !SUPPORTED_PLATFORMS.has(platform))
  ) {
    throw new Error(`${label}.platforms is invalid`);
  }
  if (!profile.environment || typeof profile.environment !== "object" || Array.isArray(profile.environment)) {
    throw new Error(`${label}.environment is invalid`);
  }
  for (const [name, state] of Object.entries(profile.environment)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || !["present", "absent"].includes(state)) {
      throw new Error(`${label}.environment is invalid`);
    }
  }
  count(profile.minimumExecuted, `${label}.minimumExecuted`);
  if (profile.minimumExecuted === 0) throw new Error(`${label}.minimumExecuted must fail closed above zero`);
  count(profile.skippedMinimum, `${label}.skippedMinimum`);
  count(profile.skippedMaximum, `${label}.skippedMaximum`);
  if (profile.skippedMaximum < profile.skippedMinimum) throw new Error(`${label} skipped bounds are invalid`);
  count(profile.maximumFlaky, `${label}.maximumFlaky`);
  if (
    !Array.isArray(profile.allowedSkipReasons) ||
    profile.allowedSkipReasons.some((pattern) => typeof pattern !== "string" || pattern.length > 256)
  ) {
    throw new Error(`${label}.allowedSkipReasons is invalid`);
  }
  for (const pattern of profile.allowedSkipReasons) {
    try {
      new RegExp(pattern, "u");
    } catch {
      throw new Error(`${label}.allowedSkipReasons contains an invalid expression`);
    }
  }
  return profile;
}

export function validateInventory(value) {
  exactKeys(value, ["schemaVersion", "suites", "rustIntentionalIgnores"], "test suite inventory");
  if (value.schemaVersion !== 1 || !Array.isArray(value.suites) || value.suites.length === 0) {
    throw new Error("test suite inventory is invalid");
  }
  const ids = new Set();
  for (const [index, suite] of value.suites.entries()) {
    const label = `test suite ${index}`;
    exactKeys(
      suite,
      ["id", "group", "runner", "package", "script", "command", "timeoutMs", "profiles", "unavailableReason"],
      label,
    );
    safeToken(suite.id, `${label}.id`);
    if (ids.has(suite.id)) throw new Error(`duplicate test suite id: ${suite.id}`);
    ids.add(suite.id);
    if (!GROUPS.has(suite.group) || !RUNNERS.has(suite.runner)) throw new Error(`${label} classification is invalid`);
    const isCargo = suite.runner === "cargo";
    if (
      (isCargo && (suite.package !== null || suite.script !== null)) ||
      (!isCargo &&
        (typeof suite.package !== "string" ||
          !suite.package.startsWith("@kalcode/") ||
          typeof suite.script !== "string"))
    ) {
      throw new Error(`${label} command authority is invalid`);
    }
    if (
      (isCargo &&
        (!Array.isArray(suite.command) ||
          suite.command.length < 2 ||
          suite.command.some((argument) => typeof argument !== "string" || argument.length > 256))) ||
      (!isCargo && suite.command !== null)
    ) {
      throw new Error(`${label}.command is invalid`);
    }
    if (!Number.isSafeInteger(suite.timeoutMs) || suite.timeoutMs < 1_000 || suite.timeoutMs > 3_600_000) {
      throw new Error(`${label}.timeoutMs is invalid`);
    }
    if (!Array.isArray(suite.profiles) || suite.profiles.length === 0) throw new Error(`${label}.profiles is invalid`);
    suite.profiles.forEach((profile, profileIndex) => {
      validateProfile(profile, `${label}.profiles[${profileIndex}]`);
    });
    if (suite.unavailableReason !== null && (typeof suite.unavailableReason !== "string" || !suite.unavailableReason)) {
      throw new Error(`${label}.unavailableReason is invalid`);
    }
  }
  if (!Array.isArray(value.rustIntentionalIgnores)) throw new Error("rustIntentionalIgnores is invalid");
  for (const [index, entry] of value.rustIntentionalIgnores.entries()) {
    exactKeys(entry, ["path", "reason"], `rustIntentionalIgnores[${index}]`);
    if (
      typeof entry.path !== "string" ||
      !entry.path.endsWith(".rs") ||
      entry.path.includes("..") ||
      typeof entry.reason !== "string" ||
      entry.reason.length === 0 ||
      entry.reason.length > 256
    ) {
      throw new Error(`rustIntentionalIgnores[${index}] is invalid`);
    }
  }
  return value;
}

export function loadTestSuiteInventory(path = DEFAULT_INVENTORY_PATH) {
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > 256 * 1024) {
    throw new Error("test suite inventory has an invalid size");
  }
  return validateInventory(JSON.parse(readFileSync(path, "utf8")));
}

function workspacePackages(root) {
  const packageFiles = [];
  for (const parent of ["apps", "packages"]) {
    const directory = join(root, parent);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const packagePath = join(directory, entry.name, "package.json");
        try {
          if (statSync(packagePath).isFile()) packageFiles.push(packagePath);
        } catch {
          // A workspace child without package.json is not a JavaScript package.
        }
      }
    }
  }
  packageFiles.push(join(root, "tooling", "package.json"));
  return packageFiles;
}

export function auditWorkspaceSuiteCoverage(inventory, root = ROOT) {
  const declared = new Set(
    inventory.suites.filter((suite) => suite.package !== null).map((suite) => `${suite.package}\0${suite.script}`),
  );
  const required = new Set();
  const available = new Set();
  for (const packagePath of workspacePackages(root)) {
    const value = JSON.parse(readFileSync(packagePath, "utf8"));
    if (typeof value.name !== "string" || !value.scripts || typeof value.scripts !== "object") continue;
    for (const [script, command] of Object.entries(value.scripts)) {
      if (typeof command === "string") available.add(`${value.name}\0${script}`);
    }
    for (const script of ["test", "test:e2e"]) {
      if (typeof value.scripts[script] === "string") required.add(`${value.name}\0${script}`);
    }
  }
  const missing = [...required].filter((entry) => !declared.has(entry));
  const stale = [...declared].filter((entry) => !available.has(entry));
  if (missing.length || stale.length) {
    throw new Error(
      `test suite inventory does not match workspace scripts (missing=${missing.join(",") || "none"}; stale=${stale.join(",") || "none"})`,
    );
  }
}

function walkRust(directory, root, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "target") walkRust(path, root, found);
    } else if (entry.isFile() && entry.name.endsWith(".rs")) {
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(/^\s*#\[ignore(?:\s*=\s*"([^"]*)")?\]/gmu)) {
        found.push({ path: relative(root, path).replaceAll("\\", "/"), reason: match[1] ?? "" });
      }
    }
  }
}

function sortedJson(value) {
  return JSON.stringify(
    [...value].sort((left, right) => `${left.path}\0${left.reason}`.localeCompare(`${right.path}\0${right.reason}`)),
  );
}

export function auditRustIntentionalIgnores(inventory, root = ROOT) {
  const found = [];
  walkRust(join(root, "crates"), root, found);
  walkRust(join(root, "apps", "desktop", "src-tauri"), root, found);
  if (sortedJson(found) !== sortedJson(inventory.rustIntentionalIgnores)) {
    throw new Error("Rust #[ignore] declarations do not match the reviewed test suite inventory");
  }
}

function reportObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value;
}

export function parseVitestReport(value) {
  reportObject(value, "Vitest report");
  const passed = count(value.numPassedTests, "Vitest passed count");
  const failed = count(value.numFailedTests, "Vitest failed count");
  const skipped =
    count(value.numPendingTests, "Vitest skipped count") + count(value.numTodoTests ?? 0, "Vitest todo count");
  const total = count(value.numTotalTests, "Vitest total count");
  if (passed + failed + skipped !== total) throw new Error("Vitest report counts are inconsistent");
  return { executed: passed + failed, failed, skipped, flaky: 0, skipReasons: [] };
}

function summaryMetric(text, names, label) {
  const matches = [];
  for (const line of text.replaceAll("\r", "").split("\n")) {
    const normalized = line.replace(/^\s*(?:[#ℹ]\s*)?/, "");
    const match = new RegExp(`^(?:${names.join("|")})\\s+(\\d+)\\s*$`, "u").exec(normalized);
    if (match) matches.push(Number(match[1]));
  }
  if (matches.length !== 1) throw new Error(`Node test ${label} summary is missing or ambiguous`);
  return matches[0];
}

export function parseNodeTestReport(text) {
  if (typeof text !== "string" || text.length > MAX_CAPTURE_BYTES) throw new Error("Node test report is invalid");
  const total = summaryMetric(text, ["tests"], "tests");
  const passed = summaryMetric(text, ["pass", "passed"], "pass");
  const failed = summaryMetric(text, ["fail", "failed"], "fail");
  const skipped = summaryMetric(text, ["skipped"], "skipped");
  const cancelled = summaryMetric(text, ["cancelled"], "cancelled");
  const todo = summaryMetric(text, ["todo"], "todo");
  if (passed + failed + skipped + cancelled + todo !== total) {
    throw new Error("Node test report counts are inconsistent");
  }
  return { executed: passed + failed, failed: failed + cancelled, skipped: skipped + todo, flaky: 0, skipReasons: [] };
}

export function parseCargoTestReport(text) {
  if (typeof text !== "string" || text.length > MAX_CAPTURE_BYTES) throw new Error("Cargo test report is invalid");
  const expression =
    /test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/g;
  let summaries = 0;
  const result = { executed: 0, failed: 0, skipped: 0, flaky: 0, skipReasons: [] };
  for (const match of text.matchAll(expression)) {
    summaries += 1;
    result.executed += Number(match[1]) + Number(match[2]);
    result.failed += Number(match[2]);
    result.skipped += Number(match[3]);
    if (Number(match[4]) !== 0 || Number(match[5]) !== 0) {
      throw new Error("Cargo test report contains measured or filtered tests");
    }
  }
  if (summaries === 0) throw new Error("Cargo test report has no harness summaries");
  return result;
}

function playwrightTests(suites, found) {
  if (!Array.isArray(suites)) throw new Error("Playwright report suites are malformed");
  for (const suite of suites) {
    if (suite.suites !== undefined) playwrightTests(suite.suites, found);
    if (!Array.isArray(suite.specs)) continue;
    for (const spec of suite.specs) {
      if (!Array.isArray(spec.tests)) throw new Error("Playwright report tests are malformed");
      found.push(...spec.tests);
    }
  }
}

export function parsePlaywrightReport(value) {
  reportObject(value, "Playwright report");
  const stats = reportObject(value.stats, "Playwright report stats");
  const expected = count(stats.expected, "Playwright expected count");
  const unexpected = count(stats.unexpected, "Playwright unexpected count");
  const flaky = count(stats.flaky, "Playwright flaky count");
  const skipped = count(stats.skipped, "Playwright skipped count");
  const tests = [];
  playwrightTests(value.suites, tests);
  if (tests.length !== expected + unexpected + flaky + skipped) {
    throw new Error("Playwright report counts are inconsistent");
  }
  const skipReasons = [];
  for (const test of tests) {
    if (test.expectedStatus !== "skipped" && test.results?.at(-1)?.status !== "skipped") continue;
    const reasons = (test.annotations ?? [])
      .filter((annotation) => annotation?.type === "skip" && typeof annotation.description === "string")
      .map((annotation) => annotation.description);
    skipReasons.push(reasons.at(-1) ?? "");
  }
  if (skipReasons.length !== skipped) throw new Error("Playwright skipped tests lack exact result evidence");
  return { executed: expected + unexpected + flaky, failed: unexpected, skipped, flaky, skipReasons };
}

function environmentMatches(required, environment) {
  return Object.entries(required).every(([name, state]) =>
    state === "present" ? Boolean(environment[name]) : !environment[name],
  );
}

export function selectProfile(suite, platform = process.platform, environment = process.env) {
  const matches = suite.profiles.filter(
    (profile) => profile.platforms.includes(platform) && environmentMatches(profile.environment, environment),
  );
  if (matches.length === 0) {
    throw new Error(`${suite.id} is BLOCKED on ${platform}: ${suite.unavailableReason ?? "no reviewed test profile"}`);
  }
  if (matches.length !== 1) throw new Error(`${suite.id} has ambiguous expectation profiles`);
  return matches[0];
}

export function validateSuiteResult(suite, profile, result) {
  for (const field of ["executed", "failed", "skipped", "flaky"]) count(result[field], `${suite.id}.${field}`);
  if (result.executed === 0) throw new Error(`${suite.id} executed zero tests`);
  if (result.failed !== 0) throw new Error(`${suite.id} reported ${result.failed} failed tests`);
  if (result.executed < profile.minimumExecuted) {
    throw new Error(`${suite.id} executed ${result.executed}, below reviewed floor ${profile.minimumExecuted}`);
  }
  if (result.skipped < profile.skippedMinimum || result.skipped > profile.skippedMaximum) {
    throw new Error(`${suite.id} skipped ${result.skipped}, outside reviewed bounds`);
  }
  if (result.flaky > profile.maximumFlaky) throw new Error(`${suite.id} reported ${result.flaky} flaky tests`);
  if (result.skipReasons.length !== 0) {
    const allowed = profile.allowedSkipReasons.map((pattern) => new RegExp(pattern, "u"));
    for (const reason of result.skipReasons) {
      if (!reason || !allowed.some((pattern) => pattern.test(reason))) {
        throw new Error(`${suite.id} reported an unreviewed skip reason`);
      }
    }
  } else if (result.skipped !== 0 && profile.allowedSkipReasons.length !== 0 && suite.runner === "playwright") {
    throw new Error(`${suite.id} did not report its skip reasons`);
  }
  return result;
}

function readJsonReport(path, label) {
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_REPORT_BYTES) {
    throw new Error(`${label} has an invalid size`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function commandForSuite(suite, reportPath, platform, inherited = process.env) {
  if (suite.runner === "cargo") {
    // Debug Cargo builds of the desktop crate require the Dev identity overlay (docs/DEV-IDENTITY.md).
    const args = suite.command.slice(1);
    const { TAURI_CONFIG } = cargoEnvironment(args, inherited);
    return { file: suite.command[0], args, environment: TAURI_CONFIG === undefined ? {} : { TAURI_CONFIG } };
  }
  const args = ["--filter", suite.package, "run", suite.script];
  const environment = {};
  if (suite.runner === "vitest") {
    args.push("--reporter=json", `--outputFile=${reportPath}`);
  }
  if (suite.runner === "playwright") {
    args.push("--reporter=json");
    environment.PLAYWRIGHT_JSON_OUTPUT_FILE = reportPath;
  }
  if (platform === "win32") {
    // Node cannot execute .cmd files directly. Pass literal arguments through a hidden,
    // noninteractive PowerShell process, without interpolating them as shell expressions.
    const literal = (value) => `'${value.replaceAll("'", "''")}'`;
    const script = `& 'pnpm.cmd' ${args.map(literal).join(" ")}; exit $LASTEXITCODE`;
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      environment,
    };
  }
  return { file: "pnpm", args, environment };
}

export function runSuite(
  suite,
  {
    root = ROOT,
    platform = process.platform,
    environment = process.env,
    spawn = spawnSync,
    temporaryParent = tmpdir(),
  } = {},
) {
  const profile = selectProfile(suite, platform, environment);
  const temporaryDirectory = mkdtempSync(join(temporaryParent, "kalcode-test-suite-"));
  const reportPath = join(temporaryDirectory, "report.json");
  try {
    const command = commandForSuite(suite, reportPath, platform, environment);
    const child = spawn(command.file, command.args, {
      cwd: root,
      env: { ...environment, ...command.environment, NO_COLOR: "1" },
      encoding: "utf8",
      windowsHide: true,
      timeout: suite.timeoutMs,
      maxBuffer: MAX_CAPTURE_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.error || child.status !== 0 || child.signal) {
      const state = child.error?.code ?? child.signal ?? child.status ?? "unknown";
      // Output stays suppressed; only failing test names and their error lines are shown, so a failure on a
      // runner nobody can open is still diagnosable.
      const failing = `${child.stdout ?? ""}\n${child.stderr ?? ""}`
        .split(/\r?\n/)
        .filter((line) => /^\s*(?:not ok \d+ - |✖ |error: )/u.test(line))
        .map((line) => line.trim().slice(0, 200))
        .filter((line, index, all) => all.indexOf(line) === index)
        .slice(0, 20);
      const names = failing.length > 0 ? `; failing: ${failing.join(" | ")}` : "";
      throw new Error(`${suite.id} did not complete successfully (${state}); child output suppressed${names}`);
    }
    let result;
    if (suite.runner === "vitest") result = parseVitestReport(readJsonReport(reportPath, `${suite.id} report`));
    else if (suite.runner === "playwright")
      result = parsePlaywrightReport(readJsonReport(reportPath, `${suite.id} report`));
    else if (suite.runner === "cargo") result = parseCargoTestReport(`${child.stdout}\n${child.stderr}`);
    else result = parseNodeTestReport(`${child.stdout}\n${child.stderr}`);
    return validateSuiteResult(suite, profile, result);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function selectSuites(inventory, arguments_) {
  if (arguments_.length === 2 && arguments_[0] === "run" && ["unit", "e2e", "all"].includes(arguments_[1])) {
    return arguments_[1] === "all"
      ? inventory.suites
      : inventory.suites.filter((suite) => suite.group === arguments_[1]);
  }
  if (arguments_.length === 2 && arguments_[0] === "--suite") {
    const selected = inventory.suites.find((suite) => suite.id === arguments_[1]);
    if (selected) return [selected];
  }
  throw new Error("usage: node tooling/test-suites.mjs run <unit|e2e|all> | --suite <id>");
}

export function runSelectedSuites(arguments_, options = {}) {
  const inventory = options.inventory ?? loadTestSuiteInventory(options.inventoryPath);
  const root = options.root ?? ROOT;
  auditWorkspaceSuiteCoverage(inventory, root);
  auditRustIntentionalIgnores(inventory, root);
  const suites = selectSuites(inventory, arguments_);
  for (const suite of suites) {
    const result = runSuite(suite, { ...options, root });
    process.stdout.write(
      `[test-suites] ${suite.id}: ${result.executed} executed, ${result.skipped} skipped, ${result.flaky} flaky\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runSelectedSuites(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[test-suites] ${error instanceof Error ? error.message : "unknown failure"}\n`);
    process.exitCode = 1;
  }
}
