// Release lookahead (opt-in, KALCODE_RELEASE_LOOKAHEAD=1): after a train build round, start the release kit's
// FRONT HALF for the deepest stacked level (what lands when all are green) when its full stack changes desktop
// paths, in speculative mode (-SpeculativeRef), so the signed Windows build and the Mac package are already under
// way while that exact candidate SHA gates.
//
// Safety limits (AGENTS.md "Speculative builds"):
//   - front half only, always with -SpeculativeRef: the kit then skips notes and never publishes; this module
//     never runs the back half, never touches publish.lock, never runs a publish step;
//   - one lookahead release at a time, machine-wide (<lanes>/release-lookahead/active.json);
//   - never for a SHA that already has a front half (kit state dir candidate-<sha12>, a front-half log, or a
//     record of an earlier lookahead launch, which also means a failed launch is never retried automatically);
//   - started so it outlives the train (Start-Process, as by hand; see startDetached) at BelowNormal (or Idle)
//     priority, so it only takes CPU the gates leave; the kit itself drops its Windows build to Idle;
//   - a candidate that changes data/updater paths gets the kit's prepare-release.ps1 -AllowDataOrUpdaterChanges
//     first (logged); -MacFromCommit is the Mac warm tree's commit, and the Mac step is skipped (logged) when that
//     is not an ancestor of the candidate;
//   - every failure is logged and swallowed: the train never breaks because of the lookahead.
//
// Paths (env, with defaults): KALCODE_RELEASE_KIT (kit folder), KALCODE_RELEASE_WINDOWS_SEED (warm target dir;
// default: newest KALCODE_RELEASE_SEED_ROOT\kc-release-code-primary-*\target by mtime, root default C:\),
// KALCODE_RELEASE_LOOKAHEAD_PRIORITY (below-normal | idle, default below-normal).
import { spawnSync as nodeSpawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { join } from "node:path";

import { classifyRange } from "../release/lifecycle/classify.mjs";
import { makeGit as makeLifecycleGit } from "../release/lifecycle/git.mjs";
import { loadPolicy } from "../release/lifecycle/policy.mjs";

export const LOOKAHEAD_ENV = "KALCODE_RELEASE_LOOKAHEAD";
export const DEFAULT_RELEASE_KIT = "C:\\kc-code-primary\\target\\code-primary-release";
export const FRONT_HALF_SCRIPT = "release-front-half.ps1";
export const PREPARE_SCRIPT = "prepare-release.ps1";
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
 * The pure decision. `levels` are the train's stacked levels, bottom first. The target is the DEEPEST level
 * overall: it is what lands when everything is green, so its SHA is the one users get. It is launched only when its
 * full stack (it or any level below it, i.e. train base .. level.sha) changes desktop paths, which
 * `isDesktop(level)` says. If that level later goes red and is superseded, the next round targets the new deepest
 * level (still once per exact SHA, and one at a time, so it starts after the previous lookahead finishes).
 * `isDone(level)` returns a reason string when a speculative or real front half already ran or runs for that exact
 * SHA. `active` is the live lookahead launch, if any (one at a time, machine-wide).
 */
export function decideLookahead({ enabled, levels, isDesktop, isDone, active = null }) {
  if (!enabled) return { launch: false, reason: "disabled" };
  const level = levels.findLast((l) => CANDIDATE.test(l.branch ?? "") && SHA.test(l.sha ?? ""));
  if (!level) return { launch: false, reason: "no-candidate" };
  if (!isDesktop(level)) return { launch: false, reason: "no-desktop-change", level };
  if (active) {
    return { launch: false, reason: active.sha === level.sha ? "already-running" : "busy", level, active };
  }
  const done = isDone(level);
  if (done) return { launch: false, reason: "already-done", detail: done, level };
  return { launch: true, level };
}

/** isDesktop for decideLookahead: `ship.mjs classify --base <train base> --head <level>` lists desktop. */
export function makeDesktopClassifier({ repo, base, policy = loadPolicy(), git = makeLifecycleGit(repo) }) {
  return (level) => classifyRange(policy, git, { base, head: level.sha }).lanes.includes("desktop");
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

/** powershell.exe arguments for the kit's front half, always speculative (-SpeculativeRef). */
export function frontHalfArgs({ kit, sha, branch, notesDraft, windowsSeed, repo, macFromCommit = null }) {
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
    ...(macFromCommit ? ["-MacFromCommit", macFromCommit] : []),
  ];
}

/** One Windows command line from argv (CommandLineToArgvW quoting), for Start-Process -ArgumentList. */
export function windowsCommandLine(args) {
  return args
    .map((arg) => {
      const s = String(arg);
      if (s && !/[\s"]/.test(s)) return s;
      return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
    })
    .join(" ");
}

// Why not child_process.spawn({ detached: true })? On Windows that is DETACHED_PROCESS: powershell.exe gets no
// console and exits 0 at once without running the script (seen live 2026-10-06: pid gone in seconds, empty logs).
// Without `detached`, libuv puts the child in a kill-on-close job, so it dies with the train process. So a
// short-lived powershell (in that job, with a hidden console) does what works by hand: Start-Process with
// redirected output. libuv's job allows silent breakaway, so the started process outlives the train. The launcher
// lowers its own priority first, so the front half and everything it starts inherit BelowNormal/Idle. Its stdio is
// NUL and it reports through a result file: Start-Process children inherit handles, and an inherited stdout pipe
// would keep spawnSync waiting until the whole front half exits.
const LAUNCHER = `$ErrorActionPreference = 'Stop'
$a = $env:KALCODE_LOOKAHEAD_LAUNCH | ConvertFrom-Json
try {
  try { (Get-Process -Id $PID).PriorityClass = $a.priority } catch { }
  $p = Start-Process -FilePath $a.file -ArgumentList $a.argumentList -WindowStyle Hidden -PassThru -RedirectStandardOutput $a.out -RedirectStandardError $a.err
  try { $p.PriorityClass = $a.priority } catch { }
  [IO.File]::WriteAllText($a.result, "PID=$($p.Id)")
} catch {
  [IO.File]::WriteAllText($a.result, "ERROR=$($_.Exception.Message)")
  exit 1
}`;

/** Starts `file args` so it outlives this process, with stdout/stderr redirected; returns its pid. */
export function startDetached({
  file = "powershell.exe",
  args,
  out,
  err,
  priority = "below-normal",
  spawnSync = nodeSpawnSync,
  env = process.env,
  fs = nodeFs,
}) {
  const result = `${out}.launch`;
  try {
    fs.unlinkSync(result);
  } catch {}
  const payload = JSON.stringify({
    file,
    argumentList: windowsCommandLine(args),
    out,
    err,
    result,
    priority: priority === "idle" ? "Idle" : "BelowNormal",
  });
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(LAUNCHER, "utf16le").toString("base64"),
    ],
    { env: { ...env, KALCODE_LOOKAHEAD_LAUNCH: payload }, stdio: "ignore", windowsHide: true, timeout: 120_000 },
  );
  let said = "";
  try {
    said = fs.readFileSync(result, "utf8").trim();
    fs.unlinkSync(result);
  } catch {}
  const pid = Number(/^PID=(\d+)$/.exec(said)?.[1]);
  if (r.error || r.status !== 0 || !(pid > 0)) {
    const why = r.error?.message || said.replace(/^ERROR=/, "") || `exit ${r.status}`;
    throw new Error(`could not start ${file}: ${why}`);
  }
  return pid;
}

// The kit's own data/updater rules (prepare-release.ps1): such candidates need -AllowDataOrUpdaterChanges.
const DATA_PATH = /^crates\/(native-core|timeline)\/migrations\//;
const UPDATER_PATH = /^(crates\/updater\/|apps\/desktop\/src-tauri\/src\/updater)/;
export function dataOrUpdaterChanges(paths) {
  const data = paths.some((p) => DATA_PATH.test(p));
  const updater = paths.some((p) => UPDATER_PATH.test(p));
  return { data, updater, any: data || updater };
}

const readJson = (fs, path) => {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
/** Kit candidates with an identity: [{ dir, identity, macStartedAt }] (macStartedAt: its Mac package ran). */
function kitCandidates({ kit, fs }) {
  let entries = [];
  try {
    entries = fs.readdirSync(kit, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^candidate-[0-9a-f]{12}$/.test(entry.name)) continue;
    const dir = join(kit, entry.name);
    const identity = readJson(fs, join(dir, "identity.json"));
    if (!SHA.test(identity?.commit ?? "")) continue;
    let macStartedAt = null;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!/^start-mac-\d+\.log$/.test(name)) continue;
        const path = join(dir, name);
        if (!/STARTED/.test(fs.readFileSync(path, "utf8"))) continue;
        const t = fs.statSync(path).mtimeMs;
        if (macStartedAt === null || t > macStartedAt) macStartedAt = t;
      }
    } catch {}
    out.push({ dir, identity, macStartedAt });
  }
  return out;
}

