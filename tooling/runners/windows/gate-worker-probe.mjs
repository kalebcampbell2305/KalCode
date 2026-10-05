import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "DESKTOP-KOOB7VV";
const SCHEMA = "kalcode-gate-worker-probe/v1";
const names = ["kalcode-win-gate", ...[1, 2, 3, 4, 5].map((id) => `kalcode-win-gate-w${id}`)];

export function verifyProbeReceipts(receipts, { source, run, attempt }) {
  if (!/^[0-9a-f]{40}$/.test(source) || receipts.length !== 6)
    throw new Error("six receipts and exact source required");
  const cases = new Set();
  const events = [];
  for (const item of receipts) {
    if (
      item.schema !== SCHEMA ||
      item.fixtureOnly !== true ||
      item.productionCandidatePassed !== false ||
      item.source !== source ||
      item.run !== run ||
      item.attempt !== attempt ||
      item.host !== HOST ||
      !Number.isInteger(item.case) ||
      item.case < 1 ||
      item.case > 6 ||
      cases.has(item.case) ||
      names[item.slot] !== item.runner ||
      !Number.isInteger(item.slot) ||
      item.slot < 0 ||
      item.slot > 5 ||
      !Number.isInteger(item.childPid) ||
      item.childPid < 1 ||
      !/^[0-9a-f]{64}$/.test(item.fixtureSha256)
    ) {
      throw new Error("receipt identity mismatch");
    }
    cases.add(item.case);
    const expectedCode = item.case === 3 ? 17 : 0;
    if (item.exitCode !== expectedCode || item.state !== (expectedCode ? "intentional_fixture_failure" : "pass")) {
      throw new Error("one deliberate failure and five successful independent jobs required");
    }
    const start = Date.parse(item.startedAt);
    const end = Date.parse(item.finishedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 30_000)
      throw new Error("unproven overlap interval");
    events.push({ at: start, slot: item.slot, change: 1 }, { at: end, slot: item.slot, change: -1 });
  }
  events.sort((a, b) => a.at - b.at || a.change - b.change);
  const active = new Set();
  let peak = 0;
  let fourSince = null;
  let longestFourWorkerOverlapMs = 0;
  for (const event of events) {
    if (active.size === 4 && event.change < 0) {
      longestFourWorkerOverlapMs = Math.max(longestFourWorkerOverlapMs, event.at - fourSince);
      fourSince = null;
    }
    if (event.change > 0) {
      if (active.has(event.slot)) throw new Error("one physical runner cannot own overlapping matrix jobs");
      active.add(event.slot);
      peak = Math.max(peak, active.size);
      if (active.size === 4) fourSince = event.at;
    } else active.delete(event.slot);
  }
  if (peak !== 4) throw new Error(`only ${peak} distinct physical workers overlapped; do not claim four`);
  if (longestFourWorkerOverlapMs < 30_000)
    throw new Error("four physical workers must overlap for at least 30 seconds");
  return {
    schema: "kalcode-gate-worker-pool-proof/v1",
    source,
    run,
    attempt,
    host: HOST,
    jobs: 6,
    peakDistinctWorkers: peak,
    longestFourWorkerOverlapMs,
    passedFixtures: 5,
    intentionalFailures: 1,
    fixtureOnly: true,
    productionCandidatePassed: false,
  };
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, path);
}

async function runCase(id) {
  if (process.platform !== "win32" || hostname().toUpperCase() !== HOST) throw new Error("main Windows PC only");
  const runner = process.env.RUNNER_NAME;
  const slot = names.indexOf(runner);
  if (slot < 0 || process.env.KALCODE_GATE_SLOT !== String(slot)) throw new Error("unregistered physical slot");
  const source = process.env.GITHUB_SHA;
  const run = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  if (!/^[0-9a-f]{40}$/.test(source ?? "") || !/^\d+$/.test(run ?? "") || !/^\d+$/.test(attempt ?? ""))
    throw new Error("GitHub push/manual identity required");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim();
  if (head !== source || dirty) throw new Error("clean exact-source checkout required");
  const root = process.env.RUNNER_TEMP;
  const reportRoot = process.env.KALCODE_GATE_REPORT_DIR;
  if (!root || resolve(reportRoot ?? "") !== resolve("C:/ProgramData/KalCodeGatePool/reports"))
    throw new Error("isolated temp and shared sanitized reports required");
  const basename = `pool-probe-${run}-${attempt}-${id}`;
  const directory = join(root, basename);
  mkdirSync(directory, { recursive: false });
  const fixture = `export const change = ${id};\nexport const expected = ${id * 7};\n`;
  writeFileSync(join(directory, "fixture.mjs"), fixture, { flag: "wx" });
  const record = {
    schema: SCHEMA,
    fixtureOnly: true,
    productionCandidatePassed: false,
    source,
    run,
    attempt,
    host: HOST,
    runner,
    slot,
    case: id,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    state: "running",
    childPid: null,
    exitCode: null,
    fixtureSha256: createHash("sha256").update(fixture).digest("hex"),
  };
  const publish = () => {
    atomicJson(join(root, `${basename}.json`), record);
    atomicJson(join(reportRoot, `${basename}.json`), record);
  };
  const script = `import {change, expected} from './fixture.mjs';
    if(change * 7 !== expected) process.exit(9);
    await new Promise(resolve => setTimeout(resolve, 60000));
    process.exit(change === 3 ? 17 : 0);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: directory,
    windowsHide: true,
    stdio: "ignore",
    env: { SystemRoot: process.env.SystemRoot },
  });
  record.childPid = child.pid ?? null;
  const closed = new Promise((done, fail) => {
    child.once("error", fail);
    child.once("close", done);
  });
  try {
    publish();
    const code = await closed;
    record.exitCode = code;
    record.finishedAt = new Date().toISOString();
    record.state = code === 0 ? "pass" : id === 3 && code === 17 ? "intentional_fixture_failure" : "unexpected_failure";
    publish();
    // Case3 really fails its GitHub matrix job. fail-fast:false leaves the other five running.
    process.exitCode = code ?? 1;
  } catch (error) {
    if (child.exitCode === null && !child.killed) child.kill();
    await closed.catch(() => {});
    record.exitCode = child.exitCode;
    record.finishedAt = new Date().toISOString();
    record.state = "probe_error";
    try {
      publish();
    } catch {
      /* Preserve any earlier local receipt; never invent a success. */
    }
    throw error;
  }
}

async function main(args) {
  if (args[0] === "--case" && args.length === 2 && /^[1-6]$/.test(args[1])) return runCase(Number(args[1]));
  if (args[0] === "--verify" && args.length === 5) {
    const [directory, source, run, attempt] = args.slice(1);
    const files = readdirSync(directory).filter((file) =>
      new RegExp(`^pool-probe-${run}-${attempt}-[1-6]\\.json$`).test(file),
    );
    const receipts = files.map((file) =>
      JSON.parse(readFileSync(join(directory, file), "utf8").replace(/^\uFEFF/, "")),
    );
    console.log(JSON.stringify(verifyProbeReceipts(receipts, { source, run, attempt }), null, 2));
    return;
  }
  throw new Error("Use --case 1..6 or --verify <receipt-directory> <exact-sha> <run-id> <attempt>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
