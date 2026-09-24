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

/** Runs a command, streaming its output. Throws on a non-zero exit. */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32" && ["pnpm", "npx"].includes(command),
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
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32" && ["pnpm", "npx"].includes(command),
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
