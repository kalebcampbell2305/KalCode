import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ROOT } from "./lib.mjs";
import { releaseProcessOptions } from "./signing.mjs";

export const UPDATER_SIGNER_MANIFEST = join(ROOT, "tooling", "updater-signer", "Cargo.toml");
export const UPDATER_SIGNER_BINARY = join(ROOT, "target", "release", "kalcode-updater-signer.exe");
export const UPDATER_PUBLIC_KEY_FILE = join(ROOT, "tooling", "release", "updater-public-key.txt");
export const UPDATER_TARGETS = Object.freeze(["windows-x86_64", "darwin-aarch64"]);
export const UPDATER_CHANNELS = Object.freeze(["stable", "beta", "dev"]);

function fail(message) {
  throw new Error(`updater signing blocked: ${message}`);
}

export function validateUpdaterTarget(value) {
  if (typeof value !== "string" || !UPDATER_TARGETS.includes(value)) {
    fail("target must be exactly windows-x86_64 or darwin-aarch64");
  }
  return value;
}

export function validateUpdaterChannel(value) {
  if (typeof value !== "string" || !UPDATER_CHANNELS.includes(value)) {
    fail("channel must be exactly stable, beta, or dev");
  }
  return value;
}

function updaterBindingArgs(target, channel) {
  if (target === undefined && channel === undefined) return [];
  if (target === undefined || channel === undefined) {
    fail("target and channel must be supplied together for schema-v2 signing");
  }
  return ["--target", validateUpdaterTarget(target), "--channel", validateUpdaterChannel(channel)];
}

export function validateUpdaterPublicKey(value) {
  if (typeof value !== "string") fail("public key is missing");
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (!normalized || normalized.trim() !== normalized || /\s/.test(normalized)) {
    fail("public key is not canonical base64");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== normalized) {
    fail("public key is not canonical base64");
  }
  const lines = decoded.toString("utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 2 || !lines[0].startsWith("untrusted comment: minisign public key: ")) {
    fail("public key is not a Minisign public key");
  }
  const record = Buffer.from(lines[1], "base64");
  if (record.length !== 42 || record.subarray(0, 2).toString("ascii") !== "Ed") {
    fail("public key is not a Minisign Ed25519 public key");
  }
  return normalized;
}

export function readUpdaterPublicKey(path = UPDATER_PUBLIC_KEY_FILE) {
  if (!existsSync(path)) fail("tracked public key is missing; run pnpm release:updater-key:init");
  return validateUpdaterPublicKey(readFileSync(path, "utf8"));
}

function signerArgs(args) {
  return ["run", "--quiet", "--locked", "--release", "--manifest-path", UPDATER_SIGNER_MANIFEST, "--", ...args];
}

export function invokeUpdaterSigner(args, { spawn = spawnSync, env = process.env } = {}) {
  const result = spawn(
    "cargo",
    signerArgs(args),
    releaseProcessOptions({
      encoding: "utf8",
      env: { ...env, CARGO_TARGET_DIR: join(ROOT, "target") },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (result.error) fail("release signer could not start");
  if (result.status !== 0) fail(`release signer exited with ${String(result.status)}`);
  return (result.stdout ?? "").trimEnd();
}

function equalPublicKeys(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function assertUpdaterKeyReady({ publicKeyPath = UPDATER_PUBLIC_KEY_FILE, storePath, spawn } = {}) {
  const expected = readUpdaterPublicKey(publicKeyPath);
  const args = ["public-key"];
  if (storePath) args.push("--store", storePath);
  const actual = validateUpdaterPublicKey(invokeUpdaterSigner(args, { spawn }));
  if (!equalPublicKeys(expected, actual)) fail("DPAPI key store does not match the tracked public key");
  return expected;
}

export function initializeUpdaterKey({ publicKeyPath = UPDATER_PUBLIC_KEY_FILE, storePath, spawn } = {}) {
  if (existsSync(publicKeyPath)) fail("tracked public key already exists; key rotation requires an explicit migration");
  const args = ["init"];
  if (storePath) args.push("--store", storePath);
  const publicKey = validateUpdaterPublicKey(invokeUpdaterSigner(args, { spawn }));
  mkdirSync(dirname(publicKeyPath), { recursive: true });
  const temp = `${publicKeyPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${publicKey}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temp, publicKeyPath);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return publicKey;
}

export function signUpdaterArtifact({
  artifactPath,
  signaturePath,
  version,
  target,
  channel,
  publicKeyPath,
  storePath,
  spawn,
}) {
  const bindingArgs = updaterBindingArgs(target, channel);
  const publicKey = assertUpdaterKeyReady({ publicKeyPath, storePath, spawn });
  const common = ["--artifact", artifactPath, "--signature", signaturePath, "--version", version, ...bindingArgs];
  const signArgs = ["sign", ...common];
  if (storePath) signArgs.push("--store", storePath);
  invokeUpdaterSigner(signArgs, { spawn });
  invokeUpdaterSigner(["verify", ...common, "--public-key", publicKey], { spawn });
  return publicKey;
}

export function verifyUpdaterArtifact({ artifactPath, signaturePath, version, target, channel, publicKeyPath, spawn }) {
  const bindingArgs = updaterBindingArgs(target, channel);
  const publicKey = readUpdaterPublicKey(publicKeyPath);
  const args = [
    "verify",
    "--artifact",
    artifactPath,
    "--signature",
    signaturePath,
    "--version",
    version,
    "--public-key",
    publicKey,
  ];
  args.push(...bindingArgs);
  invokeUpdaterSigner(args, { spawn });
  return publicKey;
}
