#!/usr/bin/env node
// The trusted local release runner: KalCode's CI and release trigger on the owner's Windows PC, with no
// GitHub-hosted minutes and no self-hosted GitHub runner. Windows Task Scheduler runs `tick` every few
// minutes from a dedicated, detached checkout of origin/main (the "control" checkout). One tick:
//
//   1. main: when origin/main moved, check out the new head in the control checkout, run the full local
//      gate (`ship.mjs gate`) on it and post the commit status `kalcode/local-gate`. When the gate passes
//      and `ship.mjs lifecycle status` reports unshipped desktop or release-notes changes, run the release
//      pipeline's automated phases (`ship.mjs run --phase all --execute`) and post `kalcode/release`. The
//      pipeline itself stops at every approval, attestation, operator step and production write; this
//      runner never runs `approve` or `attest` and never names a production-write phase. When the owner
//      records an approval or attestation, the next tick resumes the pipeline to the next human gate.
//   2. PRs: for each open PR whose head is in this repository and whose author is allowlisted, run the
//      local gate on its head commit in a freshly created clone, with an allowlisted environment whose
//      home, temp, cargo, npm and pnpm locations are runner-owned isolated directories, and post
//      `kalcode/local-gate` on that commit. PR code never runs in the control checkout and never on the Mac.
//      It still runs as the owner's Windows user (see the trust boundary in docs/RELEASE-PIPELINE.md).
//
// Every command has a timeout that kills its whole process tree, so a hung gate cannot wedge the runner.
//
//   node tooling/release/trusted-runner.mjs tick   [--control <dir>] [--state-root <dir>]
//                                                  [--allow-author <login> ...] [--no-prs] [--no-main]
//                                                  [--no-release] [--dry-run]
//   node tooling/release/trusted-runner.mjs status [--state-root <dir>]
//
// Pause: create <state-root>/PAUSED. See docs/RELEASE-PIPELINE.md, "Trusted local runner".
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STATE_SCHEMA = "kalcode-trusted-runner/v1";
export const GATE_CONTEXT = "kalcode/local-gate";
export const RELEASE_CONTEXT = "kalcode/release";
const SHA40 = /^[0-9a-f]{40}$/;
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const RELEASE_LANES = ["desktop", "docs"];
const MAX_PR_RECORDS = 200;
/** A PR whose checkout or setup fails this many ticks in a row is reported as an error and not retried. */
export const MAX_PR_ATTEMPTS = 3;

const MINUTE = 60_000;
/** Per-command limits. On expiry the whole process tree is killed and the command counts as failed. */
export const TIMEOUTS = Object.freeze({
  git: 10 * MINUTE,
  gh: 5 * MINUTE,
  query: 10 * MINUTE, // ship.mjs lifecycle status, release version
  install: 15 * MINUTE, // pnpm install --frozen-lockfile
  gate: 90 * MINUTE, // ship.mjs gate
  release: 8 * 60 * MINUTE, // ship.mjs run --phase all --execute (builds, signing, notarization)
});
/** A tick lock whose heartbeat is older than this is stale, whatever its PID says (PID reuse). */
export const LOCK_STALE_MS = 10 * MINUTE;
const HEARTBEAT_MS = MINUTE;

export class RunnerError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunnerError";
  }
}

// ------------------------------------------------------------------ pure decisions (unit tested)

/** The only variables a PR inherits from the runner (compared case-insensitively). Everything else is dropped. */
export const PR_ENV_ALLOW = Object.freeze([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "PROGRAMDATA",
  "LANG",
  "TERM",
]);

/**
 * The environment a PR's code runs with: an allowlist of system variables, plus runner-owned isolated
 * locations for everything a PR could read secrets from or poison through an environment variable: the
 * user profile and home (so `~/.ssh`, `~/.azure`, the gh hosts file and the global git config are not where
 * tools look), AppData, temp, the cargo home, the npm cache and the pnpm store (so a PR cannot poison the
 * caches release builds use). The system git config (credential helper) is ignored. The PR still runs as
 * the same Windows user: absolute paths such as C:\Users\Kaleb\.ssh stay readable. That is documented, not
 * hidden.
 *
 * Shared read-mostly tool locations the gate needs are passed explicitly: the rustup toolchains and the
 * Playwright browsers.
 */
