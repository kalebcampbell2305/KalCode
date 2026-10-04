import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { releaseProcessOptions } from "./signing.mjs";

export const COMPONENT_MANIFEST_TYPE = "kalcode-local-component.v1";
export const COMPONENT_CATALOG_TYPE = "kalcode-local-component-catalog.v1";
export const COMPONENT_SIGNER_DIR = join(import.meta.dirname, "..", "component-signer");
export const DEFAULT_COMPONENT_KEY_STORE = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "KalCode", "ReleaseKeys", "component-distribution-signing.dpapi")
  : null;

const KEY_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const COMMAND_OPTIONS = Object.freeze({
  init: new Set(["--kid", "--store"]),
  status: new Set(["--store"]),
  "public-key": new Set(["--store"]),
  "sign-manifest": new Set(["--artifact", "--input", "--output", "--store"]),
  "verify-manifest": new Set(["--artifact", "--public-key-file", "--token"]),
  "sign-catalog": new Set(["--input", "--output", "--store"]),
  "verify-catalog": new Set(["--public-key-file", "--token"]),
});

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has an invalid field set`);
  }
}

export function parseComponentPublicKey(text) {
  let value;
  try {
    value = JSON.parse(String(text));
  } catch {
    throw new Error("component public key is invalid");
  }
  exactKeys(value, ["schemaVersion", "alg", "kid", "x"], "component public key");
  if (value.schemaVersion !== 1 || value.alg !== "EdDSA" || !KEY_ID.test(value.kid) || !PUBLIC_KEY.test(value.x)) {
    throw new Error("component public key is invalid");
  }
  return value;
}

function signerBinary(root) {
  return join(
    root,
    "tooling",
    "component-signer",
    "target",
    "release",
    process.platform === "win32" ? "kalcode-component-signer.exe" : "kalcode-component-signer",
  );
}

export function componentSignerInvocation({ root, command, options = {} }) {
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) throw new Error("component signer command is invalid");
  const names = Object.keys(options).sort();
  if (
    names.some((name) => !allowed.has(name)) ||
    names.some((name) => typeof options[name] !== "string" || !options[name])
  ) {
    throw new Error("component signer options are invalid");
  }
  return {
    command: signerBinary(root),
    args: [command, ...names.flatMap((name) => [name, options[name]])],
  };
}

function defaultRoot() {
  return resolve(import.meta.dirname, "..", "..");
}

function buildSigner(root, { spawn = spawnSync } = {}) {
  const result = spawn(
    "cargo",
    ["build", "--locked", "--release", "--manifest-path", join(root, "tooling", "component-signer", "Cargo.toml")],
    {
      cwd: root,
      ...releaseProcessOptions({ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    },
  );
  if (result.error || result.status !== 0) {
    // Compiler output carries no key material (the signer has not run), so name the cause.
    const tail = String(result.stderr ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)
      .join(" / ")
      .slice(0, 600);
    const cause = result.error?.code ?? `exit ${result.status}${tail ? `: ${tail}` : ""}`;
    throw new Error(`component signer could not be built: ${cause}`);
  }
}

export function runComponentSigner(
  command,
  options,
  { root = defaultRoot(), spawn = spawnSync, exists = existsSync } = {},
) {
  buildSigner(root, { spawn });
  const invocation = componentSignerInvocation({ root, command, options });
  if (!exists(invocation.command)) throw new Error("component signer build did not produce the expected binary");
  const result = spawn(
    invocation.command,
    invocation.args,
    releaseProcessOptions({ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  );
  if (result.error || result.status !== 0) {
    // The signer intentionally emits only bounded generic errors, but release tooling still does
    // not forward child output because future crypto libraries may include sensitive metadata.
    throw new Error(`component signer ${command} failed`);
  }
  return String(result.stdout ?? "").trim();
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return value;
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function distinctPaths(paths) {
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (samePath(paths[left], paths[right])) throw new Error("component signer paths must be distinct");
    }
  }
}

export function initializeComponentKey({ storePath, kid }, { runSigner = runComponentSigner } = {}) {
  absolutePath(storePath, "component key store");
  if (!KEY_ID.test(String(kid ?? ""))) throw new Error("component key id is invalid");
  return parseComponentPublicKey(runSigner("init", { "--kid": kid, "--store": storePath }));
}

export function componentPublicKey({ storePath }, { runSigner = runComponentSigner } = {}) {
  absolutePath(storePath, "component key store");
  return parseComponentPublicKey(runSigner("public-key", { "--store": storePath }));
}

export function componentKeyStatus({ storePath }, { runSigner = runComponentSigner } = {}) {
  absolutePath(storePath, "component key store");
  let value;
  try {
    value = JSON.parse(runSigner("status", { "--store": storePath }));
  } catch {
    throw new Error("component signer status is invalid");
  }
  exactKeys(value, ["configured", "kid"], "component signer status");
  if (
    typeof value.configured !== "boolean" ||
    (value.configured && !KEY_ID.test(value.kid)) ||
    (!value.configured && value.kid !== null)
  ) {
    throw new Error("component signer status is invalid");
  }
  return value;
}

export function signComponentManifest(
  { storePath, inputPath, artifactPath, outputPath },
  { runSigner = runComponentSigner } = {},
) {
  const paths = [
    absolutePath(storePath, "component key store"),
    absolutePath(inputPath, "component manifest input"),
    absolutePath(artifactPath, "component artifact"),
    absolutePath(outputPath, "component manifest output"),
  ];
  distinctPaths(paths);
  runSigner("sign-manifest", {
    "--artifact": artifactPath,
    "--input": inputPath,
    "--output": outputPath,
    "--store": storePath,
  });
}

export function signComponentCatalog({ storePath, inputPath, outputPath }, { runSigner = runComponentSigner } = {}) {
  const paths = [
    absolutePath(storePath, "component key store"),
    absolutePath(inputPath, "component catalog input"),
    absolutePath(outputPath, "component catalog output"),
  ];
  distinctPaths(paths);
  runSigner("sign-catalog", { "--input": inputPath, "--output": outputPath, "--store": storePath });
}

export function verifyComponentManifest(
  { publicKeyPath, tokenPath, artifactPath },
  { runSigner = runComponentSigner } = {},
) {
  const paths = [
    absolutePath(publicKeyPath, "component public key"),
    absolutePath(tokenPath, "component manifest token"),
    absolutePath(artifactPath, "component artifact"),
  ];
  distinctPaths(paths);
  runSigner("verify-manifest", {
    "--artifact": artifactPath,
    "--public-key-file": publicKeyPath,
    "--token": tokenPath,
  });
}

export function verifyComponentCatalog({ publicKeyPath, tokenPath }, { runSigner = runComponentSigner } = {}) {
  const paths = [
    absolutePath(publicKeyPath, "component public key"),
    absolutePath(tokenPath, "component catalog token"),
  ];
  distinctPaths(paths);
  runSigner("verify-catalog", { "--public-key-file": publicKeyPath, "--token": tokenPath });
}

export function assertExistingRegularFile(path, label, { exists = existsSync, stat = statSync } = {}) {
  absolutePath(path, label);
  if (!exists(path) || !stat(path).isFile()) throw new Error(`${label} must be an existing regular file`);
  return path;
}