/**
 * -MacFromCommit: the Mac warm tree's HEAD, i.e. the commit of the kit candidate whose Mac package ran most
 * recently (else the train base). The warm tree also requires it to be an ancestor of the candidate; when it is
 * not, the Mac step is skipped with a reason (the Windows half still runs).
 */
export function macFromCommit({ kit, sha, base, isAncestor, fs = nodeFs }) {
  const ran = kitCandidates({ kit, fs })
    .filter((c) => c.macStartedAt !== null)
    .sort((a, b) => b.macStartedAt - a.macStartedAt)[0];
  const from = ran?.identity.commit ?? base ?? null;
  const source = ran ? `Mac package of ${ran.identity.release ?? ran.identity.commit.slice(0, 12)}` : "train base";
  if (!SHA.test(from ?? "")) return { from: null, skip: "no Mac warm-tree commit known" };
  if (!isAncestor(from, sha)) {
    return {
      from: null,
      source,
      skip: `Mac warm-tree commit ${from.slice(0, 12)} (${source}) is not an ancestor of ${sha.slice(0, 12)}`,
    };
  }
  return { from, source };
}

/**
 * Paths the kit's data/updater check will see: prepare-release diffs the live Stable commit .. candidate. The
 * newest kit identity's liveCommit stands in for it (no network); the train base when that is unknown.
 */
