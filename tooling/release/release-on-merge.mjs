#!/usr/bin/env node
// One release step after a merge to main, run by .github/workflows/release.yml on the guarded release
// runner (tooling/runners/README.md). It decides whether main has unshipped release lanes and, if so,
// runs the release pipeline's automated phases for that head:
//
//   node tooling/release/ship.mjs run --version <X.Y.Z[+N]> --commit <sha> [--baseline-version <v>]
//        --phase all --execute --state <state root>/<version>-<sha12>
//
// The pipeline stops by itself at every approval, attestation, operator step and named production write.
// This step never runs `approve` or `attest` and never names a phase. After a person records one, re-run the
// workflow (`gh workflow run release.yml`) and the pipeline resumes from its state. That state lives
// outside the checkout (the workflow cleans the checkout), under KALCODE_RELEASE_STATE_ROOT.
//
// The release helpers are taken from the trusted-runner prototype (PR #45, 71377bbb) with their tests.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_CONTEXT = "kalcode/release";
export const RELEASE_TIMEOUT_MS = 6 * 60 * 60_000;
const SHA40 = /^[0-9a-f]{40}$/;
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?$/;
const RELEASE_LANES = ["desktop", "docs"];

export class ReleaseError extends Error {}

/** GitHub commit-status descriptions are at most 140 characters, on one line. */
export function statusDescription(text) {
  const one = String(text).replace(/\s+/g, " ").trim();
  return one.length <= 140 ? one : `${one.slice(0, 139)}…`;
}

/** Orders X.Y.Z and X.Y.Z+N (an internal build sorts after its public version); null for anything else. */
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

/** The release identity of a main commit; the published Stable version is the baseline only when lower. */
export function releaseIdentity({ commit, version, publishedVersion }) {
  if (!SHA40.test(commit)) throw new ReleaseError(`bad commit ${commit}`);
  if (!RELEASE_VERSION.test(version ?? "")) throw new ReleaseError(`release tooling reported bad version ${version}`);
  const lower = publishedVersion && compareReleaseVersions(publishedVersion, version) === -1;
  return { commit, version, baselineVersion: lower ? publishedVersion : null };
}

/**
 * Newest valid build wins (owner rule 2026-10-05, high-concurrency release pipeline). A release job for
 * `commit` is SUPERSEDED, and must not build or publish, when:
 *  - main has already advanced to a newer head that contains it (the newest head's job releases every
 *    change at once: rapid landings coalesce instead of shipping each intermediate build), or
 *  - Stable already serves an equal or newer build that contains it.
 * Stable at an equal or newer build WITHOUT this commit is BLOCKED: only a newer exact build can ship it.
 * Returns null when this job should release. `isAncestor(a, b)` is git's `merge-base --is-ancestor a b`.
 */
export function releaseSupersession({ commit, version, mainHead, published, isAncestor }) {
  if (!SHA40.test(commit)) throw new ReleaseError(`bad commit ${commit}`);
  if (SHA40.test(mainHead ?? "") && mainHead !== commit && isAncestor(commit, mainHead)) {
    return {
      state: "superseded",
      description: `SUPERSEDED: main advanced to ${mainHead.slice(0, 12)}, whose release includes ${commit.slice(0, 12)}`,
    };
  }
  const order = published?.version ? compareReleaseVersions(published.version, version) : null;
  if (order !== null && order >= 0) {
    if (SHA40.test(published.commit ?? "") && (published.commit === commit || isAncestor(commit, published.commit))) {
      return {
        state: "superseded",
        description: `SUPERSEDED: Stable ${published.version} already contains ${commit.slice(0, 12)}`,
      };
    }
    return {
      state: "blocked",
      description: `Stable ${published.version} is not older than ${version} and does not contain ${commit.slice(0, 12)}; a newer build is required`,
    };
  }
  return null;
}

/** The state directory for an identity, under the persistent state root. */
export function shipStateDir(stateRoot, { version, commit }) {
  return join(stateRoot, `${version}-${commit.slice(0, 12)}`);
}

/** The exact, only ship.mjs release invocation this step makes. */
export function shipRunArgs({ commit, version, baselineVersion }, stateDir) {
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
    "--state",
    stateDir,
  ];
}

/** What a `ship.mjs run --phase all --execute` exit means for the commit status. */
export function interpretShip(code, output, { timedOut = false } = {}) {
  if (timedOut)
    return { state: "failure", description: `ship.mjs run exceeded ${RELEASE_TIMEOUT_MS / 60_000} min and was killed` };
  const lines = String(output).split(/\r?\n/).reverse();
  const find = (re) => lines.find((l) => re.test(l));
  if (/another ship\.mjs run holds/.test(output))
    return { state: "pending", busy: true, description: "another ship.mjs run holds the release lock; re-run later" };
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

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** ship.mjs's own lock (`<state dir>/lock`): none, held by a live run, or stale after a killed run. */
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
  if (Number.isFinite(at) && now() - at > RELEASE_TIMEOUT_MS + 10 * 60_000) return "stale";
  if (Number.isInteger(pid) && pid > 0 && !alive(pid)) return "stale";
  return "held";
}

