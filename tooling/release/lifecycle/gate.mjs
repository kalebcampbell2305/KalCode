// `ship.mjs gate`: the local merge gate. Runs the local equivalents of the ci.yml checks for the lanes a
// change touches (policy.json "gates"), so a merge can be gated even when GitHub Actions cannot run.
// Never skips a failing check; a check that cannot run on this platform is reported as unavailable.
import { spawnSync } from "node:child_process";
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
      state: available ? "selected" : "unavailable",
      why: available ? null : `not on ${platform}: ${g.unavailable ?? "platform-specific"}`,
    });
  }
  return plan;
}

function defaultExec(repo) {
  return (command, { env, quiet = false } = {}) => {
    const r = spawnSync(command, {
      cwd: repo,
      env,
      shell: true,
      stdio: quiet ? "ignore" : "inherit",
      windowsHide: true,
    });
    return r.error ? 127 : (r.status ?? 1);
  };
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

/** Runs a gate plan in order. Stops at the first failure unless keepGoing. */
export function runGates(
  plan,
  { repo, exec = defaultExec(repo), log = () => {}, keepGoing = false, baseEnv = process.env },
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
    const missing = g.requires.filter((probe) => exec(probe, { env, quiet: true }) !== 0);
    if (missing.length) {
      log(`FAIL ${g.id}: required tool missing (${missing.join("; ")}); install it and rerun`);
      results.push({ id: g.id, state: "fail", why: `missing tool: ${missing.join("; ")}` });
      failed = true;
      continue;
    }
    if (g.builtin) BUILTINS[g.builtin](repo);
    let code = 0;
    let failedCommand = null;
    for (const command of g.run) {
      log(`>>   ${g.id}: ${command}`);
      code = exec(command, { env });
      if (code !== 0) {
        failedCommand = command;
        break;
      }
    }
    if (code === 0) {
      log(`PASS ${g.id}`);
      results.push({ id: g.id, state: "pass" });
    } else {
      log(`FAIL ${g.id}: ${failedCommand} exited ${code}`);
      results.push({ id: g.id, state: "fail", why: `${failedCommand} exited ${code}` });
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
    classification,
    plan: selectGates(policy, classification, { platform, only }),
  };
}

/** A PASS receipt bound to HEAD, only for a clean tree (the checks ran against exactly that commit). */
export function recordGate(git, g, outcome, { platform = process.platform, now = Date.now } = {}) {
  if (outcome.status !== "PASS" || !g.clean || !g.head) return null;
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