export function pathsSinceLive({ kit, sha, base, isAncestor, diffNames, fs = nodeFs }) {
  const newest = kitCandidates({ kit, fs }).sort((a, b) => (b.identity.build ?? 0) - (a.identity.build ?? 0))[0];
  const live = newest?.identity.liveCommit;
  const from = SHA.test(live ?? "") && isAncestor(live, sha) ? live : base;
  return { from, paths: diffNames(from, sha) };
}

const kitPowerShell = (kit, script, args) => [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  join(kit, script),
  ...args,
];

/** Runs the kit's prepare-release.ps1 -AllowDataOrUpdaterChanges for the candidate (speculative ref env set). */
export function prepareWithDataOrUpdater({ kit, sha, branch, repo, spawnSync = nodeSpawnSync, env = process.env }) {
  const r = spawnSync(
    "powershell.exe",
    kitPowerShell(kit, PREPARE_SCRIPT, [
      "-Commit",
      sha,
      "-Repo",
      repo,
      "-StateRoot",
      kit,
      "-AllowDataOrUpdaterChanges",
    ]),
    {
      env: { ...env, KALCODE_SPECULATIVE_REF: `refs/heads/${branch}`, KALCODE_SPECULATIVE_PR: "" },
      encoding: "utf8",
      windowsHide: true,
      timeout: 300_000,
    },
  );
  if (r.error || r.status !== 0) {
    throw new Error(
      `prepare-release -AllowDataOrUpdaterChanges failed: ${r.error?.message || String(r.stderr ?? "").trim() || `exit ${r.status}`}`,
    );
  }
}

/**
 * Takes the machine-wide lookahead lock, writes the placeholder draft, runs prepare-release first when the
 * candidate changes data/updater paths, starts the kit's front half in speculative mode so it outlives the train,
 * records the launch and appends one merge-log line. Throws on failure (and leaves no lock behind; a record stays,
 * so the SHA is not retried every round); releaseLookahead() logs and swallows it.
 */
