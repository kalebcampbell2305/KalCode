// `ship.mjs gate`: the local merge gate. Runs the local equivalents of the ci.yml checks for the lanes a
// change touches (policy.json "gates"), so a merge can be gated even when GitHub Actions cannot run.
// Never skips a failing check; a check that cannot run on this platform is reported as unavailable.
import { spawn, spawnSync } from "node:child_process";
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

export function selectGates(policy, classification, { platform = process.platform, only = null } = {}) {
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
      env: { ...(g.env ?? {}), ...(g.envByPlatform?.[platform] ?? {}) },
      unsetEnv: g.unsetEnv ?? [],
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
  return (command, { env, quiet = false, timeoutMs = null } = {}) =>
    new Promise((resolve) => {
      const unix = process.platform !== "win32";
      let child;
      try {
        child = spawn(command, {
          cwd: repo,
          env,
          shell: true,
          stdio: quiet ? "ignore" : "inherit",
          windowsHide: true,
          detached: unix,
        });
      } catch {
        resolve(127);
        return;
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

/**
 * Runs a gate plan in order. Stops at the first failure unless keepGoing. A gate with `timeoutMs` fails once its
 * commands together overrun it, and the overrunning command's process tree is killed, so a hung test cannot hold a
 * shared runner.
 */
export async function runGates(
  plan,
  { repo, exec = defaultExec(repo), log = () => {}, keepGoing = false, baseEnv = process.env, now = Date.now },
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
    const env = { ...baseEnv, ...g.env };
    for (const k of g.unsetEnv) delete env[k];
    const missing = [];
    for (const probe of g.requires) if ((await exec(probe, { env, quiet: true })) !== 0) missing.push(probe);
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
      code = remaining !== null && remaining <= 0 ? TIMED_OUT : await exec(command, { env, timeoutMs: remaining });
      if (code !== 0) {
        failedCommand = command;
        break;
      }
    }
    if (code === 0) {
      log(`PASS ${g.id}`);
      results.push({ id: g.id, state: "pass" });
    } else {
      const why =
        code === TIMED_OUT
          ? `${failedCommand} timed out: the ${g.id} gate exceeded its ${g.timeoutMs >= 60000 ? `${+(g.timeoutMs / 60000).toFixed(1)} min` : `${g.timeoutMs / 1000} s`} limit; its process tree was killed`
          : `${failedCommand} exited ${code}`;
      log(`FAIL ${g.id}: ${why}`);
      results.push({ id: g.id, state: "fail", why });
      failed = true;
    }
  }
  return { status: failed ? "FAIL" : "PASS", results };
}

export function gateForWorktree(policy, git, { base = "origin/main", platform = process.platform, only = null } = {}) {
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
    partial: Boolean(only),
    classification,
    plan: selectGates(policy, classification, { platform, only }),
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
