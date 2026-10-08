// Disk hygiene for KalCode build machines (owner request, 2026-10-07).
//
// Every worktree, gate and release job keeps its own Cargo target (one shared CARGO_TARGET_DIR
// makes workspace crates clobber each other), and a debug target is 15-35 GB. Nothing ever removed
// the targets of worktrees nobody builds any more, so a 2 TB build PC kept running down to ~1 GB.
//
//   node tooling/disk-hygiene.mjs status            free space against the thresholds
//   node tooling/disk-hygiene.mjs sweep             dry run: every target classified, nothing deleted
//   node tooling/disk-hygiene.mjs sweep --apply     delete the SAFE cargo intermediates
//
// Heavy entry points call guardDisk() first. Below the warn threshold it starts one hidden,
// idle-priority sweep in the background; below the critical threshold it also stops the build
// before cargo fills the disk halfway through. Nothing here ever stops a process.
//
// A target profile (target/debug, target/<name>/release, ...) is SAFE only when all of these hold:
//   - its worktree is not protected (disk-hygiene.config.json) and no running process mentions it;
//   - no other target's build-script output points into it (release seeds copied from it);
//   - nothing in it, nor its worktree's git index, changed for `idleHours` (`mainIdleHours` for the
//     named caches inside the main checkout's target);
//   - it is not the main checkout's own target/debug or target/release.
// Only the regenerable parts go (deps, build, incremental, .fingerprint, examples, loose build
// products). bundle/ installers, evidence and every other file stay. A kept profile no process
// uses (the main checkout's target/debug included) still sheds per-crate incremental caches
// rustc has not touched for `incrementalDays`; they are never reused and grow without bound.
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants, setPriority, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
export const ROOT = resolve(dirname(SELF), "..");
const GB = 1024 ** 3;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const REGENERABLE_DIRS = new Set(["deps", "build", "incremental", ".fingerprint", "examples"]);
const BUILD_PRODUCTS = new Set([
  ".exe",
  ".pdb",
  ".dll",
  ".rlib",
  ".rmeta",
  ".d",
  ".lib",
  ".exp",
  ".ilk",
  ".dylib",
  ".so",
  ".a",
  ".wasm",
]);
const TRASH = ".kalcode-hygiene-trash";
const SWEEP_EVERY = HOUR;
const SWEEP_LOCK_STALE = 3 * HOUR;

export function loadConfig(path = join(ROOT, "tooling", "disk-hygiene.config.json"), env = process.env) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  const number = (name, fallback) => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0)
      throw new Error(`${name} must be a non-negative number (got "${value}")`);
    return parsed;
  };
  return {
    warnGb: number("KALCODE_DISK_WARN_GB", config.warnGb),
    criticalGb: number("KALCODE_DISK_CRITICAL_GB", config.criticalGb),
    idleHours: number("KALCODE_DISK_IDLE_HOURS", config.idleHours),
    mainIdleHours: number("KALCODE_DISK_MAIN_IDLE_HOURS", config.mainIdleHours),
    incrementalDays: number("KALCODE_DISK_INCREMENTAL_DAYS", config.incrementalDays),
    protect: config.protect ?? [],
    retain: config.retain ?? [],
  };
}

export function stateDir(env = process.env) {
  return env.KALCODE_DISK_HYGIENE_STATE ?? join(tmpdir(), "kalcode-disk-hygiene");
}

