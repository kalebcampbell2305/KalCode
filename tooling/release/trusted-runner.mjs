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
//      local gate on its head commit in a separate clone with a scrubbed environment and post
//      `kalcode/local-gate` on that commit. PR code never runs in the control checkout, never with the
//      runner's GitHub token or Azure CLI profile in its environment, and never on the Mac.
//
//   node tooling/release/trusted-runner.mjs tick   [--control <dir>] [--state-root <dir>]
//                                                  [--allow-author <login> ...] [--no-prs] [--no-main]
//                                                  [--no-release] [--dry-run]
//   node tooling/release/trusted-runner.mjs status [--state-root <dir>]
//
// Pause: create <state-root>/PAUSED. See docs/RELEASE-PIPELINE.md, "Trusted local runner".
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
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

export class RunnerError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunnerError";
  }
}

// ------------------------------------------------------------------ pure decisions (unit tested)

/**
 * Environment variables a PR's code must not inherit: tokens, keys, passwords and every credential-bearing
 * prefix the release tooling uses (Azure, Cloudflare, Tauri/Minisign updater signing, Apple notarization,
 * GitHub, npm). The PR still runs as the same OS user; see the trust boundary in docs/RELEASE-PIPELINE.md.
 */
export const SECRET_ENV =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PRIVATE|CREDENTIAL|_KEY$|^KEY_|^AZURE_|^ARM_|^MSAL_|^CLOUDFLARE_|^CF_|^WRANGLER_|^TAURI_SIGNING|^MINISIGN|^APPLE_|^NOTARY|^NOTARIZE|^GH_|^GITHUB_|^NPM_|^NODE_AUTH|^SSH_AUTH_SOCK$|^AWS_|^R2_)/i;

