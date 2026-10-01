// Shared helpers for the release scripts in tooling/release. No dependencies beyond Node.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const DESKTOP_DIR = join(ROOT, "apps", "desktop");
export const WEBSITE_DIR = join(ROOT, "apps", "website");
export const TAURI_CONF = join(DESKTOP_DIR, "src-tauri", "tauri.conf.json");
export const WEBSITE_MANIFEST = join(WEBSITE_DIR, "src", "data", "releases.json");
export const RELEASE_NOTES_DIR = join(ROOT, "docs", "releases");
/** Cargo target dir the release build writes to (the workspace default). */
export const TARGET_DIR = join(ROOT, "target");
/** Local release staging area. `dist/` is ignored by git. */
export const STAGING_DIR = join(ROOT, "dist", "release");
export const R2_BUCKET = "kalcode-releases";

export function fail(message) {
  console.error(`\nrelease: ${message}`);
  process.exit(1);
}

/**
 * On Windows, pnpm/npx are .cmd shims that need a shell. Node warns about passing an argument
 * array together with `shell`, so those calls get one pre-quoted command line instead.
 */
function spawnArgs(command, args) {
  if (process.platform !== "win32" || !["pnpm", "npx"].includes(command)) return [command, args, {}];
  const quoted = args.map((a) => (/^[\w@./:=-]+$/.test(a) ? a : `"${a.replaceAll('"', '\\"')}"`));
  return [[command, ...quoted].join(" "), [], { shell: true }];
}

/** Runs a command, streaming its output. Throws on a non-zero exit. */
export function run(command, args, options = {}) {
  const [cmd, argv, extra] = spawnArgs(command, args);
  const result = spawnSync(cmd, argv, {
    cwd: ROOT,
    stdio: "inherit",
    windowsHide: true,
    ...extra,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
  return result;
}

/** Runs a command and returns trimmed stdout. Throws on a non-zero exit. */
export function capture(command, args, options = {}) {
  const [cmd, argv, extra] = spawnArgs(command, args);
  const result = spawnSync(cmd, argv, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    ...extra,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}: ${result.stderr?.trim() ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

export function git(args) {
  return capture("git", args);
}

export function headCommit() {
  return git(["rev-parse", "HEAD"]);
}

/** Tracked or untracked (non-ignored) changes in the working tree, one per line. */
export function dirtyFiles() {
  return git(["status", "--porcelain", "--untracked-files=normal"]).split("\n").filter(Boolean);
}

export function assertCleanTree(what) {
  const dirty = dirtyFiles();
  if (dirty.length > 0) {
    fail(
      `${what} needs a clean working tree so the artifact matches a commit. Commit or stash:\n  ${dirty.join("\n  ")}`,
    );
  }
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Writes JSON with LF line endings and a trailing newline. */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function appVersion() {
  const conf = readJson(TAURI_CONF);
  if (typeof conf.version !== "string") fail(`No version in ${TAURI_CONF}`);
  return conf.version;
}

/** Windows version resources hold each part in 16 bits, so a build number must fit. */
export const MAX_BUILD_NUMBER = 65_535;
const RELEASE_VERSION =
  /^((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?:\+([1-9]\d*))?$/;

/**
 * Splits an internal release version into its public version and build number:
 * "0.1.7+779" -> { publicVersion: "0.1.7", build: 779 }; a plain "0.1.7" is build 0.
 */
export function splitReleaseVersion(version) {
  const match = RELEASE_VERSION.exec(String(version ?? ""));
  if (!match) throw new Error(`release version ${JSON.stringify(version)} is not X.Y.Z or X.Y.Z+<build>`);
  const build = match[5] === undefined ? 0 : Number(match[5]);
  if (!Number.isSafeInteger(build) || build > MAX_BUILD_NUMBER) {
    throw new Error(`release build number must be 1..${MAX_BUILD_NUMBER}`);
  }
  return { publicVersion: match[1], build };
}

/**
 * The file-name form of a release version. `+` is not allowed in artifact names (the updater
 * signature binds a `[A-Za-z0-9._-]` file name), so "0.1.7+779" becomes "0.1.7_build779".
 */
export function releaseFileVersion(version) {
  const { publicVersion, build } = splitReleaseVersion(version);
  return build === 0 ? publicVersion : `${publicVersion}_build${build}`;
}

/**
 * The commit a release version is numbered from: HEAD, or, when HEAD only adds release notes
 * (`docs/releases/`) on top of it, the oldest first-parent ancestor with the same tree outside
 * `docs/releases/`. Build and publish therefore agree on one build number.
 */
export function releaseCommit(runGit = git) {
  if (runGit(["rev-parse", "--is-shallow-repository"]) !== "false") {
    throw new Error("release build numbers need the full git history; this clone is shallow");
  }
  const head = runGit(["rev-parse", "HEAD"]);
  let commit = head;
  for (;;) {
    let parent;
    try {
      parent = runGit(["rev-parse", "--verify", "--quiet", `${commit}^1`]);
    } catch {
      return commit;
    }
    if (!parent) return commit;
    const changed = runGit(["diff", "--name-only", "--no-renames", parent, head]).split(/\r?\n/).filter(Boolean);
    if (changed.some((file) => !file.startsWith("docs/releases/"))) return commit;
    commit = parent;
  }
}

/**
 * The internal release version "X.Y.Z+N": the public version checked in to tauri.conf.json plus
 * build number N, the count of commits reachable from `releaseCommit()`. N increases with every
 * commit on main, so each production build is newer than the last while the public version
 * stays the same. The public version changes only when the owner declares a new version.
 */
export function releaseVersion(runGit = git) {
  const build = Number(runGit(["rev-list", "--count", releaseCommit(runGit)]));
  const version = `${appVersion()}+${build}`;
  splitReleaseVersion(version);
  return version;
}

/**
 * The Tauri config overlay (`tauri build --config`) that stamps a release version into a build:
 * the app's runtime version becomes "X.Y.Z+N" (the Windows version resources become X.Y.Z.N) and
 * the macOS bundle's CFBundleVersion becomes N. The checked-in version stays "X.Y.Z".
 */
export function releaseVersionOverlay(version) {
  const { publicVersion, build } = splitReleaseVersion(version);
  if (publicVersion !== appVersion()) {
    throw new Error(`release version ${version} does not match the checked-in version ${appVersion()}`);
  }
  return build === 0 ? { version } : { version, bundle: { macOS: { bundleVersion: String(build) } } };
}

export function productName() {
  return readJson(TAURI_CONF).productName;
}

export function stagingDir(version) {
  return join(STAGING_DIR, version);
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Runs a PowerShell snippet (Windows PowerShell 5.1) and returns trimmed stdout. */
export function powershell(script) {
  return capture("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
}

/** Runs PowerShell and parses its JSON output (`ConvertTo-Json`). Empty output yields null. */
export function powershellJson(script) {
  const out = powershell(script);
  return out ? JSON.parse(out) : null;
}

/** Quotes a value for a single-quoted PowerShell string literal. */
export function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB (${bytes.toLocaleString("en-US")} bytes)`;
}
