#!/usr/bin/env node
// KalCode Live Update, release side. Every Windows build publishes, next to its signed installer:
//
//   live/<target>.json   a signed envelope: base64 of the live descriptor + its Minisign signature
//   live/<ui file>.kui    the build's UI bundle (apps/desktop/dist), bound by size and SHA-256
//
// The descriptor names the build's NATIVE FINGERPRINT: a hash of every input to the desktop shell
// binary. A running KalCode whose own fingerprint (compiled in from KALCODE_NATIVE_FINGERPRINT) is
// identical applies the new UI live; anything else is a core update through the installer. The
// client side and the bundle format are documented in crates/updater/src/live.rs.
//
// Usage: node tooling/release/live-update.mjs fingerprint [--commit <sha>]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

export const LIVE_SCHEMA_VERSION = 1;

/**
 * Every tracked input to the native desktop binary (Rust sources and their build scripts, the
 * Tauri config, capabilities and permissions, NSIS hooks, vendored crates, toolchain, and the
 * tooling that drives the native build). The UI (apps/desktop/src, packages/ui, …) is excluded:
 * that is exactly what may change without a new shell. When in doubt a path belongs here; an
 * extra path only turns a live UI update into a core update, never the reverse.
 */
export const NATIVE_PATHS = Object.freeze([
  ".cargo",
  "Cargo.lock",
  "Cargo.toml",
  "apps/desktop/src-tauri",
  "crates",
  "rust-toolchain.toml",
  "third_party",
  "tooling/release/build-windows.mjs",
  "tooling/release/component-public-key.json",
  "tooling/release/guardian-packaging.mjs",
  "tooling/release/hook-packaging.mjs",
  "tooling/release/updater-public-key.txt",
]);

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[1-9]\d*)?$/;
const TARGETS = new Set(["windows-x86_64", "darwin-aarch64"]);
const CHANNELS = new Set(["stable", "beta", "dev"]);
const BUNDLE_MAGIC = Buffer.from("KALUI1\n", "utf8");
const MAX_UI_FILES = 4096;
const MAX_UI_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_UI_EXPANDED_BYTES = 256 * 1024 * 1024;
const SAFE_PART = /^[A-Za-z0-9._@+-]+$/;

function fail(message) {
  throw new Error(`live update blocked: ${message}`);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The native fingerprint of `commit`: SHA-256 over `git ls-tree -r` of NATIVE_PATHS (mode, blob id
 * and path of every file). Git content ids make it exact and independent of checkout state.
 */
export function nativeFingerprint({ commit, cwd, exec = execFileSync } = {}) {
  if (!COMMIT.test(commit ?? "")) fail("fingerprint needs an exact 40-character commit");
  const listing = exec("git", ["ls-tree", "-r", "--full-tree", commit, "--", ...NATIVE_PATHS], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (!listing.includes("apps/desktop/src-tauri/") || !listing.includes("crates/")) {
    fail("the native inputs were not found at that commit");
  }
  return sha256(Buffer.from(`kalcode-native-fingerprint-v1\n${listing}`, "utf8"));
}

function bundlePathOk(path) {
  return (
    path.length > 0 &&
    path.length <= 256 &&
    path !== "kalcode-ui.json" &&
    path.split("/").every((part) => part !== "." && part !== ".." && SAFE_PART.test(part))
  );
}

function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
    else fail(`the UI build contains an unsupported entry: ${entry.name}`);
  }
  return out;
}

/**
 * Packs a built UI (apps/desktop/dist) in the format crates/updater/src/live.rs reads:
 * gzip(`KALUI1\n` + u32-LE index length + index JSON + file bytes in index order). Files are sorted
 * so the bundle is reproducible for a given build.
 */