function run(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options, windowsHide: true });

  if (r.error) throw new ReleaseError(`${command} failed: ${r.error.message}`);
  return { code: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function postStatus(sha, state, description) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) return;
  const r = run("gh", [
    "api",
    "-X",
    "POST",
    `repos/${repo}/statuses/${sha}`,
    "-f",
    `state=${state}`,
    "-f",
    `context=${RELEASE_CONTEXT}`,
    "-f",
    `description=${statusDescription(description)}`,
    ...(process.env.GITHUB_RUN_ID
      ? ["-f", `target_url=${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`]
      : []),
  ]);
  if (r.code !== 0) console.log(`warning: could not post ${RELEASE_CONTEXT}: ${r.output.trim()}`);
}

/** Runs ship.mjs with live output, returning its exit code and full output. */
function runShip(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32")
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else child.kill("SIGKILL");
    }, RELEASE_TIMEOUT_MS);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
      });
    }
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, output, timedOut });
    });
  });
}

export async function main({ cwd = process.cwd(), env = process.env } = {}) {
  const head = run("git", ["rev-parse", "HEAD"], { cwd }).output.trim();
  if (env.GITHUB_SHA && env.GITHUB_SHA !== head) throw new ReleaseError(`checkout is ${head}, not ${env.GITHUB_SHA}`);
  if (run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd }).output.trim())
    throw new ReleaseError("checkout is modified; release not started");

  const st = run(process.execPath, ["tooling/release/ship.mjs", "lifecycle", "status", "--json"], { cwd });
  if (st.code !== 0) throw new ReleaseError(`ship.mjs lifecycle status failed: ${st.output.trim()}`);
  const status = JSON.parse(st.output);
  const lanes = status.unshippedLanes ?? [];
  if (!lanes.some((lane) => RELEASE_LANES.includes(lane))) {
    console.log(`Nothing to release for ${head.slice(0, 12)} (unshipped lanes: ${lanes.join(", ") || "none"}).`);
    return 0;
  }

  const lib = await import(pathToFileURL(join(cwd, "tooling", "release", "lib.mjs")).href);
  const version = typeof lib.releaseVersion === "function" ? lib.releaseVersion() : lib.appVersion();
  const identity = releaseIdentity({
    commit: head,
    version,
    publishedVersion: status.targets?.desktop?.published?.version ?? null,
  });
  // Coalesce and never publish over a newer live build: an older job yields to the newest valid one.
  run("git", ["fetch", "-q", "origin", "main"], { cwd });
  const mainHead = run("git", ["rev-parse", "origin/main"], { cwd }).output.trim();
  const superseded = releaseSupersession({
    commit: head,
    version: identity.version,
    mainHead,
    published: status.targets?.desktop?.published ?? null,
    isAncestor: (a, b) => run("git", ["merge-base", "--is-ancestor", a, b], { cwd }).code === 0,
  });
  if (superseded) {
    postStatus(head, superseded.state === "blocked" ? "failure" : "success", superseded.description);
    console.log(superseded.description);
    return superseded.state === "blocked" ? 1 : 0;
  }

  const stateRoot = env.KALCODE_RELEASE_STATE_ROOT;
  if (!stateRoot) throw new ReleaseError("KALCODE_RELEASE_STATE_ROOT is not set");
  const stateDir = shipStateDir(stateRoot, identity);
  const lock = shipLockState(join(stateDir, "lock"));
  if (lock !== "none") {
    const description =
      lock === "held"
        ? "a live ship.mjs run holds the release lock; re-run later"
        : `stale ship.mjs lock from a killed run: check its log, then delete ${join(stateDir, "lock")}`;
    postStatus(head, lock === "held" ? "pending" : "failure", description);
    console.log(description);
    return lock === "held" ? 0 : 1;
  }

  const args = shipRunArgs(identity, stateDir);
  console.log(`Release ${identity.version} at ${head.slice(0, 12)} (lanes: ${lanes.join(", ")}); state ${stateDir}`);
  postStatus(head, "pending", `automated release phases for ${identity.version}`);
  const result = await runShip(args);
  const outcome = interpretShip(result.code, result.output, { timedOut: result.timedOut });
  postStatus(head, outcome.state, outcome.description);
  console.log(`${RELEASE_CONTEXT}: ${outcome.state}: ${outcome.description}`);
  return outcome.state === "failure" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof ReleaseError ? `REFUSED: ${error.message}` : error);
      process.exit(1);
    },
  );
}
