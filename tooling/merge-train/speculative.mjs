// Release lookahead (opt-in, KALCODE_RELEASE_LOOKAHEAD=1): after a train build round, start the release kit's
// FRONT HALF for the deepest stacked level that changes desktop paths, in speculative mode (-SpeculativeRef), so
// the signed Windows build and the Mac package are already under way while that exact candidate SHA gates.
//
// Safety limits (AGENTS.md "Speculative builds"):
//   - front half only, always with -SpeculativeRef: the kit then skips notes and never publishes; this module
//     never runs the back half, never touches publish.lock, never runs a publish step;
//   - one lookahead release at a time, machine-wide (<lanes>/release-lookahead/active.json);
//   - never for a SHA that already has a front half (kit state dir candidate-<sha12>, a front-half log, or a
//     record of an earlier lookahead launch, which also means a failed launch is never retried automatically);
//   - detached at BelowNormal (or Idle) priority, so it only takes CPU the gates leave; the kit itself drops its
//     Windows build to Idle in speculative mode;
//   - every failure is logged and swallowed: the train never breaks because of the lookahead.
//
// Paths (env, with defaults): KALCODE_RELEASE_KIT (kit folder), KALCODE_RELEASE_WINDOWS_SEED (warm target dir;
// default: newest KALCODE_RELEASE_SEED_ROOT\kc-release-code-primary-*\target by mtime, root default C:\),
// KALCODE_RELEASE_LOOKAHEAD_PRIORITY (below-normal | idle, default below-normal).
import { spawn as nodeSpawn } from "node:child_process";
import * as nodeFs from "node:fs";
import { constants as osConstants, setPriority as osSetPriority } from "node:os";
import { join } from "node:path";

import { classifyRange } from "../release/lifecycle/classify.mjs";
import { makeGit as makeLifecycleGit } from "../release/lifecycle/git.mjs";
import { loadPolicy } from "../release/lifecycle/policy.mjs";

export const LOOKAHEAD_ENV = "KALCODE_RELEASE_LOOKAHEAD";
export const DEFAULT_RELEASE_KIT = "C:\\kc-code-primary\\target\\code-primary-release";
export const FRONT_HALF_SCRIPT = "release-front-half.ps1";
export const SEED_PREFIX = "kc-release-code-primary-";
const CANDIDATE = /^merge-train\/[0-9a-f]{12}-[0-9a-f]{8}$/;
const SHA = /^[0-9a-f]{40}$/;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60_000;

export const lookaheadEnabled = (env = process.env) => env[LOOKAHEAD_ENV] === "1";

export function lookaheadConfig({ lanesDir, env = process.env }) {
  const priority = env.KALCODE_RELEASE_LOOKAHEAD_PRIORITY === "idle" ? "idle" : "below-normal";
  return {
    dir: join(lanesDir, "release-lookahead"),
    kit: env.KALCODE_RELEASE_KIT || DEFAULT_RELEASE_KIT,
    seed: env.KALCODE_RELEASE_WINDOWS_SEED || null,
    seedRoot: env.KALCODE_RELEASE_SEED_ROOT || "C:\\",
    priority,
  };
}

const recordPath = (dir, sha) => join(dir, `${sha.slice(0, 12)}.json`);
const activePath = (dir) => join(dir, "active.json");

/**
 * The pure decision. `levels` are the train's stacked levels, bottom first. `isDesktop(level, below)` says
 * whether that level's own PRs (below.sha, or the train base, .. level.sha) change desktop paths. `isDone(level)`
 * returns a reason string when a speculative or real front half already ran or runs for that exact SHA.
 * `active` is the live lookahead launch, if any (one at a time, machine-wide).
 */
export function decideLookahead({ enabled, levels, isDesktop, isDone, active = null }) {
  if (!enabled) return { launch: false, reason: "disabled" };
  let level = null;
  for (let k = levels.length - 1; k >= 0 && !level; k--) {
    const candidate = levels[k];
    if (!CANDIDATE.test(candidate.branch ?? "") || !SHA.test(candidate.sha ?? "")) continue;
    if (isDesktop(candidate, levels[k - 1] ?? null)) level = candidate;
  }
  if (!level) return { launch: false, reason: "no-desktop-level" };
  if (active) {
    return { launch: false, reason: active.sha === level.sha ? "already-running" : "busy", level, active };
  }
  const done = isDone(level);
  if (done) return { launch: false, reason: "already-done", detail: done, level };
  return { launch: true, level };
}

/** isDesktop for decideLookahead, using the same policy and logic as `ship.mjs classify --base --head`. */
export function makeDesktopClassifier({ repo, base, policy = loadPolicy(), git = makeLifecycleGit(repo) }) {
  return (level, below) =>
    classifyRange(policy, git, { base: below?.sha ?? base, head: level.sha }).lanes.includes("desktop");
}