export function launchSpeculativeFrontHalf({
  level,
  repo,
  config,
  windowsSeed,
  mac = { from: null },
  dataOrUpdater = { any: false },
  mergeLog = null,
  log = () => {},
  now = Date.now,
  spawnSync = nodeSpawnSync,
  env = process.env,
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
  const record = { pid: null, sha, branch, startedAt: now(), windowsSeed, kit, priority, mac, dataOrUpdater };
  try {
    record.notesDraft = join(dir, `notes-${c12}.draft.md`);
    fs.writeFileSync(record.notesDraft, placeholderNotes({ branch, sha }));
    if (dataOrUpdater.any) {
      log(
        `release lookahead: ${branch} @${c12} changes data/updater paths (data=${dataOrUpdater.data} updater=${dataOrUpdater.updater}); running prepare-release.ps1 -AllowDataOrUpdaterChanges first`,
      );
      prepareWithDataOrUpdater({ kit, sha, branch, repo, spawnSync, env });
    }
    if (mac.skip) log(`release lookahead: SKIP Mac for ${branch} @${c12}: ${mac.skip}; the Windows half still runs`);
    record.log = join(dir, `front-half-spec-${c12}.log`);
    record.pid = startDetached({
      args: frontHalfArgs({
        kit,
        sha,
        branch,
        notesDraft: record.notesDraft,
        windowsSeed,
        repo,
        macFromCommit: mac.from,
      }),
      out: record.log,
      err: join(dir, `front-half-spec-${c12}.err.log`),
      priority,
      spawnSync,
      env,
    });
    record.startedAt = now();
    fs.writeFileSync(lock, `${JSON.stringify(record)}\n`);
    fs.writeFileSync(recordPath(dir, sha), `${JSON.stringify(record, null, 2)}\n`);
    if (mergeLog) {
      try {
        fs.appendFileSync(
          mergeLog,
          `${new Date(record.startedAt).toISOString()} | merge-train | SPECULATIVE RELEASE STARTED ${branch} @${c12} (pid ${record.pid})\n`,
        );
      } catch {}
    }
    return record;
  } catch (error) {
    try {
      fs.writeFileSync(
        recordPath(dir, sha),
        `${JSON.stringify({ ...record, failed: error.message, failedAt: now() }, null, 2)}\n`,
      );
    } catch {}
    try {
      fs.unlinkSync(lock);
    } catch {}
    throw error;
  }
}

const gitIn = (repo, spawnSync) => (args) =>
  spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, timeout: 60_000 });

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
  spawnSync = nodeSpawnSync,
  git = null,
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
    const run = git ?? gitIn(repo, spawnSync);
    const isAncestor = (a, b) => run(["merge-base", "--is-ancestor", a, b]).status === 0;
    const diffNames = (a, b) => {
      const r = run(["diff", "--name-only", "-z", a, b]);
      if (r.status !== 0) throw new Error(`git diff ${a.slice(0, 12)} ${b.slice(0, 12)} failed`);
      return String(r.stdout).split("\0").filter(Boolean);
    };
    const { sha } = decision.level;
    const base = decision.level.base ?? manifest.base;
    const mac = macFromCommit({ kit: config.kit, sha, base, isAncestor, fs });
    const since = pathsSinceLive({ kit: config.kit, sha, base, isAncestor, diffNames, fs });
    const dataOrUpdater = { ...dataOrUpdaterChanges(since.paths), since: since.from };
    const record = launchSpeculativeFrontHalf({
      level: decision.level,
      repo: mainCheckout ?? repo,
      config,
      windowsSeed,
      mac,
      dataOrUpdater,
      mergeLog,
      log,
      now,
      spawnSync,
      env,
      fs,
    });
    const macNote = mac.from ? `, Mac from ${mac.from.slice(0, 12)}` : ", Mac skipped";
    log(`release lookahead: SPECULATIVE RELEASE STARTED${what} (pid ${record.pid}${macNote}, log ${record.log})`);
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