export function freeBytes(path = ROOT, statfs = statfsSync) {
  const stats = statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Path comparison key: forward slashes, no trailing slash, case-folded on Windows and macOS. */
export function pathKey(path, platform = process.platform) {
  const slashed = String(path)
    .replaceAll("\\", "/")
    .replace(/^\/\/\?\//, "")
    .replace(/\/+$/, "");
  return platform === "linux" ? slashed : slashed.toLowerCase();
}

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchesAny(name, globs) {
  return globs.some((glob) => globToRegExp(glob).test(name));
}

/** True when `key` (a pathKey) appears in a command line as a whole path, not as a prefix of a longer name. */
export function mentionedBy(key, commandLines) {
  const pattern = new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/"' ]|$)`);
  return commandLines.some((line) => pattern.test(line));
}

export function processCommandLines({ platform = process.platform, run = spawnSync } = {}) {
  const result =
    platform === "win32"
      ? run(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }",
          ],
          { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
        )
      : run("ps", ["-axww", "-o", "command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // Without the process list nothing can be proven idle, so the sweep must not delete anything.
  if (result.status !== 0 || typeof result.stdout !== "string") throw new Error("could not read the process list");
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => pathKey(line, platform));
}

export function listWorktrees(repo = ROOT, run = spawnSync) {
  const result = run("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("git worktree list failed");
  const worktrees = [];
  for (const block of result.stdout.split(/\r?\n\r?\n/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    // git lists the main checkout first; every other entry is a linked worktree.
    if (path) worktrees.push({ path: resolve(path), bare: /^bare$/m.test(block), main: worktrees.length === 0 });
  }
  return worktrees.filter((worktree) => !worktree.bare);
}

function mtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function directories(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== TRASH);
  } catch {
    return [];
  }
}

const isProfile = (path) => existsSync(join(path, ".fingerprint")) || existsSync(join(path, "deps"));

/** Cargo profile dirs inside a target dir: <t>/<profile>, <t>/<triple>/<profile>, <t>/<custom>/<profile>[...]. */
export function profileDirs(target, depth = 3) {
  const found = [];
  for (const entry of directories(target)) {
    const path = join(target, entry.name);
    if (isProfile(path)) found.push(path);
    else if (depth > 1) found.push(...profileDirs(path, depth - 1));
  }
  return found;
}

/** Newest change cargo leaves when it builds in a profile dir (directory mtimes move on every new artifact). */
export function profileActivity(profile) {
  return Math.max(
    mtime(profile),
    mtime(join(profile, ".cargo-lock")),
    ...[".fingerprint", "deps", "build", "incremental"].map((name) => mtime(join(profile, name))),
  );
}

function worktreeActivity(worktree) {
  const dotGit = join(worktree, ".git");
  let gitDir = dotGit;
  try {
    if (statSync(dotGit).isFile()) {
      const pointer = readFileSync(dotGit, "utf8")
        .match(/^gitdir: (.+)$/m)?.[1]
        ?.trim();
      if (pointer) gitDir = resolve(worktree, pointer);
    }
  } catch {
    return 0;
  }
  return Math.max(mtime(join(gitDir, "index")), mtime(join(gitDir, "HEAD")));
}

/** Absolute paths that a profile's build-script outputs point at (OUT_DIR, link search paths). */
export function buildOutputPaths(profile) {
  const paths = [];
  for (const entry of directories(join(profile, "build"))) {
    for (const file of ["output", "root-output"]) {
      let text;
      try {
        text = readFileSync(join(profile, "build", entry.name, file), "utf8");
      } catch {
        continue;
      }
      for (const match of text.matchAll(/(?:[A-Za-z]:[\\/]|\/)[^\r\n"'=;]+/g)) paths.push(match[0]);
    }
  }
  return paths;
}

/** A running process names the profile, or the linked worktree it belongs to. */
export function inUse(profile, commandLines, platform = process.platform) {
  // Every session in the main checkout mentions its root, so there only the profile path counts.
  return (
    mentionedBy(profile.key, commandLines) ||
    (!profile.main && mentionedBy(pathKey(profile.worktree, platform), commandLines))
  );
}

/**
 * Classifies every cargo profile in every worktree target (and the main checkout's nested custom
 * targets). Pure apart from reading the file system; deletion happens in applySweep.
 */
export function planSweep({
  repo = ROOT,
  config = loadConfig(),
  now = Date.now(),
  worktrees = listWorktrees(repo),
  commandLines = processCommandLines(),
  platform = process.platform,
} = {}) {
  const profiles = [];
  for (const worktree of worktrees) {
    const target = join(worktree.path, "target");
    if (!existsSync(target)) continue;
    const main = worktree.main === true;
    for (const profile of profileDirs(target)) {
      profiles.push({
        path: profile,
        key: pathKey(profile, platform),
        target,
        worktree: worktree.path,
        main,
        // The main checkout's own target/debug and target/release are the owner's live cache.
        topLevelMain:
          main &&
          pathKey(dirname(profile), platform) === pathKey(target, platform) &&
          ["debug", "release"].includes(basename(profile)),
      });
    }
  }

  // Seeds copied from another target keep pointing at it; that origin must survive.
  const referencedBy = new Map();
  for (const profile of profiles) {
    for (const path of buildOutputPaths(profile.path)) {
      const key = pathKey(path, platform);
      if (key.startsWith(`${profile.key}/`)) continue;
      const origin = profiles.find((other) => other !== profile && key.startsWith(`${other.key}/`));
      if (origin && !referencedBy.has(origin.key)) referencedBy.set(origin.key, profile.path);
    }
  }

  const retainedNewest = new Set();
  for (const rule of config.retain) {
    const matching = profiles
      .filter((profile) => matchesAny(basename(profile.worktree), [rule.match]))
      .sort((a, b) => profileActivity(b.path) - profileActivity(a.path));
    for (const profile of matching.slice(0, rule.keepNewest ?? 0)) retainedNewest.add(profile.key);
  }

  return profiles.map((profile) => {
    // A kept profile that no process uses still sheds incremental caches untouched for a week.
    const keep = (reason, trimmable = true) => ({
      ...profile,
      verdict: "KEEP",
      reason,
      trim: trimmable ? staleIncremental(profile.path, now - config.incrementalDays * DAY) : [],
    });
    const name = basename(profile.worktree);
    if (!profile.main && matchesAny(name, config.protect)) return keep(`protected worktree (${name})`, false);
    if (inUse(profile, commandLines, platform)) return keep("a running process uses it", false);
    if (profile.topLevelMain) return keep("main checkout's own build cache");
    if (retainedNewest.has(profile.key)) return keep("one of the newest retained seeds");
    if (referencedBy.has(profile.key)) return keep(`build outputs of ${referencedBy.get(profile.key)} point into it`);
    // Named caches inside the main checkout (target/e2e, lane dirs) are shared and reused for days.
    const idleMs = (profile.main ? config.mainIdleHours : config.idleHours) * HOUR;
    const activity = Math.max(profileActivity(profile.path), profile.main ? 0 : worktreeActivity(profile.worktree));
    if (now - activity < idleMs) return keep(`active ${Math.round((now - activity) / HOUR)} h ago`);
    return { ...profile, verdict: "SAFE", reason: `idle ${Math.round((now - activity) / HOUR)} h`, activity };
  });
}

/**
 * Per-crate incremental dirs (incremental/<crate>-<hash>) rustc has not written since `before`.
 * rustc keeps one session per crate and never deletes the dirs of crates that are gone or
 * rebuilt under a new hash; a removed dir only costs that crate one non-incremental compile.
 */
export function staleIncremental(profile, before) {
  const root = join(profile, "incremental");
  return directories(root)
    .map((entry) => join(root, entry.name))
    .filter(
      (dir) => Math.max(mtime(dir), ...directories(dir).map((session) => mtime(join(dir, session.name)))) < before,
    );
}

/** What applySweep removes from one profile dir: regenerable dirs and loose build products only. */
export function regenerableEntries(profile) {
  let entries;
  try {
    entries = readdirSync(profile, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) =>
      entry.isDirectory()
        ? REGENERABLE_DIRS.has(entry.name)
        : entry.name === ".cargo-lock" || BUILD_PRODUCTS.has(extname(entry.name).toLowerCase()),
    )
    .map((entry) => join(profile, entry.name));
}

function clearTrash(target, remove) {
  const trash = join(target, TRASH);
  if (existsSync(trash)) remove(trash, { recursive: true, force: true, maxRetries: 2 });
}

/**
 * Deletes the SAFE profiles' regenerable entries. Each entry is first renamed into a trash dir in
 * the same target: Windows refuses that rename while a process holds a file inside, so anything a
 * build has open is skipped instead of half-deleted. Every profile is re-checked just before.
 */
export function applySweep(plan, { now = Date.now, rename = renameSync, remove = rmSync, recheck = () => true } = {}) {
  const removed = [];
  const skipped = [];
  for (const target of new Set(plan.map((profile) => profile.target))) clearTrash(target, remove);
  for (const profile of plan.filter((entry) => entry.verdict === "SAFE")) {
    if (profileActivity(profile.path) > profile.activity) {
      skipped.push({ path: profile.path, reason: "built since the plan" });
      continue;
    }
    if (!recheck(profile)) {
      skipped.push({ path: profile.path, reason: "a process started using it" });
      continue;
    }
    const trash = join(profile.target, TRASH, `${now()}-${removed.length}-${skipped.length}`);
    mkdirSync(trash, { recursive: true });
    let moved = 0;
    for (const entry of regenerableEntries(profile.path)) {
      try {
        rename(entry, join(trash, basename(entry)));
        moved += 1;
      } catch (error) {
        skipped.push({ path: entry, reason: error?.code ?? "rename failed" });
      }
    }
    remove(trash, { recursive: true, force: true, maxRetries: 2 });
    if (moved > 0) removed.push(profile.path);
  }
  const trimmed = [];
  for (const profile of plan.filter((entry) => entry.verdict === "KEEP" && entry.trim?.length)) {
    if (!recheck(profile)) continue;
    const trash = join(profile.target, TRASH, `${now()}-trim-${trimmed.length}`);
    mkdirSync(trash, { recursive: true });
    for (const dir of profile.trim) {
      try {
        rename(dir, join(trash, basename(dir)));
        trimmed.push(dir);
      } catch (error) {
        skipped.push({ path: dir, reason: error?.code ?? "rename failed" });
      }
    }
    remove(trash, { recursive: true, force: true, maxRetries: 2 });
  }
  return { removed, trimmed, skipped };
}

function readLines(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Appends a JSON line, keeping the file bounded (newest `max` lines). */
function appendBounded(path, record, max = 2000) {
  mkdirSync(dirname(path), { recursive: true });
  const lines = readLines(path);
  if (lines.length >= max) writeFileSync(path, `${lines.slice(-Math.floor(max / 2)).join("\n")}\n`);
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/** Free-space samples (at most one per 10 minutes) and the drop over the last 24 hours. */
export function recordSample(free, { env = process.env, now = Date.now() } = {}) {
  const path = join(stateDir(env), "samples.jsonl");
  const samples = readLines(path).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const last = samples.at(-1);
  if (!last || now - last.at >= 10 * 60_000) appendBounded(path, { at: now, free });
  const dayAgo = samples.find((sample) => now - sample.at <= 24 * HOUR);
  return dayAgo ? dayAgo.free - free : 0;
}

/** Starts one background sweep per hour per machine; returns whether it started one. */
export function startBackgroundSweep({ env = process.env, now = Date.now(), launch = spawn } = {}) {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true });
  const stamp = join(dir, "last-sweep");
  if (now - mtime(stamp) < SWEEP_EVERY) return false;
  writeFileSync(stamp, String(now));
  const child = launch(process.execPath, [SELF, "sweep", "--apply", "--background"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...env, KALCODE_DISK_GUARD: "off" },
  });
  child.unref?.();
  return true;
}

export class DiskSpaceError extends Error {}

/**
 * Called before heavy builds. Never stops a running process: at worst it refuses to start a build
 * that would run out of disk halfway. KALCODE_DISK_GUARD=warn only warns, =off skips the check.
 */
export function guardDisk({
  path = ROOT,
  purpose = "build",
  env = process.env,
  config = loadConfig(undefined, env),
  free = freeBytes(path),
  log = (line) => process.stderr.write(`${line}\n`),
  sweep = startBackgroundSweep,
  now = Date.now(),
} = {}) {
  const mode = (env.KALCODE_DISK_GUARD ?? "on").trim().toLowerCase();
  if (mode === "off") return { level: "skipped", freeGb: free / GB };
  const freeGb = free / GB;
  let drop = 0;
  try {
    drop = recordSample(free, { env, now });
  } catch {}
  const level = freeGb < config.criticalGb ? "critical" : freeGb < config.warnGb ? "low" : "ok";
  if (drop >= 100 * GB)
    log(`[disk] free space fell ${Math.round(drop / GB)} GB in 24 h; run: node tooling/disk-hygiene.mjs sweep`);
  if (level === "ok") return { level, freeGb };
  let started = false;
  try {
    started = sweep({ env, now });
  } catch {}
  log(
    `[disk] ${freeGb.toFixed(1)} GB free (warn below ${config.warnGb} GB).` +
      (started ? " Started a background sweep of idle build caches." : " A sweep ran within the last hour."),
  );
  if (level === "critical" && mode !== "warn") {
    throw new DiskSpaceError(
      `[disk] ${freeGb.toFixed(1)} GB free is below ${config.criticalGb} GB; not starting the ${purpose}. ` +
        "Free space (node tooling/disk-hygiene.mjs sweep --apply) or set KALCODE_DISK_GUARD=warn.",
    );
  }
  return { level, freeGb };
}

/**
 * guardDisk for a heavy entry point: exits on a critical shortage and otherwise never fails the
 * build, even if the guard itself breaks.
 */
export function guardHeavyWork(purpose, options = {}) {
  try {
    return guardDisk({ purpose, ...options });
  } catch (error) {
    if (!(error instanceof DiskSpaceError)) return null;
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

function acquireSweepLock(env) {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "sweep.lock");
  if (existsSync(lock) && Date.now() - mtime(lock) > SWEEP_LOCK_STALE) unlinkSync(lock);
  try {
    closeSync(openSync(lock, "wx"));
  } catch {
    return null;
  }
  return () => rmSync(lock, { force: true });
}

const formatGb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;

function main(argv) {
  const [command = "status", ...flags] = argv;
  const config = loadConfig();
  if (command === "status") {
    const free = freeBytes();
    process.stdout.write(
      `${formatGb(free)} free on the drive holding ${ROOT} (warn below ${config.warnGb} GB, critical below ${config.criticalGb} GB)\n`,
    );
    return 0;
  }
  if (command !== "sweep") {
    process.stderr.write("usage: node tooling/disk-hygiene.mjs status | sweep [--apply]\n");
    return 2;
  }
  const apply = flags.includes("--apply");
  try {
    setPriority(0, constants.priority.PRIORITY_LOW);
  } catch {}
  const release = apply ? acquireSweepLock(process.env) : () => {};
  if (!release) {
    process.stdout.write("[disk] another sweep is running\n");
    return 0;
  }
  try {
    const before = freeBytes();
    const plan = planSweep({ config });
    for (const entry of plan) {
      const trim = entry.trim?.length ? `; ${entry.trim.length} stale incremental dirs` : "";
      process.stdout.write(`${entry.verdict.padEnd(4)} ${entry.path}  (${entry.reason}${trim})\n`);
    }
    if (!apply) {
      const safe = plan.filter((entry) => entry.verdict === "SAFE").length;
      const trims = plan.reduce((sum, entry) => sum + (entry.trim?.length ?? 0), 0);
      process.stdout.write(`${safe} SAFE profiles, ${trims} stale incremental dirs; dry run, nothing deleted\n`);
      return 0;
    }
    // A build may have started in the minutes the plan took: look at the processes again per profile.
    const result = applySweep(plan, {
      recheck: (profile) => !inUse(profile, processCommandLines()),
    });
    const recovered = freeBytes() - before;
    appendBounded(join(stateDir(process.env), "sweep.jsonl"), { at: Date.now(), recovered, ...result });
    process.stdout.write(
      `removed ${result.removed.length} profiles and ${result.trimmed.length} incremental dirs, ` +
        `recovered ${formatGb(recovered)}; skipped ${result.skipped.length}\n`,
    );
    return 0;
  } finally {
    release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) process.exitCode = main(process.argv.slice(2));
