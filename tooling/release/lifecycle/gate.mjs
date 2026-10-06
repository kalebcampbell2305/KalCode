// `ship.mjs gate`: the local merge gate. Runs the local equivalents of the ci.yml checks for the lanes a
// change touches (policy.json "gates"), so a merge can be gated even when GitHub Actions cannot run.
// Never skips a failing check; a check that cannot run on this platform is reported as unavailable.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyChanges } from "./classify.mjs";
import { isCheckOutput } from "./gate-evidence.mjs";
import { runGatePool } from "./gate-pool.mjs";
import { acquireMachineLock, MACHINE_LOCKED_GATES } from "./machine-lock.mjs";
import { matchAny } from "./policy.mjs";
import { stateDir, writeJsonAtomic } from "./status.mjs";

/** Changes of the working tree (committed, staged, unstaged, untracked) since it forked from `base`. */
export function worktreeChanges(git, base) {
  const baseSha = git.rev(base);
  if (!baseSha) throw new Error(`unknown --base ref ${base}`);
  const mb = git.mergeBase(baseSha, "HEAD") ?? baseSha;
  const changes = git.diff(mb, null);
  const seen = new Set(changes.map((c) => c.path));
  for (const path of git.untracked()) if (!seen.has(path)) changes.push({ status: "A", path });
  return { mergeBase: mb, baseSha, changes };
}

export function selectGates(policy, classification, { platform = process.platform, only = null, portOffset = 0 } = {}) {
  const paths = classification.files.map((f) => f.path);
  if (paths.length === 0) return [];
  // UI source and browser-test changes have no native compilation inputs. Any unknown
  // path, manifest, generated protocol or tooling change retains the broader policy.
  const frontendOnly = paths.every((path) => /^apps\/desktop\/(src\/|tests\/ui\/)/.test(path));
  const plan = [];
  for (const g of policy.gates) {
    if (only && !only.includes(g.id)) continue;
    if (!only && frontendOnly && ["rust", "desktop-native-e2e"].includes(g.id)) continue;
    const w = g.when;
    const hit =
      !w ||
      (w.paths && paths.some((p) => matchAny(w.paths, p))) ||
      w.targets?.some((t) => classification.targets.includes(t)) ||
      w.lanes?.some((l) => classification.lanes.includes(l));
    if (!hit) continue;
    const available = !g.platforms || g.platforms.includes(platform);
    plan.push({
      id: g.id,
      run: g.run,
      env: {
        ...(g.env ?? {}),
        ...Object.fromEntries(Object.entries(g.ports ?? {}).map(([key, port]) => [key, String(port + portOffset)])),
        ...(g.envByPlatform?.[platform] ?? {}),
      },
      unsetEnv: g.unsetEnv ?? [],
      exclusive: g.exclusive ?? [],
      requires: g.requires ?? [],
      builtin: g.builtin ?? null,
      timeoutMs: g.timeoutMs ?? null,
      state: available ? "selected" : "unavailable",
      why: available ? null : `not on ${platform}: ${g.unavailable ?? "platform-specific"}`,
    });
  }
  return plan;
}

/** What an exec resolves to when its command overran the gate's `timeoutMs`. */
export const TIMED_OUT = "timed-out";

export const DEFAULT_GATE_CONCURRENCY = 4;
export function gateConcurrency(env = process.env) {
  const raw = env.KALCODE_GATE_JOBS ?? env.KALCODE_GATE_CONCURRENCY;
  if (raw === undefined || raw === "") return DEFAULT_GATE_CONCURRENCY;
  const jobs = Number(raw);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 4) throw new Error("Gate check concurrency must be from 1 to 4");
  return jobs;
}
export function gatePortOffset(env = process.env) {
  const offset = Number(env.KALCODE_GATE_PORT_OFFSET ?? 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > 1000)
    throw new Error("KALCODE_GATE_PORT_OFFSET must be 0-1000");
  return offset;
}

/** Kills a command's whole process tree: the shell and everything it started. */
export function killTree(pid, { platform = process.platform } = {}) {
  if (platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // the command leads its own process group (spawned detached)
  } catch {
    // already gone
  }
}

function defaultExec(repo) {
  return (command, { env, quiet = false, timeoutMs = null, signal, output } = {}) =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(130);
        return;
      }
      const unix = process.platform !== "win32";
      let child;
      try {
        child = spawn(command, {
          cwd: repo,
          env,
          shell: true,
          stdio: quiet ? "ignore" : output ? ["ignore", "pipe", "pipe"] : "inherit",
          windowsHide: true,
          detached: unix,
        });
      } catch {
        resolve(127);
        return;
      }
      if (output && !quiet) {
        child.stdout.on("data", (chunk) => output(chunk.toString()));
        child.stderr.on("data", (chunk) => output(chunk.toString()));
      }
      let timedOut = false;
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              timedOut = true;
              killTree(child.pid);
            }, timeoutMs);
      const interrupt = () => killTree(child.pid);
      signal?.addEventListener("abort", interrupt, { once: true });
      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", interrupt);
        resolve(timedOut ? TIMED_OUT : signal?.aborted ? 130 : code);
      };
      child.once("error", () => finish(127));
      child.once("close", (code) => finish(code ?? 1));
    });
}