export function buildPrEnv(env, { isolatedDir, cargoTargetDir }) {
  const allow = new Set(PR_ENV_ALLOW);
  const out = {};
  for (const [k, v] of Object.entries(env)) if (allow.has(k.toUpperCase())) out[k] = v;
  const realHome = env.USERPROFILE ?? env.HOME ?? homedir();
  const realLocal = env.LOCALAPPDATA ?? join(realHome, "AppData", "Local");
  const home = join(isolatedDir, "home");
  const tmp = join(isolatedDir, "tmp");
  return {
    ...out,
    USERPROFILE: home,
    HOME: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    CARGO_HOME: join(isolatedDir, "cargo-home"),
    CARGO_TARGET_DIR: cargoTargetDir,
    RUSTUP_HOME: env.RUSTUP_HOME ?? join(realHome, ".rustup"),
    PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH ?? join(realLocal, "ms-playwright"),
    npm_config_cache: join(isolatedDir, "npm-cache"),
    npm_config_store_dir: join(isolatedDir, "pnpm-store"),
    AZURE_CONFIG_DIR: join(isolatedDir, "azure"),
    GH_CONFIG_DIR: join(isolatedDir, "gh"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
}

/** The directories buildPrEnv points at, created before a PR runs. */
export function prEnvDirs(prEnv) {
  return [
    prEnv.USERPROFILE,
    prEnv.APPDATA,
    prEnv.LOCALAPPDATA,
    prEnv.TEMP,
    prEnv.CARGO_HOME,
    prEnv.CARGO_TARGET_DIR,
    prEnv.npm_config_cache,
    prEnv.npm_config_store_dir,
    prEnv.AZURE_CONFIG_DIR,
    prEnv.GH_CONFIG_DIR,
  ];
}

/** Which open PRs this tick validates. Only same-repository heads by allowlisted authors; never forks. */
export function selectPrs(prs, { owner, allowAuthors, done = {} }) {
  const allow = new Set(allowAuthors.map((a) => a.toLowerCase()));
  return prs.map((pr) => {
    const sha = pr.headRefOid;
    const base = { number: pr.number, sha, branch: pr.headRefName };
    if (!SHA40.test(sha ?? "")) return { ...base, skip: "no head commit" };
    if (pr.isCrossRepository) return { ...base, skip: "head is in a fork" };
    if ((pr.headRepositoryOwner?.login ?? "").toLowerCase() !== owner.toLowerCase())
      return { ...base, skip: "head is not in this repository" };
    if (!allow.has((pr.author?.login ?? "").toLowerCase()))
      return { ...base, skip: `author ${pr.author?.login ?? "unknown"} is not allowlisted` };
    if (done[sha]?.state) return { ...base, skip: `already validated (${done[sha].state})` };
    return base;
  });
}

/** GitHub limits a commit status description to 140 characters. */
export function statusDescription(text) {
  const one = String(text).replace(/\s+/g, " ").trim();
  return one.length <= 140 ? one : `${one.slice(0, 139)}…`;
}

export function compareReleaseVersions(a, b) {
  const pa = RELEASE_VERSION.exec(a);
  const pb = RELEASE_VERSION.exec(b);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 4; i++) {
    const x = Number(pa[i] ?? 0);
    const y = Number(pb[i] ?? 0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The release identity for a main commit: the version the release tooling at that commit derives
 * (`releaseVersion()` = X.Y.Z+N when the tooling supports internal builds, else the checked-in X.Y.Z), and
 * the published Stable version as the baseline when it is lower.
 */
export function releaseIdentity({ commit, version, publishedVersion }) {
  if (!SHA40.test(commit)) throw new RunnerError(`bad commit ${commit}`);
  if (!RELEASE_VERSION.test(version ?? "")) throw new RunnerError(`release tooling reported bad version ${version}`);
  const lower = publishedVersion && compareReleaseVersions(publishedVersion, version) === -1;
  return { commit, version, baselineVersion: lower ? publishedVersion : null };
}

/** The exact, only ship.mjs release invocation this runner makes. */
export function shipRunArgs({ commit, version, baselineVersion }) {
  return [
    "tooling/release/ship.mjs",
    "run",
    "--version",
    version,
    "--commit",
    commit,
    ...(baselineVersion ? ["--baseline-version", baselineVersion] : []),
    "--phase",
    "all",
    "--execute",
  ];
}

/** The ship.mjs state directory for an identity (createPipeline's default). */
export function shipStateDir(mainRepo, { version, commit }) {
  return join(mainRepo, "target", "release-pipeline", `${version}-${commit.slice(0, 12)}`);
}

/** What a `ship.mjs run --phase all --execute` exit means for the commit status. */
export function interpretShip(code, output, { timedOut = false } = {}) {
  if (timedOut)
    return { state: "failure", description: `ship.mjs run exceeded ${TIMEOUTS.release / MINUTE} min and was killed` };
  const lines = String(output).split(/\r?\n/).reverse();
  const find = (re) => lines.find((l) => re.test(l));
  if (/another ship\.mjs run holds/.test(output))
    return { state: "pending", busy: true, description: "another ship.mjs run holds the release lock; retrying" };
  if (code === 0) return { state: "success", description: "all release phases complete" };
  if (code === 2) {
    const line = find(/^\[(AWAITING-APPROVAL|AWAITING-OPERATOR|STOP)\]/) ?? "";
    const m = /^\[([A-Z-]+)\] (\S+?):?(?:\s|$)/.exec(line);
    const what = { "AWAITING-APPROVAL": "approval", "AWAITING-OPERATOR": "a person", STOP: "a named production write" };
    return {
      state: "pending",
      stoppedAt: m?.[2] ?? null,
      waitingFor: m ? what[m[1]] : "a person",
      description: m
        ? `waiting for ${what[m[1]]}: ${m[2]} (ship.mjs status)`
        : "waiting for a person (ship.mjs status)",
    };
  }
  const line = find(/REFUSED:|^\[(FAILED|BLOCKED)\]/) ?? find(/\S/) ?? `exit ${code}`;
  const m = /^\[(?:FAILED|BLOCKED)\] (\S+?):/.exec(line);
  return { state: "failure", stoppedAt: m?.[1] ?? null, description: line.trim() };
}

/**
 * Whether ship.mjs's own release lock (`<state dir>/lock`, "ship.mjs <version> pid=<n> at=<iso>") is held by
 * a live run or left behind by a run that was killed: its PID is gone, or it is older than the longest a
 * release run may take (a reused PID cannot keep it alive forever).
 */
export function shipLockState(lockFile, { alive = pidAlive, now = Date.now } = {}) {
  if (!existsSync(lockFile)) return "none";
  let text = "";
  try {
    text = readFileSync(lockFile, "utf8");
  } catch {
    return "held";
  }
  const pid = Number(/pid=(\d+)/.exec(text)?.[1]);
  const at = Date.parse(/at=(\S+)/.exec(text)?.[1] ?? "");
  if (Number.isFinite(at) && now() - at > TIMEOUTS.release + 10 * MINUTE) return "stale";
  if (Number.isInteger(pid) && pid > 0 && !alive(pid)) return "stale";
  return "held";
}

/** Changes in a release state directory that only a person makes (approvals and attestations). */
export function humanFingerprint(stateDir) {
  const parts = [];
  for (const sub of ["approvals", "attestations"]) {
    const dir = join(stateDir, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const st = statSync(join(dir, name));
      if (st.isFile()) parts.push(`${sub}/${name}:${st.size}:${Math.trunc(st.mtimeMs)}`);
    }
  }
  return parts.join(";") || "none";
}

/**
 * Whether the release step must (re)run the pipeline: a new head or identity, a new approval/attestation
 * since the last run, a retry after the lock was busy, or a stale ship.mjs lock that a person has since
 * removed. A failure is not retried until something changes.
 */
export function releaseDue(previous, key, { shipLock = "none" } = {}) {
  if (!previous) return true;
  if (previous.key !== key) return true;
  if (previous.busy) return true;
  if (previous.staleLock) return shipLock === "none";
  return false;
}

export function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "tick";
  if (!["tick", "status"].includes(command)) throw new RunnerError(`unknown command ${command} (tick, status)`);
  const opts = { command, allowAuthors: [], prs: true, main: true, release: true, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new RunnerError(`${a} needs a value`);
      return v;
    };
    if (a === "--control") opts.control = resolve(value());
    else if (a === "--state-root") opts.stateRoot = resolve(value());
    else if (a === "--allow-author") {
      const v = value();
      if (!LOGIN.test(v)) throw new RunnerError(`--allow-author takes a GitHub login, got ${v}`);
      opts.allowAuthors.push(v);
    } else if (a === "--no-prs") opts.prs = false;
    else if (a === "--no-main") opts.main = false;
    else if (a === "--no-release") opts.release = false;
    else if (a === "--dry-run") opts.dryRun = true;
    else throw new RunnerError(`unknown argument ${a}`);
  }
  return opts;
}

export function defaultStateRoot(env = process.env) {
  const base = env.LOCALAPPDATA ?? join(homedir(), ".local", "state");
  return join(base, "KalCode", "trusted-runner");
}

// ------------------------------------------------------------------ effects

function quoteCmd(a) {
  return /^[A-Za-z0-9_./:=@+,-]+$/.test(a) ? a : `"${String(a).replaceAll('"', '\\"')}"`;
}

/** Kills a process and every process it started. */
export function killTree(pid, platform = process.platform) {
  if (!pid) return;
  if (platform === "win32")
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
  else
    try {
      process.kill(-pid, "SIGKILL"); // the child leads its own process group (detached)
    } catch {}
}

/**
 * Real process execution with a hard timeout. With `logFile`, output streams to the file and the caller reads
 * it back; otherwise output is captured. On timeout the whole tree is killed and the result is
 * { code: 124, timedOut: true }.
 */
export function realExec(
  file,
  args,
  { cwd, env = process.env, logFile = null, shell = false, timeoutMs = TIMEOUTS.git } = {},
) {
  return new Promise((done) => {
    let fd = null;
    if (logFile) {
      mkdirSync(dirname(logFile), { recursive: true });
      fd = openSync(logFile, "a");
    }
    let out = "";
    let timedOut = false;
    let finished = false;
    const child = spawn(shell ? [file, ...args].map(quoteCmd).join(" ") : file, shell ? [] : args, {
      cwd,
      env,
      shell,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: fd === null ? ["ignore", "pipe", "pipe"] : ["ignore", fd, fd],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    for (const s of [child.stdout, child.stderr]) {
      s?.setEncoding("utf8");
      s?.on("data", (d) => {
        if (out.length < 32 * 1024 * 1024) out += d;
      });
    }
    const finish = (code, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (fd !== null) closeSync(fd);
      if (timedOut && logFile) appendFileSync(logFile, `\n[trusted-runner] killed after ${timeoutMs} ms\n`);
      done({ code: timedOut ? 124 : code, output: fd === null ? out : null, error, timedOut });
    };
    child.on("error", (e) => finish(127, e.message));
    child.on("close", (code) => finish(code ?? 1, null));
  });
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function lockView(file) {
  try {
    return { held: JSON.parse(readFileSync(file, "utf8")), mtimeMs: statSync(file).mtimeMs };
  } catch {
    try {
      return { held: {}, mtimeMs: statSync(file).mtimeMs };
    } catch {
      return null; // gone
    }
  }
}

/**
 * One tick at a time. The lock file appears atomically with its content (a hard link of a fully written
 * temp file). The holder refreshes its mtime every minute; a lock is stale when its PID is gone or its
 * heartbeat is older than LOCK_STALE_MS (so a reused PID cannot keep it forever). A stale lock is moved
 * aside and removed only if it is still the same lock that was judged stale; otherwise it is put back.
 * Returns { release(), heartbeat() } or null when another live tick holds it.
 */
export function acquireLock(file, { alive = pidAlive, now = Date.now, staleMs = LOCK_STALE_MS } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const token = randomUUID();
  const tmp = `${file}.${token}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, token, at: new Date(now()).toISOString() }));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, file);
        return lockHandle(file, token);
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      const view = lockView(file);
      if (!view) continue; // released meanwhile
      const fresh = now() - view.mtimeMs <= staleMs;
      const live = Number.isInteger(view.held.pid) && alive(view.held.pid);
      if (fresh && live) return null;
      const aside = `${file}.stale-${randomUUID()}`;
      try {
        renameSync(file, aside);
      } catch {
        continue;
      }
      const moved = readJson(aside, {});
      if (moved.token !== view.held.token) {
        // A different lock than the one judged stale: restore it unless someone already holds a new one.
        try {
          linkSync(aside, file);
        } catch {}
        unlinkSync(aside);
        return null;
      }
      unlinkSync(aside);
    }
    return null;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

function lockHandle(file, token) {
  const ours = () => readJson(file, {}).token === token;
  return {
    heartbeat() {
      if (ours()) {
        const t = new Date();
        utimesSync(file, t, t);
      }
    },
    release() {
      if (ours()) unlinkSync(file);
    },
  };
}

// ------------------------------------------------------------------ the tick

/**
 * deps: { exec(file, args, opts) -> Promise<{code, output, timedOut}>, readText(path), log(line), now(), node,
 * env }. Every git, gh, pnpm and ship.mjs call goes through deps.exec with an explicit timeout, so tests can
 * assert exactly what runs where, with which environment and limit.
 */
export function createRunner(opts, deps) {
  const { exec, log, now = () => new Date(), node = process.execPath } = deps;
  const readText = deps.readText ?? ((p) => (existsSync(p) ? readFileSync(p, "utf8") : ""));
  const runnerEnv = deps.env ?? process.env;
  const control = opts.control;
  const stateRoot = opts.stateRoot;
  const statePath = join(stateRoot, "state.json");
  const prClone = join(stateRoot, "pr-clone");
  const isolatedDir = join(stateRoot, "pr-isolated");
  const emptyHooks = join(isolatedDir, "no-hooks");
  const prEnv = buildPrEnv(runnerEnv, { isolatedDir, cargoTargetDir: join(stateRoot, "pr-cargo-target") });
  const stamp = () =>
    now()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");

  const must = (r, what) => {
    if (r.code !== 0)
      throw new RunnerError(
        `${what} ${r.timedOut ? "timed out" : `failed (exit ${r.code})`}: ${(r.output ?? r.error ?? "").trim().split("\n").slice(-3).join(" | ")}`,
      );
    return (r.output ?? "").trim();
  };
  const git = async (cwd, args) =>
    must(await exec("git", ["-C", cwd, ...args], { timeoutMs: TIMEOUTS.git }), `git ${args[0]}`);
  // PR clone: never run its hooks or fsmonitor, and only ever with the PR environment.
  const prGit = async (args) =>
    must(
      await exec("git", ["-C", prClone, "-c", `core.hooksPath=${emptyHooks}`, "-c", "core.fsmonitor=false", ...args], {
        env: prEnv,
        timeoutMs: TIMEOUTS.git,
      }),
      `git ${args[0]} (pr clone)`,
    );

  // The repository that owns the control worktree: ship.mjs keeps release state and evidence there.
  const mainRepo = async () => dirname(await git(control, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));

  let repoSlug = null;
  const slug = async () => {
    if (!repoSlug) {
      repoSlug = must(
        await exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
          cwd: control,
          timeoutMs: TIMEOUTS.gh,
        }),
        "gh repo view",
      );
      if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repoSlug))
        throw new RunnerError(`unexpected repository ${repoSlug}`);
    }
    return repoSlug;
  };
  const postStatus = async (sha, context, state, description) => {
    const d = statusDescription(description);
    log(`status ${context} ${sha.slice(0, 12)} ${state}: ${d}`);
    if (opts.dryRun) return;
    const r = await exec(
      "gh",
      [
        "api",
        "-X",
        "POST",
        `repos/${await slug()}/statuses/${sha}`,
        "-f",
        `state=${state}`,
        "-f",
        `context=${context}`,
        "-f",
        `description=${d}`,
      ],
      { cwd: control, timeoutMs: TIMEOUTS.gh },
    );
    if (r.code !== 0)
      log(`warning: could not post ${context} status on ${sha.slice(0, 12)}: ${(r.output ?? "").trim()}`);
  };
  const runLogged = async (kind, sha, file, args, { cwd, env, shell = false, timeoutMs }) => {
    const logFile = join(stateRoot, "logs", `${stamp()}-${kind}-${sha.slice(0, 12)}.log`);
    log(`run  ${kind}: ${[file, ...args].join(" ")}  (cwd ${cwd}; log ${logFile}; limit ${timeoutMs / MINUTE} min)`);
    const r = await exec(file, args, { cwd, env, logFile, shell, timeoutMs });
    return { ...r, logFile, text: r.output ?? readText(logFile) };
  };
  const gateIn = async (kind, sha, cwd, env, base, installArgs = []) => {
    const install = await runLogged(`${kind}-install`, sha, "pnpm", ["install", "--frozen-lockfile", ...installArgs], {
      cwd,
      env,
      shell: true,
      timeoutMs: TIMEOUTS.install,
    });
    if (install.code !== 0)
      return {
        pass: false,
        logFile: install.logFile,
        why: install.timedOut ? "pnpm install timed out and was killed" : "pnpm install --frozen-lockfile failed",
      };
    const g = await runLogged(kind, sha, node, ["tooling/release/ship.mjs", "gate", "--base", base], {
      cwd,
      env,
      timeoutMs: TIMEOUTS.gate,
    });
    if (g.timedOut)
      return {
        pass: false,
        logFile: g.logFile,
        why: `ship.mjs gate exceeded ${TIMEOUTS.gate / MINUTE} min and was killed`,
      };
    const last = g.text
      .trim()
      .split(/\r?\n/)
      .filter((l) => /^(gate (PASS|FAIL)|FAIL )/.test(l));
    return { pass: g.code === 0, logFile: g.logFile, why: last.at(-1) ?? `ship.mjs gate exited ${g.code}` };
  };

  // The control checkout must be a dedicated detached checkout. The first tick also requires it to be clean
  // (so the runner never adopts, and later force-resets, someone's work); after that, the runner owns it and
  // `checkout --force` discards whatever a gate run left behind.
  async function checkControl(state) {
    const head = await exec("git", ["-C", control, "symbolic-ref", "-q", "HEAD"], { timeoutMs: TIMEOUTS.git });
    if (head.code === 0)
      throw new RunnerError(
        `the control checkout ${control} is on a branch; it must be a dedicated detached checkout of origin/main (docs/RELEASE-PIPELINE.md)`,
      );
    if (state.control === control) return;
    const dirty = await git(control, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty)
      throw new RunnerError(`the control checkout ${control} has local changes; it must only ever hold origin/main`);
    if (!opts.dryRun) state.control = control;
  }

  async function mainStep(state) {
    const head = await git(control, ["rev-parse", "origin/main^{commit}"]);
    const main = state.main ?? {};
    if (main.gated !== head) {
      const isAncestor =
        main.gated &&
        (
          await exec("git", ["-C", control, "merge-base", "--is-ancestor", main.gated, head], {
            timeoutMs: TIMEOUTS.git,
          })
        ).code === 0;
      const prev = isAncestor ? main.gated : await git(control, ["rev-parse", `${head}^1`]);
      log(`main ${head.slice(0, 12)}: gate against ${prev.slice(0, 12)}`);
      if (opts.dryRun) return;
      await git(control, ["checkout", "--detach", "--force", head]);
      await postStatus(head, GATE_CONTEXT, "pending", "trusted runner: local gate running on main");
      const g = await gateIn("main-gate", head, control, runnerEnv, prev);
      await postStatus(head, GATE_CONTEXT, g.pass ? "success" : "failure", `${g.why} (log ${basename(g.logFile)})`);
      state.main = { gated: head, base: prev, gate: g.pass ? "PASS" : "FAIL", log: g.logFile, at: now().toISOString() };
    }
    if (state.main?.gate !== "PASS") {
      log(`main ${head.slice(0, 12)}: gate ${state.main?.gate ?? "not run"}; no release`);
      return;
    }
    if (opts.release) await releaseStep(state, head);
  }

  async function releaseStep(state, head) {
    const st = await exec(node, ["tooling/release/ship.mjs", "lifecycle", "status", "--json"], {
      cwd: control,
      timeoutMs: TIMEOUTS.query,
    });
    if (st.code !== 0) throw new RunnerError(`ship.mjs lifecycle status failed: ${(st.output ?? "").trim()}`);
    const status = JSON.parse(st.output);
    const lanes = status.unshippedLanes ?? [];
    if (!lanes.some((l) => RELEASE_LANES.includes(l))) {
      log(`release: nothing to ship for ${head.slice(0, 12)} (unshipped lanes: ${lanes.join(", ") || "none"})`);
      return;
    }
    const libUrl = pathToFileURL(join(control, "tooling", "release", "lib.mjs")).href;
    const v = await exec(
      node,
      [
        "--input-type=module",
        "-e",
        `const l = await import(${JSON.stringify(libUrl)}); process.stdout.write(typeof l.releaseVersion === "function" ? l.releaseVersion() : l.appVersion());`,
      ],
      { cwd: control, timeoutMs: TIMEOUTS.query },
    );
    const identity = releaseIdentity({
      commit: head,
      version: must(v, "release version"),
      publishedVersion: status.targets?.desktop?.published?.version ?? null,
    });
    const stateDir = shipStateDir(await mainRepo(), identity);
    const shipLock = join(stateDir, "lock");
    const lockState = shipLockState(shipLock);
    const key = `${head}|${identity.version}|${identity.baselineVersion ?? "-"}|${humanFingerprint(stateDir)}`;
    if (!releaseDue(state.release, key, { shipLock: lockState })) {
      log(
        `release: ${identity.version} ${head.slice(0, 12)} unchanged since the last run (${state.release.state}: ${state.release.description})`,
      );
      return;
    }
    const args = shipRunArgs(identity);
    log(`release: ${identity.version} ${head.slice(0, 12)} lanes ${lanes.join(", ")}`);
    if (opts.dryRun) {
      log(`would run: node ${args.join(" ")}`);
      return;
    }
    const record = (outcome, extra = {}) => {
      state.release = { key, commit: head, ...identity, ...outcome, ...extra, at: now().toISOString() };
    };
    // Fail closed unless the trusted checkout holds exactly the gated head, unmodified.
    const at = await git(control, ["rev-parse", "HEAD"]);
    const dirty = await git(control, ["status", "--porcelain", "--untracked-files=no"]);
    if (at !== head || dirty) {
      const outcome = {
        state: "failure",
        description: `control checkout is ${at !== head ? `at ${at.slice(0, 12)}, not ${head.slice(0, 12)}` : "modified"}; release not started`,
      };
      await postStatus(head, RELEASE_CONTEXT, outcome.state, outcome.description);
      record(outcome);
      return;
    }
    if (lockState === "held") {
      log(`release: a live ship.mjs run holds ${shipLock}; retrying next tick`);
      return;
    }
    if (lockState === "stale") {
      const outcome = {
        state: "failure",
        staleLock: shipLock,
        description: `stale ship.mjs lock from a killed run: check its log, then delete ${shipLock}`,
      };
      await postStatus(head, RELEASE_CONTEXT, outcome.state, outcome.description);
      record(outcome);
      return;
    }
    await postStatus(
      head,
      RELEASE_CONTEXT,
      "pending",
      `trusted runner: automated release phases for ${identity.version}`,
    );
    const r = await runLogged("release", head, node, args, {
      cwd: control,
      env: runnerEnv,
      timeoutMs: TIMEOUTS.release,
    });
    const outcome = interpretShip(r.code, r.text, { timedOut: r.timedOut });
    await postStatus(head, RELEASE_CONTEXT, outcome.state, outcome.description);
    record(outcome, { code: r.code, log: r.logFile });
  }

  /** A fresh clone per PR, fed from the control repository's object store: no GitHub credential, no shared .git. */
  async function freshPrClone() {
    rmSync(prClone, { recursive: true, force: true, maxRetries: 3 });
    for (const d of [emptyHooks, ...prEnvDirs(prEnv)]) mkdirSync(d, { recursive: true });
    must(
      await exec("git", ["init", "--quiet", prClone], { env: prEnv, timeoutMs: TIMEOUTS.git }),
      "git init (pr clone)",
    );
    await prGit(["remote", "add", "origin", await mainRepo()]);
    await prGit(["config", "remote.origin.fetch", "+refs/remotes/origin/*:refs/remotes/origin/*"]);
    await prGit(["fetch", "--no-tags", "origin"]);
  }

  async function validatePr(state, pr) {
    log(`pr #${pr.number} ${pr.branch} ${pr.sha.slice(0, 12)}: local gate`);
    if (opts.dryRun) return;
    try {
      await freshPrClone();
      await prGit(["checkout", "--detach", "--force", pr.sha]);
    } catch (e) {
      // A setup failure (for example a head pushed after this tick's fetch) is retried on the next ticks.
      const attempts = (state.prs[pr.sha]?.attempts ?? 0) + 1;
      log(`pr #${pr.number}: setup failed (attempt ${attempts}/${MAX_PR_ATTEMPTS}): ${e.message}`);
      state.prs[pr.sha] = { number: pr.number, attempts, error: e.message, at: now().toISOString() };
      if (attempts >= MAX_PR_ATTEMPTS) {
        state.prs[pr.sha].state = "error";
        await postStatus(pr.sha, GATE_CONTEXT, "error", `trusted runner could not check out this commit: ${e.message}`);
      }
      return;
    }
    await postStatus(pr.sha, GATE_CONTEXT, "pending", "trusted runner: local gate running");
    const g = await gateIn("pr-gate", pr.sha, prClone, prEnv, "origin/main", [
      "--store-dir",
      prEnv.npm_config_store_dir,
    ]);
    await postStatus(pr.sha, GATE_CONTEXT, g.pass ? "success" : "failure", `${g.why} (log ${basename(g.logFile)})`);
    state.prs[pr.sha] = {
      number: pr.number,
      state: g.pass ? "success" : "failure",
      log: g.logFile,
      at: now().toISOString(),
    };
  }

  async function prStep(state) {
    const owner = (await slug()).split("/")[0];
    const allowAuthors = opts.allowAuthors.length ? opts.allowAuthors : [owner];
    const list = must(
      await exec(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          "50",
          "--json",
          "number,headRefOid,headRefName,isCrossRepository,headRepositoryOwner,author",
        ],
        { cwd: control, timeoutMs: TIMEOUTS.gh },
      ),
      "gh pr list",
    );
    state.prs ??= {};
    let failed = null;
    for (const pr of selectPrs(JSON.parse(list), { owner, allowAuthors, done: state.prs })) {
      if (pr.skip) {
        if (!pr.skip.startsWith("already")) log(`pr #${pr.number}: skipped (${pr.skip})`);
        continue;
      }
      // One PR's failure never stops the others.
      try {
        await validatePr(state, pr);
      } catch (e) {
        failed ??= e;
        log(`pr #${pr.number}: error: ${e.message}`);
      }
      if (!opts.dryRun) writeJsonAtomic(statePath, state);
    }
    const keys = Object.keys(state.prs);
    if (keys.length > MAX_PR_RECORDS)
      for (const k of keys
        .sort((a, b) => state.prs[a].at.localeCompare(state.prs[b].at))
        .slice(0, keys.length - MAX_PR_RECORDS))
        delete state.prs[k];
    if (failed) throw failed;
  }

  return {
    async tick() {
      if (existsSync(join(stateRoot, "PAUSED"))) {
        log(`paused: ${join(stateRoot, "PAUSED")} exists`);
        return 0;
      }
      const lock = opts.dryRun ? { release() {}, heartbeat() {} } : acquireLock(join(stateRoot, "tick.lock"));
      if (!lock) {
        log("busy: another tick is running");
        return 0;
      }
      const beat = setInterval(() => lock.heartbeat(), HEARTBEAT_MS);
      beat.unref?.();
      try {
        const state = readJson(statePath, { schema: STATE_SCHEMA });
        await checkControl(state);
        await git(control, ["fetch", "--prune", "origin"]);
        let failed = null;
        // Main first: a merged change shipping matters more than a PR check. One failing step does not
        // starve the other.
        for (const [enabled, step] of [
          [opts.main, mainStep],
          [opts.prs, prStep],
        ]) {
          if (!enabled) continue;
          try {
            await step(state);
          } catch (e) {
            failed ??= e;
            log(`error: ${e.message}`);
          }
          if (!opts.dryRun) writeJsonAtomic(statePath, state);
        }
        if (!opts.dryRun) writeJsonAtomic(statePath, state);
        return failed ? 1 : 0;
      } finally {
        clearInterval(beat);
        lock.release();
      }
    },
  };
}

export async function main(argv, io = {}) {
  const opts = parseArgs(argv);
  opts.stateRoot ??= defaultStateRoot();
  // Scheduled ticks have no console: every line also goes to <state-root>/runner.log.
  const log =
    io.log ??
    ((line) => {
      const text = `${new Date().toISOString()} ${line}\n`;
      process.stdout.write(text);
      if (opts.command === "tick" && !opts.dryRun) {
        mkdirSync(opts.stateRoot, { recursive: true });
        appendFileSync(join(opts.stateRoot, "runner.log"), text);
      }
    });
  if (opts.command === "status") {
    log(
      existsSync(join(opts.stateRoot, "state.json"))
        ? readFileSync(join(opts.stateRoot, "state.json"), "utf8")
        : "no state yet",
    );
    return 0;
  }
  opts.control ??= resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return createRunner(opts, { exec: realExec, log }).tick();
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e instanceof RunnerError ? e.message : e.stack}\n`);
      process.exit(1);
    },
  );
}
