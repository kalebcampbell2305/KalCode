// `ship.mjs gate`: the local merge gate. Runs the local equivalents of the ci.yml checks for the lanes a
// change touches (policy.json "gates"), so a merge can be gated even when GitHub Actions cannot run.
// Never skips a failing check; a check that cannot run on this platform is reported as unavailable.
// Independent gates run concurrently (AGENTS.md parallel gate worker pool rule): KALCODE_GATE_CONCURRENCY at
// once, never two gates that share an `exclusive` resource. With KALCODE_GATE_EVIDENCE_DIR set, a gate that
// already passed for the identical tree is reused instead of rerun.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyChanges } from "./classify.mjs";
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

/** Shifts a gate's declared `ports` so concurrent gate workers on one machine never share a port. */
function shiftedPorts(ports, offset) {
  return Object.fromEntries(Object.entries(ports ?? {}).map(([k, port]) => [k, String(port + offset)]));
}

export function selectGates(policy, classification, { platform = process.platform, only = null, portOffset = 0 } = {}) {
  const paths = classification.files.map((f) => f.path);
  if (paths.length === 0) return [];
  const plan = [];
  for (const g of policy.gates) {
    if (only && !only.includes(g.id)) continue;
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
      env: { ...(g.env ?? {}), ...shiftedPorts(g.ports, portOffset), ...(g.envByPlatform?.[platform] ?? {}) },
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
  return (command, { env, quiet = false, timeoutMs = null, output = null } = {}) =>
    new Promise((resolve) => {
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
      // A detached Unix group no longer receives the terminal's Ctrl+C: end it with the gate.
      const interrupt = () => {
        killTree(child.pid);
        process.exit(130);
      };
      if (unix) for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(s, interrupt);
      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (unix) for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(s, interrupt);
        resolve(timedOut ? TIMED_OUT : code);
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

/** Gates run at once when KALCODE_GATE_CONCURRENCY is unset. 1 runs them one after another with live output. */
export const DEFAULT_GATE_CONCURRENCY = 3;

export function gateConcurrency(env = process.env) {
  const raw = env.KALCODE_GATE_CONCURRENCY;
  if (raw === undefined || raw === "") return DEFAULT_GATE_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`KALCODE_GATE_CONCURRENCY must be a positive integer, not ${raw}`);
  return n;
}

/** This gate worker's port shift: gate.yml sets 10 x the runner's KALCODE_GATE_SLOT. */
export function gatePortOffset(env = process.env) {
  const raw = env.KALCODE_GATE_PORT_OFFSET;
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 1000) throw new Error(`KALCODE_GATE_PORT_OFFSET must be 0-1000, not ${raw}`);
  return n;
}

/**
 * Pass evidence of one gate for one exact tree: the same commands and gate env on the same tree and platform
 * prove the same thing, whichever commit, branch or base carried that tree. Evidence is only as trusted as the
 * account that writes it: the gate runners run write-access code only (gate.yml never runs fork code).
 */
export function evidenceKey(g, tree, platform = process.platform) {
  const env = Object.entries(g.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const material = { id: g.id, tree, platform, run: g.run, env, unsetEnv: g.unsetEnv ?? [], builtin: g.builtin };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

/** Where a gate ran, for "reused" lines: the Actions run when there is one. */
export function runLabel(env = process.env) {
  if (env.GITHUB_RUN_ID)
    return `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  return `local run (pid ${process.pid})`;
}

export function evidenceStore(dir, { platform = process.platform, label = runLabel(), now = Date.now } = {}) {
  const file = (g, tree) => join(dir, `${evidenceKey(g, tree, platform)}.json`);
  return {
    find(g, tree) {
      try {
        const record = JSON.parse(readFileSync(file(g, tree), "utf8"));
        return record.id === g.id && record.tree === tree && record.status === "PASS" ? record : null;
      } catch {
        return null;
      }
    },
    record(g, tree) {
      writeJsonAtomic(file(g, tree), {
        schema: "kalcode-gate-evidence/v1",
        status: "PASS",
        id: g.id,
        tree,
        platform,
        run: label,
        at: new Date(now()).toISOString(),
      });
    },
  };
}

/**
 * Runs a gate plan, up to `concurrency` gates at once; two gates that share an `exclusive` resource never overlap.
 * Results stay in plan order. Without keepGoing a failure stops starting new gates (they report not-run) while
 * gates already running finish, so their evidence isn't wasted. A gate with `timeoutMs` fails once its commands
 * together overrun it, and the overrunning command's process tree is killed, so a hung test cannot hold a shared
 * runner. With concurrency 1 output streams live; otherwise each gate's output is printed as one block when it
 * finishes. `evidence` ({ store, tree }) reuses gates that already passed for this exact tree and records new
 * passes; the reusable set is read before any gate starts, so a command under test can't add to it.
 */
export async function runGates(
  plan,
  {
    repo,
    exec = defaultExec(repo),
    log = () => {},
    keepGoing = false,
    baseEnv = process.env,
    now = Date.now,
    concurrency = 1,
    evidence = null,
  },
) {
  const results = new Array(plan.length);
  const buffered = concurrency > 1;
  const reusable = plan.map((g) =>
    evidence?.tree && g.state !== "unavailable" ? evidence.store.find(g, evidence.tree) : null,
  );
  let failed = false;

  const runOne = async (g) => {
    let text = "";
    const out = buffered ? (line) => (text += `${line}\n`) : log;
    const output = buffered ? (chunk) => (text += chunk) : null;
    const started = now();
    const flush = () => {
      if (buffered) log(`---- ${g.id} (${Math.round((now() - started) / 1000)} s) ----\n${text.trimEnd()}`);
    };
    const env = { ...baseEnv, ...g.env };
    for (const k of g.unsetEnv) delete env[k];
    const missing = [];
    for (const probe of g.requires) if ((await exec(probe, { env, quiet: true })) !== 0) missing.push(probe);
    if (missing.length) {
      flush();
      log(`FAIL ${g.id}: required tool missing (${missing.join("; ")}); install it and rerun`);
      return { id: g.id, state: "fail", why: `missing tool: ${missing.join("; ")}` };
    }
    if (g.builtin) BUILTINS[g.builtin](repo);
    const deadline = g.timeoutMs === null || g.timeoutMs === undefined ? null : started + g.timeoutMs;
    let code = 0;
    let failedCommand = null;
    for (const command of g.run) {
      out(`>>   ${g.id}: ${command}`);
      const remaining = deadline === null ? null : deadline - now();
      code =
        remaining !== null && remaining <= 0
          ? TIMED_OUT
          : await exec(command, { env, timeoutMs: remaining, ...(output ? { output } : {}) });
      if (code !== 0) {
        failedCommand = command;
        break;
      }
    }
    flush();
    if (code === 0) {
      log(`PASS ${g.id}`);
      return { id: g.id, state: "pass" };
    }
    const why =
      code === TIMED_OUT
        ? `${failedCommand} timed out: the ${g.id} gate exceeded its ${g.timeoutMs >= 60000 ? `${+(g.timeoutMs / 60000).toFixed(1)} min` : `${g.timeoutMs / 1000} s`} limit; its process tree was killed`
        : `${failedCommand} exited ${code}`;
    log(`FAIL ${g.id}: ${why}`);
    return { id: g.id, state: "fail", why };
  };

  await new Promise((resolveAll, rejectAll) => {
    const pending = plan.map((_, i) => i);
    const running = new Set();
    const held = new Set();
    const pump = () => {
      for (let k = 0; k < pending.length && running.size < concurrency; ) {
        const i = pending[k];
        const g = plan[i];
        const claims = g.exclusive ?? [];
        if (g.state === "unavailable") {
          log(`--   ${g.id}: unavailable (${g.why})`);
          results[i] = { id: g.id, state: "unavailable", why: g.why };
        } else if (reusable[i]) {
          log(`PASS ${g.id}: reused, passed for this exact tree in ${reusable[i].run} at ${reusable[i].at}`);
          results[i] = { id: g.id, state: "pass", reused: reusable[i].run };
        } else if (failed && !keepGoing) {
          results[i] = { id: g.id, state: "not-run" };
        } else if (claims.some((r) => held.has(r))) {
          k++;
          continue;
        } else {
          for (const r of claims) held.add(r);
          running.add(i);
          if (buffered) log(`..   ${g.id}: started`);
          Promise.resolve()
            .then(() => runOne(g))
            .then((result) => {
              results[i] = result;
              for (const r of claims) held.delete(r);
              running.delete(i);
              if (result.state === "fail") failed = true;
              else if (evidence?.tree) {
                try {
                  evidence.store.record(g, evidence.tree);
                } catch (e) {
                  log(`warn ${g.id}: could not record gate evidence (${e.message})`);
                }
              }
              pump();
            })
            .catch(rejectAll);
        }
        pending.splice(k, 1);
      }
      if (pending.length === 0 && running.size === 0) resolveAll();
    };
    pump();
  });
  return { status: results.some((r) => r.state === "fail") ? "FAIL" : "PASS", results };
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
    // Evidence is keyed by tree, and only a clean worktree is exactly that tree.
    tree: clean && head ? git.tree("HEAD") : null,
    partial: Boolean(only),
    classification,
    plan: selectGates(policy, classification, { platform, only, portOffset }),
  };
}

/**
 * A PASS receipt bound to HEAD, only for a clean tree (the checks ran against exactly that commit) and only for
 * the full gate: an `--only` subset never counts as the gate passing.
 */
export function recordGate(git, g, outcome, { platform = process.platform, now = Date.now } = {}) {
  if (outcome.status !== "PASS" || !g.clean || !g.head || g.partial) return null;
  const path = join(stateDir(git.commonDir()), "gates", `${g.head}.json`);
  writeJsonAtomic(path, {
    schema: "kalcode-lifecycle-gate/v1",
    status: "PASS",
    head: g.head,
    base: g.base,
    lanes: g.classification.lanes,
    targets: g.classification.targets,
    platform,
    results: outcome.results,
    at: new Date(now()).toISOString(),
  });
  return path;
}