/** A copy of `env` with secrets removed and the GitHub CLI and Azure CLI pointed at empty profiles. */
export function scrubEnv(env, { isolatedDir, cargoTargetDir }) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k)) out[k] = v;
  out.AZURE_CONFIG_DIR = join(isolatedDir, "azure");
  out.GH_CONFIG_DIR = join(isolatedDir, "gh");
  out.GIT_TERMINAL_PROMPT = "0";
  out.GCM_INTERACTIVE = "never";
  out.CARGO_TARGET_DIR = cargoTargetDir;
  return out;
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
    if (done[sha]) return { ...base, skip: `already validated (${done[sha].state})` };
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
export function interpretShip(code, output) {
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
 * since the last run, or a retry after the lock was busy. A failure is not retried until something changes.
 */
export function releaseDue(previous, key) {
  if (!previous) return true;
  if (previous.busy) return true;
  return previous.key !== key;
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

// ------------------------------------------------------------------ effects (injected for tests)

function quoteCmd(a) {
  return /^[A-Za-z0-9_./:=@+,-]+$/.test(a) ? a : `"${String(a).replaceAll('"', '\\"')}"`;
}

/** Real process execution. With `logFile`, output streams to the file and the result carries its text. */
export function realExec(file, args, { cwd, env = process.env, logFile = null, shell = false } = {}) {
  let fd = null;
  if (logFile) {
    mkdirSync(dirname(logFile), { recursive: true });
    fd = openSync(logFile, "a");
  }
  try {
    const r = shell
      ? spawnSync([file, ...args].map(quoteCmd).join(" "), {
          cwd,
          env,
          shell: true,
          windowsHide: true,
          stdio: fd === null ? ["ignore", "pipe", "pipe"] : ["ignore", fd, fd],
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        })
      : spawnSync(file, args, {
          cwd,
          env,
          windowsHide: true,
          stdio: fd === null ? ["ignore", "pipe", "pipe"] : ["ignore", fd, fd],
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
    const code = r.error ? 127 : (r.status ?? 1);
    const output = fd === null ? `${r.stdout ?? ""}${r.stderr ?? ""}` : null;
    return { code, output, error: r.error?.message ?? null };
  } finally {
    if (fd !== null) closeSync(fd);
  }
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

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** One tick at a time; a lock whose process is gone is taken over. */
export function acquireLock(file) {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(file);
        } catch {}
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const held = readJson(file, {});
      if (Number.isInteger(held.pid) && pidAlive(held.pid)) return null;
      unlinkSync(file);
    }
  }
  return null;
}

// ------------------------------------------------------------------ the tick

/**
 * deps: { exec(file, args, opts) -> {code, output}, readText(path), log(line), now(), node }.
 * Every git, gh, pnpm and ship.mjs call goes through deps.exec, so tests can assert exactly what runs where
 * and with which environment.
 */
export function createRunner(opts, deps) {
  const { exec, log, now = () => new Date(), node = process.execPath } = deps;
  const readText = deps.readText ?? ((p) => (existsSync(p) ? readFileSync(p, "utf8") : ""));
  const control = opts.control;
  const stateRoot = opts.stateRoot;
  const statePath = join(stateRoot, "state.json");
  const prClone = join(stateRoot, "pr-clone");
  const isolatedDir = join(stateRoot, "pr-isolated");
  const emptyHooks = join(isolatedDir, "no-hooks");
  const prEnv = scrubEnv(deps.env ?? process.env, { isolatedDir, cargoTargetDir: join(stateRoot, "pr-cargo-target") });
  const stamp = () =>
    now()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");

  const must = (r, what) => {
    if (r.code !== 0)
      throw new RunnerError(
        `${what} failed (exit ${r.code}): ${(r.output ?? r.error ?? "").trim().split("\n").slice(-3).join(" | ")}`,
      );
    return (r.output ?? "").trim();
  };
  const git = (cwd, args, extra = {}) => must(exec("git", ["-C", cwd, ...args], extra), `git ${args[0]}`);
  // PR clone: never run its hooks or fsmonitor, and never with the runner's environment.
  const prGit = (args) =>
    must(
      exec("git", ["-C", prClone, "-c", `core.hooksPath=${emptyHooks}`, "-c", "core.fsmonitor=false", ...args], {
        env: prEnv,
      }),
      `git ${args[0]} (pr clone)`,
    );

  // The repository that owns the control worktree: ship.mjs keeps release state and evidence there.
  const mainRepo = () => dirname(git(control, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));

  let repoSlug = null;
  const slug = () => {
    if (!repoSlug) {
      repoSlug = must(
        exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: control }),
        "gh repo view",
      );
      if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repoSlug))
        throw new RunnerError(`unexpected repository ${repoSlug}`);
    }
    return repoSlug;
  };
  const postStatus = (sha, context, state, description) => {
    const d = statusDescription(description);
    log(`status ${context} ${sha.slice(0, 12)} ${state}: ${d}`);
    if (opts.dryRun) return;
    const r = exec(
      "gh",
      [
        "api",
        "-X",
        "POST",
        `repos/${slug()}/statuses/${sha}`,
        "-f",
        `state=${state}`,
        "-f",
        `context=${context}`,
        "-f",
        `description=${d}`,
      ],
      { cwd: control },
    );
    if (r.code !== 0)
      log(`warning: could not post ${context} status on ${sha.slice(0, 12)}: ${(r.output ?? "").trim()}`);
  };
  const runLogged = (kind, sha, file, args, { cwd, env, shell = false }) => {
    const logFile = join(stateRoot, "logs", `${stamp()}-${kind}-${sha.slice(0, 12)}.log`);
    log(`run  ${kind}: ${[file, ...args].join(" ")}  (cwd ${cwd}; log ${logFile})`);
    const r = exec(file, args, { cwd, env, logFile, shell });
    return { ...r, logFile, text: r.output ?? readText(logFile) };
  };
  const gateIn = (kind, sha, cwd, env, base) => {
    const install = runLogged(`${kind}-install`, sha, "pnpm", ["install", "--frozen-lockfile"], {
      cwd,
      env,
      shell: true,
    });
    if (install.code !== 0)
      return { pass: false, logFile: install.logFile, why: "pnpm install --frozen-lockfile failed" };
    const g = runLogged(kind, sha, node, ["tooling/release/ship.mjs", "gate", "--base", base], { cwd, env });
    const last = g.text
      .trim()
      .split(/\r?\n/)
      .filter((l) => /^(gate (PASS|FAIL)|FAIL )/.test(l));
    return { pass: g.code === 0, logFile: g.logFile, why: last.at(-1) ?? `ship.mjs gate exited ${g.code}` };
  };

  // The control checkout must be a dedicated detached checkout. The first tick also requires it to be clean
  // (so the runner never adopts, and later force-resets, someone's work); after that, the runner owns it and
  // `checkout --force` discards whatever a gate run left behind.
  function checkControl(state) {
    const head = exec("git", ["-C", control, "symbolic-ref", "-q", "HEAD"], {});
    if (head.code === 0)
      throw new RunnerError(
        `the control checkout ${control} is on a branch; it must be a dedicated detached checkout of origin/main (docs/RELEASE-PIPELINE.md)`,
      );
    if (state.control === control) return;
    const dirty = git(control, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty)
      throw new RunnerError(`the control checkout ${control} has local changes; it must only ever hold origin/main`);
    if (!opts.dryRun) state.control = control;
  }

  function mainStep(state) {
    const head = git(control, ["rev-parse", "origin/main^{commit}"]);
    const main = state.main ?? {};
    if (main.gated !== head) {
      const prev =
        main.gated && exec("git", ["-C", control, "merge-base", "--is-ancestor", main.gated, head], {}).code === 0
          ? main.gated
          : git(control, ["rev-parse", `${head}^1`]);
      log(`main ${head.slice(0, 12)}: gate against ${prev.slice(0, 12)}`);
      if (opts.dryRun) return;
      git(control, ["checkout", "--detach", "--force", head]);
      postStatus(head, GATE_CONTEXT, "pending", "trusted runner: local gate running on main");
      const g = gateIn("main-gate", head, control, deps.env ?? process.env, prev);
      postStatus(head, GATE_CONTEXT, g.pass ? "success" : "failure", `${g.why} (log ${basename(g.logFile)})`);
      state.main = { gated: head, base: prev, gate: g.pass ? "PASS" : "FAIL", log: g.logFile, at: now().toISOString() };
    }
    if (state.main?.gate !== "PASS") {
      log(`main ${head.slice(0, 12)}: gate ${state.main?.gate ?? "not run"}; no release`);
      return;
    }
    if (opts.release) releaseStep(state, head);
  }

  function releaseStep(state, head) {
    const st = exec(node, ["tooling/release/ship.mjs", "lifecycle", "status", "--json"], { cwd: control });
    if (st.code !== 0) throw new RunnerError(`ship.mjs lifecycle status failed: ${(st.output ?? "").trim()}`);
    const status = JSON.parse(st.output);
    const lanes = status.unshippedLanes ?? [];
    if (!lanes.some((l) => RELEASE_LANES.includes(l))) {
      log(`release: nothing to ship for ${head.slice(0, 12)} (unshipped lanes: ${lanes.join(", ") || "none"})`);
      return;
    }
    const libUrl = pathToFileURL(join(control, "tooling", "release", "lib.mjs")).href;
    const v = exec(
      node,
      [
        "--input-type=module",
        "-e",
        `const l = await import(${JSON.stringify(libUrl)}); process.stdout.write(typeof l.releaseVersion === "function" ? l.releaseVersion() : l.appVersion());`,
      ],
      { cwd: control },
    );
    const identity = releaseIdentity({
      commit: head,
      version: must(v, "release version"),
      publishedVersion: status.targets?.desktop?.published?.version ?? null,
    });
    const key = `${head}|${identity.version}|${identity.baselineVersion ?? "-"}|${humanFingerprint(shipStateDir(mainRepo(), identity))}`;
    if (!releaseDue(state.release, key)) {
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
    postStatus(head, RELEASE_CONTEXT, "pending", `trusted runner: automated release phases for ${identity.version}`);
    const r = runLogged("release", head, node, args, { cwd: control, env: deps.env ?? process.env });
    const outcome = interpretShip(r.code, r.text);
    postStatus(head, RELEASE_CONTEXT, outcome.state, outcome.description);
    state.release = {
      key,
      commit: head,
      ...identity,
      ...outcome,
      code: r.code,
      log: r.logFile,
      at: now().toISOString(),
    };
  }

  function prStep(state) {
    const owner = slug().split("/")[0];
    const allowAuthors = opts.allowAuthors.length ? opts.allowAuthors : [owner];
    const list = must(
      exec(
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
        { cwd: control },
      ),
      "gh pr list",
    );
    state.prs ??= {};
    for (const pr of selectPrs(JSON.parse(list), { owner, allowAuthors, done: state.prs })) {
      if (pr.skip) {
        if (!pr.skip.startsWith("already")) log(`pr #${pr.number}: skipped (${pr.skip})`);
        continue;
      }
      log(`pr #${pr.number} ${pr.branch} ${pr.sha.slice(0, 12)}: local gate`);
      if (opts.dryRun) continue;
      mkdirSync(emptyHooks, { recursive: true });
      mkdirSync(join(isolatedDir, "azure"), { recursive: true });
      mkdirSync(join(isolatedDir, "gh"), { recursive: true });
      if (!existsSync(join(prClone, ".git"))) {
        // The PR clone fetches from the control repository's object store (already fetched from GitHub
        // by the runner), so it never holds or needs a GitHub credential, and it shares no .git (hooks,
        // config) with the trusted checkout.
        must(exec("git", ["init", "--quiet", prClone], {}), "git init (pr clone)");
        prGit(["remote", "add", "origin", mainRepo()]);
        prGit(["config", "remote.origin.fetch", "+refs/remotes/origin/*:refs/remotes/origin/*"]);
      }
      prGit(["fetch", "--prune", "--no-tags", "origin"]);
      prGit(["checkout", "--detach", "--force", pr.sha]);
      prGit(["clean", "-ffdx", "-e", "node_modules"]);
      postStatus(pr.sha, GATE_CONTEXT, "pending", "trusted runner: local gate running");
      const g = gateIn("pr-gate", pr.sha, prClone, prEnv, "origin/main");
      postStatus(pr.sha, GATE_CONTEXT, g.pass ? "success" : "failure", `${g.why} (log ${basename(g.logFile)})`);
      state.prs[pr.sha] = {
        number: pr.number,
        state: g.pass ? "success" : "failure",
        log: g.logFile,
        at: now().toISOString(),
      };
    }
    const keys = Object.keys(state.prs);
    if (keys.length > MAX_PR_RECORDS)
      for (const k of keys
        .sort((a, b) => state.prs[a].at.localeCompare(state.prs[b].at))
        .slice(0, keys.length - MAX_PR_RECORDS))
        delete state.prs[k];
  }

  return {
    tick() {
      if (existsSync(join(stateRoot, "PAUSED"))) {
        log(`paused: ${join(stateRoot, "PAUSED")} exists`);
        return 0;
      }
      const release = opts.dryRun ? () => {} : acquireLock(join(stateRoot, "tick.lock"));
      if (!release) {
        log("busy: another tick is running");
        return 0;
      }
      try {
        const state = readJson(statePath, { schema: STATE_SCHEMA });
        checkControl(state);
        git(control, ["fetch", "--prune", "origin"]);
        let failed = null;
        // Main first: a merged change shipping matters more than a PR check. One failing step does not
        // starve the other.
        for (const [enabled, step] of [
          [opts.main, mainStep],
          [opts.prs, prStep],
        ]) {
          if (!enabled) continue;
          try {
            step(state);
          } catch (e) {
            failed ??= e;
            log(`error: ${e.message}`);
          }
          if (!opts.dryRun) writeJsonAtomic(statePath, state);
        }
        if (!opts.dryRun) writeJsonAtomic(statePath, state);
        return failed ? 1 : 0;
      } finally {
        release();
      }
    },
  };
}

export function main(argv, io = {}) {
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
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`${e instanceof RunnerError ? e.message : e.stack}\n`);
    process.exit(1);
  }
}