const BUILTINS = {
  // ci.yml "Frontend placeholder for tauri::generate_context": only when no real build exists.
  "desktop-dist-placeholder": (repo) => {
    const file = join(repo, "apps", "desktop", "dist", "index.html");
    if (!existsSync(file)) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "<!doctype html>\n");
    }
  },
};

export function gateEnvironment(gate, baseEnv) {
  const env = { ...baseEnv, ...gate.env };
  // Policy ports are local fallbacks. Registered workers own isolated browser ports.
  for (const key of ["KALCODE_E2E_PORT", "KALCODE_E2E_MAIL_PORT", "KALCODE_E2E_INSPECTOR_PORT", "KALCODE_E2E_CDP_PORT"])
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  if (!env.KALCODE_E2E_CDP_PORT && /^[0-5]$/.test(baseEnv.KALCODE_GATE_SLOT ?? ""))
    env.KALCODE_E2E_CDP_PORT = String(19333 + Number(baseEnv.KALCODE_GATE_SLOT) * 1000);
  for (const key of gate.unsetEnv ?? []) delete env[key];
  return env;
}

/**
 * Runs a gate plan in order. Stops at the first failure unless keepGoing. A gate with `timeoutMs` fails once its
 * commands together overrun it, and the overrunning command's process tree is killed, so a hung test cannot hold a
 * shared runner.
 */
async function runSerialGate(
  plan,
  {
    repo,
    exec = defaultExec(repo),
    log = () => {},
    keepGoing = false,
    baseEnv = process.env,
    now = Date.now,
    signal,
    output,
  },
) {
  const results = [];
  let failed = false;
  for (const g of plan) {
    if (g.state === "unavailable") {
      log(`--   ${g.id}: unavailable (${g.why})`);
      results.push({ id: g.id, state: "unavailable", why: g.why });
      continue;
    }
    if (failed && !keepGoing) {
      results.push({ id: g.id, state: "not-run" });
      continue;
    }
    const env = gateEnvironment(g, baseEnv);
    const missing = [];
    for (const probe of g.requires) if ((await exec(probe, { env, quiet: true, signal })) !== 0) missing.push(probe);
    if (missing.length) {
      log(`FAIL ${g.id}: required tool missing (${missing.join("; ")}); install it and rerun`);
      results.push({ id: g.id, state: "fail", why: `missing tool: ${missing.join("; ")}` });
      failed = true;
      continue;
    }
    if (g.builtin) BUILTINS[g.builtin](repo);
    const deadline = g.timeoutMs === null || g.timeoutMs === undefined ? null : now() + g.timeoutMs;
    let code = 0;
    let failedCommand = null;
    for (const command of g.run) {
      log(`>>   ${g.id}: ${command}`);
      const remaining = deadline === null ? null : deadline - now();
      code =
        remaining !== null && remaining <= 0
          ? TIMED_OUT
          : await exec(command, { env, timeoutMs: remaining, signal, ...(output ? { output } : {}) });
      if (code !== 0) {
        failedCommand = command;
        break;
      }
    }
    if (code === 0) {
      log(`PASS ${g.id}`);
      results.push({ id: g.id, state: "pass", exitCode: 0 });
    } else {
      const why =
        code === TIMED_OUT
          ? `${failedCommand} timed out: the ${g.id} gate exceeded its ${g.timeoutMs >= 60000 ? `${+(g.timeoutMs / 60000).toFixed(1)} min` : `${g.timeoutMs / 1000} s`} limit; its process tree was killed`
          : `${failedCommand} exited ${code}`;
      log(`FAIL ${g.id}: ${why}`);
      results.push({ id: g.id, state: "fail", why, exitCode: typeof code === "number" ? code : null });
      failed = true;
    }
  }
  return { status: failed ? "FAIL" : "PASS", results };
}