export function packUiBundle(distDir) {
  const paths = walk(distDir).sort();
  if (!paths.includes("index.html")) fail("the UI build has no index.html");
  if (paths.length > MAX_UI_FILES) fail("the UI build has too many files");
  const contents = paths.map((path) => {
    if (!bundlePathOk(path)) fail(`unsafe UI file name: ${path}`);
    const bytes = readFileSync(join(distDir, ...path.split("/")));
    // KalCode's CSP allows only same-origin scripts and styles; an inline one would be blocked
    // in a live UI and fail its health check, so refuse it at build time.
    if (path.endsWith(".html") && /<script(?![^>]*\ssrc=)[^>]*>|<style[\s>]/i.test(bytes.toString("utf8"))) {
      fail(`inline script or style in ${path}`);
    }
    return bytes;
  });
  const index = Buffer.from(
    JSON.stringify({
      files: paths.map((path, i) => ({ path, size: contents[i].length, sha256: sha256(contents[i]) })),
    }),
    "utf8",
  );
  const length = Buffer.alloc(4);
  length.writeUInt32LE(index.length);
  const expanded = Buffer.concat([BUNDLE_MAGIC, length, index, ...contents]);
  if (expanded.length > MAX_UI_EXPANDED_BYTES) fail("the UI build is too large");
  const bytes = gzipSync(expanded, { level: 9 });
  if (bytes.length > MAX_UI_BUNDLE_BYTES) fail("the UI bundle is too large");
  return { bytes, sha256: sha256(bytes), size: bytes.length, expandedSize: expanded.length, files: paths.length };
}

/** The exact descriptor bytes that get signed. */
export function liveDescriptorBytes({ version, channel, target, commit, nativeFingerprint: native, ui }) {
  if (!VERSION.test(version ?? "")) fail(`bad version ${version}`);
  if (!CHANNELS.has(channel)) fail(`bad channel ${channel}`);
  if (!TARGETS.has(target)) fail(`bad target ${target}`);
  if (!COMMIT.test(commit ?? "")) fail("bad commit");
  if (!SHA256.test(native ?? "")) fail("bad native fingerprint");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.kui$/.test(ui?.file ?? "") || ui.file.includes("..")) {
    fail("bad UI bundle file name");
  }
  if (!SHA256.test(ui.sha256) || !(ui.size > 0) || !(ui.expandedSize > 0) || !(ui.files > 0)) {
    fail("bad UI bundle metadata");
  }
  return Buffer.from(
    JSON.stringify({
      schemaVersion: LIVE_SCHEMA_VERSION,
      version,
      channel,
      target,
      commit,
      shell: { nativeFingerprint: native },
      ui: { file: ui.file, size: ui.size, sha256: ui.sha256, expandedSize: ui.expandedSize, files: ui.files },
    }),
    "utf8",
  );
}

/** The published envelope: the signed descriptor and its signature (base64, as in the feed). */
export function liveEnvelope(descriptorBytes, signatureBase64) {
  const signature = String(signatureBase64).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) fail("the descriptor signature is not base64");
  return `${JSON.stringify({ schemaVersion: LIVE_SCHEMA_VERSION, descriptor: descriptorBytes.toString("base64"), signature })}\n`;
}

/** File names for a build's live artifacts, derived from its installer name. */
export function liveFileNames(installerFile, target = "windows-x86_64") {
  const match = /^(KalCode_[0-9.]+(?:_build[1-9]\d*)?)_x64-setup\.exe$/.exec(installerFile);
  if (!match) fail(`unexpected installer name ${installerFile}`);
  return {
    descriptor: `${match[1]}_x64-live.json`,
    ui: `${match[1]}_ui.kui`,
    envelope: `${target}.json`,
  };
}

/** R2 keys of a build's live artifacts (served by apps/website/worker/downloads.ts). */
export function liveKeys(channel, version, uiFile, target = "windows-x86_64") {
  if (!CHANNELS.has(channel) || !VERSION.test(version) || !TARGETS.has(target)) fail("bad live key input");
  const base = `releases/updater/${channel}/${version}/live`;
  return { envelope: `${base}/${target}.json`, ui: `${base}/${uiFile}` };
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "fingerprint") {
    const at = rest.indexOf("--commit");
    const commit =
      at >= 0
        ? rest[at + 1]
        : execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
    console.log(nativeFingerprint({ commit }));
    return;
  }
  if (command === "pack") {
    const [dist] = rest;
    if (!dist || !statSync(dist).isDirectory()) fail("usage: live-update.mjs pack <dist dir>");
    const { sha256: hash, size, expandedSize, files } = packUiBundle(dist);
    console.log(JSON.stringify({ sha256: hash, size, expandedSize, files }));
    return;
  }
  console.error("usage: node tooling/release/live-update.mjs fingerprint [--commit <sha>] | pack <dist dir>");
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