/** Why `sha` must not get another front half, or null. */
export function frontHalfDone({ dir, kit, sha, fs = nodeFs }) {
  const c12 = sha.slice(0, 12);
  if (fs.existsSync(recordPath(dir, sha))) return `lookahead already launched for ${c12}`;
  if (fs.existsSync(join(kit, `candidate-${c12}`))) return `kit state dir candidate-${c12} exists`;
  for (const name of [`front-half-${c12}.log`, `front-half-spec-${c12}.log`])
    if (fs.existsSync(join(kit, name))) return `kit log ${name} exists`;
  return null;
}

const defaultIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/**
 * The live lookahead launch, or null. It is live while its front half runs or the Windows build it started
 * (kit candidate-<sha12>/windows.pid) still runs, and for at most `maxAgeMs` (a reused PID never blocks forever).
 */
export function readActive({
  dir,
  kit,
  isAlive = defaultIsAlive,
  now = Date.now,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  fs = nodeFs,
}) {
  let active;
  try {
    active = JSON.parse(fs.readFileSync(activePath(dir), "utf8"));
  } catch {
    return null;
  }
  const fresh = Number.isFinite(active.startedAt) && now() - active.startedAt < maxAgeMs;
  let windowsPid = null;
  if (SHA.test(active.sha ?? "")) {
    try {
      windowsPid = Number(fs.readFileSync(join(kit, `candidate-${active.sha.slice(0, 12)}`, "windows.pid"), "utf8"));
    } catch {}
  }
  const pid = active.pid ?? active.launching; // `launching`: the coordinator between taking the lock and spawning
  const running = (pid > 0 && isAlive(pid)) || (windowsPid > 0 && isAlive(windowsPid));
  if (fresh && running) return active;
  try {
    fs.unlinkSync(activePath(dir));
  } catch {}
  return null;
}

/** Newest existing <root>\kc-release-code-primary-*\target by mtime, skipping trees named in `exclude`. */
export function newestWindowsSeed({ root, exclude = [], fs = nodeFs }) {
  let best = null;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SEED_PREFIX) || exclude.includes(entry.name)) continue;
    const target = join(root, entry.name, "target");
    try {
      const mtimeMs = fs.statSync(target).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) best = { path: target, mtimeMs };
    } catch {}
  }
  return best?.path ?? null;
}

/** The kit refuses notes that are not clean ASCII/LF without to-do markers; this placeholder is never published. */
export function placeholderNotes({ branch, sha }) {
  return `Speculative build of merge-train candidate ${branch} at ${sha}.\nPlaceholder only: release notes are written when the front half is rerun after landing.\n`;
}

export function frontHalfArgs({ kit, sha, branch, notesDraft, windowsSeed, repo }) {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(kit, FRONT_HALF_SCRIPT),
    "-Commit",
    sha,
    "-SpeculativeRef",
    `refs/heads/${branch}`,
    "-NotesDraft",
    notesDraft,
    "-WindowsSeed",
    windowsSeed,
    "-Repo",
    repo,
    "-Kit",
    kit,
  ];
}

/**
 * Takes the machine-wide lookahead lock, writes the placeholder draft, starts the kit's front half detached in
 * speculative mode, lowers its priority, records the launch and appends one merge-log line. Throws on failure
 * (and leaves no lock behind); releaseLookahead() logs and swallows it.
 */
export function launchSpeculativeFrontHalf({
  level,
  repo,
  config,
  windowsSeed,
  mergeLog = null,
  now = Date.now,
  spawn = nodeSpawn,
  setPriority = osSetPriority,
  fs = nodeFs,
}) {
  const { dir, kit, priority } = config;
  const { sha, branch } = level;
  if (!SHA.test(sha) || !CANDIDATE.test(branch)) throw new Error(`not an exact train candidate: ${branch}@${sha}`);
  const c12 = sha.slice(0, 12);
  fs.mkdirSync(dir, { recursive: true });
  const lock = activePath(dir);
  // wx: two coordinators deciding at once cannot both launch.
  fs.writeFileSync(lock, `${JSON.stringify({ pid: null, sha, branch, startedAt: now(), launching: process.pid })}\n`, {
    flag: "wx",
  });
  let out = null;
  let err = null;
  try {
    const notesDraft = join(dir, `notes-${c12}.draft.md`);
    fs.writeFileSync(notesDraft, placeholderNotes({ branch, sha }));
    const logPath = join(dir, `front-half-spec-${c12}.log`);
    out = fs.openSync(logPath, "a");
    err = fs.openSync(join(dir, `front-half-spec-${c12}.err.log`), "a");
    const args = frontHalfArgs({ kit, sha, branch, notesDraft, windowsSeed, repo });
    const child = spawn("powershell.exe", args, { detached: true, stdio: ["ignore", out, err], windowsHide: true });
    if (!child?.pid) throw new Error("the release kit front half did not start");
    child.on?.("error", () => {});
    child.unref?.();
    try {
      setPriority(
        child.pid,
        priority === "idle" ? osConstants.priority.PRIORITY_LOW : osConstants.priority.PRIORITY_BELOW_NORMAL,
      );
    } catch {}
    const startedAt = now();
    const record = { pid: child.pid, sha, branch, startedAt, notesDraft, windowsSeed, kit, log: logPath, priority };
    fs.writeFileSync(lock, `${JSON.stringify(record)}\n`);
    fs.writeFileSync(recordPath(dir, sha), `${JSON.stringify(record, null, 2)}\n`);
    if (mergeLog) {
      try {
        fs.appendFileSync(
          mergeLog,
          `${new Date(startedAt).toISOString()} | merge-train | SPECULATIVE RELEASE STARTED ${branch} @${c12} (pid ${child.pid})\n`,
        );
      } catch {}
    }
    return record;
  } catch (error) {
    try {
      fs.unlinkSync(lock);
    } catch {}
    throw error;
  } finally {
    for (const fd of [out, err]) if (fd !== null) fs.closeSync(fd);
  }
}