/** Independent checks continue after another check fails; dependent checks wait. */
export async function runGates(plan, options) {
  const {
    jobs = options.concurrency ?? 4,
    concurrency: _concurrency,
    keepGoing = true,
    signal: externalSignal,
    evidence,
    capacity,
    report,
    // { dir, timeoutMs?, acquire? }: machine-wide locks for MACHINE_LOCKED_GATES (gate pool only).
    machineLock,
    ...execution
  } = options;
  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  if (externalSignal?.aborted) abort();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(name, abort);
  try {
    const outcome = await runGatePool(
      plan,
      async (gate) => {
        const startedAt = new Date().toISOString();
        report?.start(gate.id);
        let buffer = "";
        const buffered = jobs > 1;
        const log = execution.log ?? (() => {});
        if (buffered) log(`..   ${gate.id}: started`);
        const lockName = machineLock?.dir && gate.state === "selected" ? MACHINE_LOCKED_GATES[gate.id] : undefined;
        const execute = async () => {
          let release = null;
          if (lockName) {
            log(`..   ${gate.id}: waiting for the machine-wide ${lockName} lock`);
            try {
              release = await (machineLock.acquire ?? acquireMachineLock)(machineLock.dir, lockName, {
                timeoutMs: machineLock.timeoutMs,
              });
            } catch (error) {
              return { id: gate.id, state: "fail", why: error.message };
            }
            log(`..   ${gate.id}: holds the machine-wide ${lockName} lock`);
          }
          try {
            return (
              await runSerialGate([gate], {
                ...execution,
                signal: controller.signal,
                ...(buffered
                  ? {
                      log: (line) => {
                        buffer += `${line}\n`;
                      },
                      output: (chunk) => {
                        buffer += chunk;
                      },
                    }
                  : {}),
              })
            ).results[0];
          } finally {
            release?.();
          }
        };
        const result = evidence && gate.state === "selected" ? await evidence.run(gate, execute) : await execute();
        if (buffered)
          log(
            `---- ${gate.id} (${Math.round((Date.now() - Date.parse(startedAt)) / 1000)} s) ----\n${buffer.trimEnd()}`,
          );
        if (result.reusedFrom)
          log(`PASS ${gate.id}: verified inputs reused from ${result.reusedFrom}, bound to ${result.reboundTo}`);
        // A check that ended before running (evidence or capacity refusal) still says why.
        else if (result.state !== "pass" && result.why && !buffer.includes(`FAIL ${gate.id}`))
          log(`FAIL ${gate.id}: ${result.why}`);
        const completed = { ...result, startedAt, finishedAt: new Date().toISOString() };
        report?.finish(completed);
        return completed;
      },
      {
        jobs,
        keepGoing,
        signal: controller.signal,
        capacity,
      },
    );
    for (const result of outcome.results) report?.finish(result);
    return outcome;
  } finally {
    externalSignal?.removeEventListener("abort", abort);
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(name, abort);
  }
}

export function gateForWorktree(
  policy,
  git,
  { base = "origin/main", platform = process.platform, only = null, portOffset = 0 } = {},
) {
  const top = git.toplevel();
  const { mergeBase, baseSha, changes } = worktreeChanges(git, base);
  const readWorktree = (path) => {
    try {
      return readFileSync(join(top, path), "utf8");
    } catch {
      return null;
    }
  };
  const classification = classifyChanges(policy, git, changes, {
    base: mergeBase,
    head: null,
    headIsWorktree: true,
    readWorktree,
  });
  const head = git.rev("HEAD");
  const clean = git.diff("HEAD", null).length === 0 && git.untracked().length === 0;
  return {
    top,
    base: { ref: base, commit: baseSha },
    head,
    clean,
    tree: clean && head ? git.tree("HEAD") : null,
    partial: Boolean(only),
    classification,
    plan: selectGates(policy, classification, { platform, only, portOffset }),
  };
}

/**
 * Why the tree no longer matches the gated commit, or null. The same rule as the per-check evidence guard:
 * HEAD must be unchanged and no tracked SOURCE file may differ; outputs the checks write into the checkout
 * (refreshed QA screenshots, untracked reports) never count. Gate 37374586446 passed every check and was then
 * refused here because the visual suite had refreshed tracked screenshots.
 */
export function receiptDrift(git, g) {
  if (git.rev("HEAD") !== g.head) return "HEAD moved";
  const changed = git
    .diff("HEAD", null)
    .map(({ path }) => path)
    .filter((path) => !isCheckOutput(path));
  return changed.length ? `tracked source changed: ${changed.slice(0, 8).join(", ")}` : null;
}

/**
 * A PASS receipt bound to HEAD, only for a clean tree (the checks ran against exactly that commit) and only for
 * the full gate: an `--only` subset never counts as the gate passing.
 */
export function recordGate(git, g, outcome, { platform = process.platform, now = Date.now } = {}) {
  if (outcome.status !== "PASS" || !g.clean || !g.head || g.partial) return null;
  if (receiptDrift(git, g)) return null;
  const required = g.plan.filter((gate) => gate.state === "selected").map((gate) => gate.id);
  if (
    outcome.results.length !== g.plan.length ||
    g.plan.some(
      (gate) =>
        outcome.results.filter(
          (result) => result.id === gate.id && result.state === (gate.state === "selected" ? "pass" : "unavailable"),
        ).length !== 1,
    )
  )
    return null;
  if (
    required.some((id) => outcome.results.filter((result) => result.id === id && result.state === "pass").length !== 1)
  )
    return null;
  const path = join(stateDir(git.commonDir()), "gates", `${g.head}.json`);
  const receipt = {
    schema: "kalcode-lifecycle-gate/v1",
    status: "PASS",
    head: g.head,
    base: g.base,
    lanes: g.classification.lanes,
    targets: g.classification.targets,
    platform,
    results: outcome.results,
    required,
    at: new Date(now()).toISOString(),
  };
  writeJsonAtomic(path, receipt);
  writeJsonAtomic(join(g.top, "target", "gate-evidence.json"), receipt);
  return path;
}
