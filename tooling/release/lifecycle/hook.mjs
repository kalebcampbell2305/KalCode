// `ship.mjs lifecycle hook`: the Claude Code Stop hook that enforces the Definition of Done.
//
// Input (stdin, Claude Code hook JSON): { session_id, transcript_path, cwd, hook_event_name: "Stop",
// stop_hook_active, ... }. Output: nothing (allow), or {"decision":"block","reason":"..."} on stdout with
// exit 0 (Claude Code continues the turn with the reason). Rules:
//   - stop_hook_active (already continuing because of a stop hook) -> allow, so it never loops;
//   - blocks at most once per session for the same state (branch head, origin/main, unshipped set);
//   - no network: production state comes from the cache written by `lifecycle status`; a stale cache starts a
//     detached background refresh for next time;
//   - time-boxed, and every error of its own allows the stop (never fails closed).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { makeGit } from "./git.mjs";
import { loadPolicy } from "./policy.mjs";
import { computeStatus, readJsonFile, stateDir, writeJsonAtomic } from "./status.mjs";

export const HOOK_BUDGET_MS = 1500;
export const CACHE_FRESH_MS = 30 * 60 * 1000;
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REFRESH_LOCK_MS = 2 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const allow = () => ({ stdout: "", code: 0 });

/**
 * Evaluates one Stop event. `deps` injects the clock, git factory, spawner and ship.mjs path for tests.
 * Returns { stdout, code }; never throws.
 */
export function evaluateStop(inputText, deps = {}) {
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = started + (deps.budgetMs ?? HOOK_BUDGET_MS);
  try {
    if (!inputText?.trim()) return allow(); // not a Claude Code hook invocation
    const input = JSON.parse(inputText);
    if (input.stop_hook_active === true) return allow();
    if (input.hook_event_name && input.hook_event_name !== "Stop") return allow();
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    const git = (deps.makeGit ?? makeGit)(cwd, { timeoutMs: 700, deadline });
    let common;
    try {
      common = git.commonDir();
    } catch {
      return allow(); // not a git checkout
    }
    const top = git.toplevel();
    if (!existsSync(join(top, "tooling", "release", "lifecycle", "policy.json"))) return allow(); // not KalCode
    const policy = loadPolicy();
    const main = git.rev("origin/main");
    if (!main) return allow();
    const head = git.rev("HEAD");
    const dir = stateDir(common);

    // 1. Work on this checkout that has not reached origin/main.
    const problems = [];
    let unmerged = 0;
    if (head && head !== main && !git.isAncestor(head, main)) {
      unmerged = git.count("origin/main", "HEAD");
      if (unmerged > 0) {
        const branch = git.run(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
        const gate = readJsonFile(join(dir, "gates", `${head}.json`));
        problems.push(
          `Branch ${branch === "HEAD" ? "(detached)" : branch} has ${unmerged} commit(s) not merged to origin/main. ` +
            `Gate (${gate?.status === "PASS" ? "passed for HEAD" : "not yet passed for HEAD"}: node tooling/release/ship.mjs gate --base origin/main), then push, PR and merge.`,
        );
      }
    }

    // 2. Production lanes on origin/main that are merged but not live (cached observations only).
    const cachedStatus = readJsonFile(join(dir, "status.json"));
    const obs = readJsonFile(join(dir, "observations.json"));
    const obsAge = obs?.checkedAt ? started - Date.parse(obs.checkedAt) : Number.POSITIVE_INFINITY;
    if (!(obsAge < CACHE_FRESH_MS)) startRefresh(dir, { ...deps, cwd }, now);
    let status = null;
    if (cachedStatus?.main?.commit === main && obsAge < CACHE_MAX_AGE_MS) status = cachedStatus;
    else if (obs && obsAge < CACHE_MAX_AGE_MS && now() < deadline) {
      try {
        status = computeStatus(policy, git, obs, { listCommits: false });
      } catch {
        status = null; // over budget or unreadable: judge the branch alone
      }
    }
    const lanes = status?.unshippedLanes ?? [];
    if (lanes.length) {
      const detail = (status.unshippedTargets ?? [])
        .map((t) => `${t} (${status.targets[t]?.reason ?? "unshipped"})`)
        .join("; ");
      problems.push(
        `origin/main has unshipped production lanes: ${lanes.join(", ")}: ${detail}. ` +
          "See node tooling/release/ship.mjs lifecycle status.",
      );
    }
    if (problems.length === 0) return allow();

    // Block once per session for the same state.
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([head, main, unmerged, lanes, status?.unshippedTargets ?? []]))
      .digest("hex");
    const sid =
      String(input.session_id ?? "unknown")
        .replace(/[^A-Za-z0-9_-]/g, "_")
        .slice(0, 80) || "unknown";
    const memo = join(dir, "hook-sessions", `${sid}.json`);
    if (readJsonFile(memo)?.fingerprint === fingerprint) return allow();
    writeJsonAtomic(memo, { fingerprint, at: new Date(started).toISOString() });
    pruneSessions(join(dir, "hook-sessions"), started);

    const reason = [
      "KalCode Definition of Done (AGENTS.md): the lifecycle is not finished.",
      ...problems.map((p) => `- ${p}`),
      "Finish it (test, review, commit, merge, build, deploy/publish, verify production) on your own; ask the owner only for consequential decisions. " +
        "If the owner said local-only / do not ship / prototype only, or this work is someone else's in-flight release, state that and stop.",
    ].join("\n");
    return { stdout: JSON.stringify({ decision: "block", reason }), code: 0 };
  } catch {
    return allow();
  }
}

/** Detached `lifecycle status --refresh-cache` so the next Stop sees fresh production state. */
function startRefresh(dir, deps, now) {
  if (deps.refresh === false || process.env.KALCODE_LIFECYCLE_HOOK_REFRESH === "0") return;
  const lock = join(dir, "refresh.lock");
  try {
    if (existsSync(lock) && now() - statSync(lock).mtimeMs < REFRESH_LOCK_MS) return;
    writeJsonAtomic(lock, { at: new Date(now()).toISOString() });
    if (deps.spawnRefresh) return deps.spawnRefresh();
    const child = spawn(process.execPath, [deps.shipPath, "lifecycle", "status", "--refresh-cache"], {
      cwd: deps.cwd ?? process.cwd(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    // best effort
  }
}

function pruneSessions(dir, now) {
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (now - statSync(p).mtimeMs > SESSION_TTL_MS) unlinkSync(p);
    }
  } catch {
    // best effort
  }
}

/** Reads stdin with a time box; resolves "" on timeout or error. */
export function readStdin(timeoutMs = 400) {
  return new Promise((resolve) => {
    let data = "";
    const done = (v) => {
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done(data), timeoutMs);
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => {
        data += c;
      });
      process.stdin.on("end", () => done(data));
      process.stdin.on("error", () => done(""));
    } catch {
      done("");
    }
  });
}

export async function runHook({ shipPath, write = (s) => process.stdout.write(s) } = {}) {
  let result = allow();
  try {
    const text = await readStdin();
    result = evaluateStop(text, { shipPath });
  } catch {
    result = allow();
  }
  if (result.stdout) write(result.stdout);
  return 0;
}