/** The train's after-build hook. Never throws. */
export async function releaseLookahead({
  manifest,
  repo,
  mainCheckout,
  lanesDir,
  mergeLog = null,
  env = process.env,
  platform = process.platform,
  log = (line) => process.stdout.write(`${line}\n`),
  isDesktop = null,
  isAlive = defaultIsAlive,
  now = Date.now,
  spawn = nodeSpawn,
  setPriority = osSetPriority,
  fs = nodeFs,
}) {
  if (!lookaheadEnabled(env)) return { launch: false, reason: "disabled" };
  try {
    if (platform !== "win32") {
      log("release lookahead: skipped, the release kit front half runs on Windows only");
      return { launch: false, reason: "unsupported-platform" };
    }
    if (!lanesDir || !manifest?.levels?.length) return { launch: false, reason: "no-levels" };
    const config = lookaheadConfig({ lanesDir, env });
    const decision = decideLookahead({
      enabled: true,
      levels: manifest.levels,
      isDesktop: isDesktop ?? makeDesktopClassifier({ repo, base: manifest.base }),
      isDone: (level) => frontHalfDone({ dir: config.dir, kit: config.kit, sha: level.sha, fs }),
      active: readActive({ dir: config.dir, kit: config.kit, isAlive, now, fs }),
    });
    const what = decision.level ? ` ${decision.level.branch} @${decision.level.sha.slice(0, 12)}` : "";
    if (!decision.launch) {
      const why = decision.active
        ? `; running: ${decision.active.branch} @${decision.active.sha.slice(0, 12)} (pid ${decision.active.pid})`
        : decision.detail
          ? `; ${decision.detail}`
          : "";
      log(`release lookahead: ${decision.reason}${what}${why}`);
      return decision;
    }
    const windowsSeed =
      config.seed ??
      newestWindowsSeed({ root: config.seedRoot, exclude: [`${SEED_PREFIX}${decision.level.sha.slice(0, 12)}`], fs });
    if (!windowsSeed) {
      log(`release lookahead: no warm Windows seed under ${config.seedRoot}; set KALCODE_RELEASE_WINDOWS_SEED`);
      return { launch: false, reason: "no-windows-seed", level: decision.level };
    }
    const record = launchSpeculativeFrontHalf({
      level: decision.level,
      repo: mainCheckout ?? repo,
      config,
      windowsSeed,
      mergeLog,
      now,
      spawn,
      setPriority,
      fs,
    });
    log(`release lookahead: SPECULATIVE RELEASE STARTED${what} (pid ${record.pid}, log ${record.log})`);
    return { launch: true, level: decision.level, record };
  } catch (error) {
    log(`warning: release lookahead failed (the train continues): ${error.message}`);
    return { launch: false, reason: "error", error: error.message };
  }
}

/** The speculative front half that already ran for exactly `sha`, as { branch, source }, or null. */
export function speculativeFrontHalfFor({ sha, lanesDir, kit = DEFAULT_RELEASE_KIT, fs = nodeFs }) {
  if (!SHA.test(sha ?? "")) return null;
  const read = (path) => {
    try {
      return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };
  if (lanesDir) {
    const record = read(recordPath(join(lanesDir, "release-lookahead"), sha));
    if (record?.sha === sha && record.branch) return { branch: record.branch, source: "lookahead" };
  }
  const spec = read(join(kit, `candidate-${sha.slice(0, 12)}`, "speculative.json"));
  if (spec?.commit === sha) {
    const branch = spec.ref ? String(spec.ref).replace(/^refs\/heads\//, "") : spec.pr ? `PR #${spec.pr}` : null;
    if (branch) return { branch, source: "kit" };
  }
  return null;
}
