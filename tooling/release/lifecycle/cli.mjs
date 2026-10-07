// Definition-of-Done commands of ship.mjs:
//
//   node tooling/release/ship.mjs classify --base <ref> --head <ref> [--json | --markdown]
//   node tooling/release/ship.mjs lifecycle status [--main <ref>] [--json | --markdown] [--offline] [--check]
//   node tooling/release/ship.mjs lifecycle hook          (Claude Code Stop + PreToolUse hook; reads the hook JSON on stdin)
//   node tooling/release/ship.mjs gate [--base origin/main] [--list] [--only a,b] [--keep-going] [--json]
//
// Common: --repo <dir> (default: the current directory's checkout). See docs/RELEASE-PIPELINE.md.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRange, renderClassify } from "./classify.mjs";
import { gateConcurrency, gateForWorktree, gatePortOffset, receiptDrift, recordGate, runGates } from "./gate.mjs";
import { captureToolchain, prepareCheckEvidence } from "./gate-evidence.mjs";
import { createGateCapacity } from "./gate-pressure.mjs";
import { createGateReport } from "./gate-report.mjs";
import { makeGit } from "./git.mjs";
import { runHook } from "./hook.mjs";
import { loadPolicy } from "./policy.mjs";
import { computeStatus, observeProduction, readJsonFile, renderStatus, stateDir, writeJsonAtomic } from "./status.mjs";

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

const SHIP = resolve(fileURLToPath(import.meta.url), "..", "..", "ship.mjs");
const VALUED = new Set(["--base", "--head", "--main", "--repo", "--only", "--jobs"]);
const FLAGS = new Set(["--json", "--markdown", "--offline", "--check", "--refresh-cache", "--list", "--keep-going"]);

