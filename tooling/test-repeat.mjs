// Reruns one spec N times to detect flakiness. Retries are forced off, so every failure counts.
//
//   pnpm test:repeat <spec file> [--times 20] [--grep "pattern"] [--workers 1] [-- extra runner args]
//
// Playwright specs (*.spec.ts) run with `--repeat-each N --retries 0` using the nearest
// playwright config; Vitest files (*.test.ts[x]) run N times in a loop. Prints a per-test tally
// and exits 1 if any run failed. Worktree ports apply as usual (KALCODE_UI_TEST_PORT, …).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    times: { type: "string", default: "20" },
    grep: { type: "string" },
    workers: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [specArg, ...extra] = positionals;
if (values.help || !specArg) {
  console.log(
    "Usage: pnpm test:repeat <spec file> [--times 20] [--grep pattern] [--workers N] [-- extra args]\n" +
      "Example: pnpm test:repeat apps/website/tests/e2e/forms.spec.ts --times 50 --grep honeypot",
  );
  process.exit(values.help ? 0 : 2);
}

const times = Number(values.times);
if (!Number.isInteger(times) || times < 1) {
  console.error("--times must be a positive integer");
  process.exit(2);
}

const spec = resolve(process.env.INIT_CWD ?? process.cwd(), specArg);
if (!existsSync(spec)) {
  console.error(`No such file: ${spec}`);
  process.exit(2);
}

/** Nearest ancestor directory (inclusive) containing one of `names`. */
function findUp(start, names) {
  let dir = start;
  for (;;) {
    for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const packageJson = findUp(dirname(spec), ["package.json"]);
if (!packageJson) {
  console.error(`No package.json above ${spec}`);
  process.exit(2);
}
const packageDir = dirname(packageJson);
const isPlaywright = /\.spec\.[cm]?[jt]sx?$/.test(spec);
const shell = process.platform === "win32";

function run(args, env = {}) {
  return spawnSync("pnpm", ["exec", ...args], {
    cwd: packageDir,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell,
  }).status;
}

function tallyPlaywright(report) {
  const tally = new Map();
  const visit = (suite, titles) => {
    for (const child of suite.suites ?? []) visit(child, [...titles, child.title].filter(Boolean));
    for (const specEntry of suite.specs ?? []) {
      const title = [...titles, specEntry.title].join(" › ");
      for (const test of specEntry.tests ?? []) {
        const entry = tally.get(title) ?? { passed: 0, failed: 0, skipped: 0 };
        for (const result of test.results ?? []) {
          if (result.status === "passed") entry.passed += 1;
          else if (result.status === "skipped") entry.skipped += 1;
          else entry.failed += 1;
        }
        tally.set(title, entry);
      }
    }
  };
  for (const suite of report.suites ?? []) visit(suite, []);
  return tally;
}

let tally;
let exitCode = 0;
if (isPlaywright) {
  const config = findUp(dirname(spec), ["playwright.config.ts", "playwright.config.mjs", "playwright.config.js"]);
  if (!config?.startsWith(packageDir)) {
    console.error(`No playwright config between ${spec} and ${packageDir}`);
    process.exit(2);
  }
  const outDir = mkdtempSync(join(tmpdir(), "kalcode-repeat-"));
  const reportFile = join(outDir, "report.json");
  const args = [
    "playwright",
    "test",
    "--config",
    relative(packageDir, config),
    relative(dirname(config), spec).replaceAll("\\", "/"),
    "--repeat-each",
    String(times),
    "--retries",
    "0",
    "--reporter",
    "line,json",
  ];
  if (values.grep) args.push("--grep", values.grep);
  if (values.workers) args.push("--workers", values.workers);
  args.push(...extra);
  exitCode = run(args, { PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile }) ?? 1;
  if (existsSync(reportFile)) tally = tallyPlaywright(JSON.parse(readFileSync(reportFile, "utf8")));
  rmSync(outDir, { recursive: true, force: true });
} else {
  tally = new Map();
  const title = relative(packageDir, spec);
  const entry = { passed: 0, failed: 0, skipped: 0 };
  for (let i = 0; i < times; i += 1) {
    const args = ["vitest", "run", relative(packageDir, spec).replaceAll("\\", "/")];
    if (values.grep) args.push("-t", values.grep);
    args.push(...extra);
    const status = run(args);
    if (status === 0) entry.passed += 1;
    else entry.failed += 1;
  }
  tally.set(`${title} (whole file)`, entry);
  exitCode = entry.failed > 0 ? 1 : 0;
}

if (!tally || tally.size === 0) {
  console.error("No results were recorded (did the runner start? check the output above).");
  process.exit(exitCode || 1);
}

console.log(`\nRepeat summary: ${relative(process.cwd(), spec)} ×${times}`);
let anyFailed = false;
for (const [title, { passed, failed, skipped }] of tally) {
  const total = passed + failed;
  const rate = total ? ((failed / total) * 100).toFixed(1) : "0.0";
  anyFailed ||= failed > 0;
  const mark = failed > 0 ? "FLAKY/FAILING" : "stable";
  console.log(
    `  ${mark.padEnd(13)} ${passed}/${total} passed (${rate}% failed)${skipped ? `, ${skipped} skipped` : ""}  ${title}`,
  );
}
process.exit(anyFailed || exitCode !== 0 ? 1 : 0);