export function parseLifecycleArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) {
      opts[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
      continue;
    }
    if (!VALUED.has(a)) throw new UsageError(`unknown argument ${a}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
    const key = a.slice(2);
    if (opts[key] !== undefined) throw new UsageError(`${a} given twice`);
    opts[key] = v;
  }
  if (opts.json && opts.markdown) throw new UsageError("--json and --markdown are exclusive");
  return opts;
}

async function status(opts, git, policy, log) {
  const dir = stateDir(git.commonDir());
  let obs;
  if (opts.offline) {
    obs = readJsonFile(join(dir, "observations.json"));
    if (!obs) throw new UsageError("no cached production observations; run without --offline once");
  } else {
    obs = await observeProduction(policy);
    writeJsonAtomic(join(dir, "observations.json"), obs);
  }
  const s = computeStatus(policy, git, obs, { mainRef: opts.main ?? "origin/main" });
  if ((opts.main ?? "origin/main") === "origin/main") writeJsonAtomic(join(dir, "status.json"), s);
  if (opts.refreshCache) return { code: 0, status: s };
  if (opts.json) log(JSON.stringify(s, null, 2));
  else log(renderStatus(s, { markdown: Boolean(opts.markdown) }));
  return { code: opts.check && s.unshippedLanes.length ? 1 : 0, status: s };
}

export async function lifecycleMain(argv, io = {}) {
  const log = io.log ?? ((line) => process.stdout.write(`${line}\n`));
  const [command, sub, ...rest] = argv;
  if (command === "lifecycle" && sub === "hook") return runHook({ shipPath: SHIP });
  const opts = parseLifecycleArgs(command === "lifecycle" ? rest : [sub, ...rest].filter((a) => a !== undefined));
  const git = makeGit(resolve(opts.repo ?? process.cwd()));
  const policy = loadPolicy();

  if (command === "classify") {
    if (!opts.base || !opts.head) throw new UsageError("classify needs --base <ref> and --head <ref>");
    const r = classifyRange(policy, git, { base: opts.base, head: opts.head });
    log(opts.json ? JSON.stringify(r, null, 2) : renderClassify(r, { markdown: Boolean(opts.markdown) }));
    return 0;
  }

  if (command === "lifecycle") {
    if (sub === "status") return (await status(opts, git, policy, log)).code;
    throw new UsageError(`unknown lifecycle command ${sub ?? "(none)"}: status, hook`);
  }

  if (command === "gate") {
    const only = opts.only ? opts.only.split(",").map((s) => s.trim()) : null;
    if (only)
      for (const id of only) if (!policy.gates.some((g) => g.id === id)) throw new UsageError(`unknown gate ${id}`);
    const g = gateForWorktree(policy, git, { base: opts.base ?? "origin/main", only, portOffset: gatePortOffset() });
    const c = g.classification;
    const header = `gate: lanes ${c.lanes.join(", ") || "none"}${c.targets.length ? ` (targets ${c.targets.join(", ")})` : ""}; ${c.files.length} changed file(s) vs ${g.base.ref}${g.clean ? "" : " (uncommitted changes included)"}`;
    if (opts.list) {
      if (opts.json) log(JSON.stringify({ ...g, top: undefined }, null, 2));
      else {
        log(header);
        for (const p of g.plan)
          log(
            `  ${p.state === "unavailable" ? "unavailable" : "run"} ${p.id}${p.why ? `  (${p.why})` : ""}\n${p.run.map((r) => `      ${r}`).join("\n")}`,
          );
      }
      return 0;
    }
    log(header);
    if (g.plan.length === 0) {
      log("gate: nothing changed; nothing to check");
      return 0;
    }
    const jobs = opts.jobs === undefined ? gateConcurrency() : Number(opts.jobs);
    if (!Number.isInteger(jobs) || jobs < 1 || jobs > 4) throw new UsageError("--jobs must be an integer from 1 to 4");
    const toolchain = g.clean ? captureToolchain() : null;
    const nativeToolchain =
      g.clean && g.plan.some((gate) => ["rust", "desktop-native-e2e", "cargo-deny", "cargo-audit"].includes(gate.id))
        ? captureToolchain({ native: true })
        : toolchain;
    const evidence = prepareCheckEvidence(git, g, policy, { toolchain, nativeToolchain });
    const capacity = /^kalcode-win-gate(?:-w[1-5])?$/.test(process.env.RUNNER_NAME ?? "")
      ? createGateCapacity(jobs)
      : undefined;
    const report = createGateReport({
      directory: process.env.KALCODE_GATE_REPORT_DIR,
      head: g.head,
      base: g.base.commit,
      worker: process.env.RUNNER_NAME,
      plan: g.plan,
    });
    // On the gate pool, the browser-driven desktop suites never overlap across its jobs (machine-lock.mjs).
    const machineLock =
      capacity && process.env.KALCODE_GATE_LOCK_DIR ? { dir: process.env.KALCODE_GATE_LOCK_DIR } : undefined;
    const outcome = await runGates(g.plan, {
      repo: g.top,
      log,
      keepGoing: true,
      jobs,
      evidence,
      capacity,
      report,
      machineLock,
    });
    const receipt = recordGate(git, g, outcome);
    if (outcome.status === "PASS" && g.clean && !g.partial && !receipt) {
      outcome.status = "FAIL";
      const drift = receiptDrift(git, g);
      log(`gate FAIL: ${drift ? `source identity changed (${drift})` : "required check evidence is incomplete"}`);
    }
    for (const result of outcome.results.filter((entry) => entry.flaky))
      log(`gate: FLAKY ${result.id} failed once and passed on its rerun (first failure: ${result.firstFailure})`);
    if (opts.json) log(JSON.stringify({ status: outcome.status, results: outcome.results, receipt }, null, 2));
    log(
      `gate ${outcome.status}${receipt ? ` (receipt for ${g.head.slice(0, 12)})` : outcome.status === "PASS" ? (only ? " (no receipt: --only ran a subset)" : " (no receipt: uncommitted changes)") : ""}`,
    );
    return outcome.status === "PASS" ? 0 : 1;
  }
  throw new UsageError(`unknown command ${command}`);
}
