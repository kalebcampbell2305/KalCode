import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseProcessOptions } from "../release/signing.mjs";

export const PROVIDER_COMPATIBILITY_TYPE = "kalcode-provider-compatibility.v1";
export const PROVIDER_COMPATIBILITY_ENDPOINT = "/providers/v1/compatibility/stable.jws";

const MAX_TOKEN_BYTES = 64 * 1024 + 1;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\n$/;
const COMMAND_OPTIONS = Object.freeze({
  "sign-provider-compatibility": Object.freeze(["--input", "--output", "--store"]),
  "verify-provider-compatibility": Object.freeze(["--public-key-file", "--token"]),
});

function repositoryRoot() {
  return resolve(import.meta.dirname, "..", "..");
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

function exactStringOptions(options, expected) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) return false;
  const names = Object.keys(options).sort();
  return (
    JSON.stringify(names) === JSON.stringify([...expected].sort()) &&
    names.every((name) => typeof options[name] === "string" && options[name].length > 0)
  );
}

export function providerSignerInvocation({ root, command, options }) {
  if (typeof root !== "string" || !isAbsolute(root)) throw new Error("provider signer root must be absolute");
  const expected = COMMAND_OPTIONS[command];
  if (!expected || !exactStringOptions(options, expected)) {
    throw new Error("provider signer options are invalid");
  }
  return {
    command: signerBinary(root),
    args: [
      command,
      ...Object.keys(options)
        .sort()
        .flatMap((name) => [name, options[name]]),
    ],
  };
}

export function runProviderSigner(
  command,
  options,
  { root = repositoryRoot(), spawn = spawnSync, exists = existsSync } = {},
) {
  const build = spawn(
    "cargo",
    ["build", "--locked", "--release", "--manifest-path", join(root, "tooling", "component-signer", "Cargo.toml")],
    {
      cwd: root,
      ...releaseProcessOptions({ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    },
  );
  if (build.error || build.status !== 0) throw new Error("provider compatibility signer could not be built");
  const invocation = providerSignerInvocation({ root, command, options });
  if (!exists(invocation.command)) throw new Error("provider compatibility signer binary is missing");
  const result = spawn(
    invocation.command,
    invocation.args,
    releaseProcessOptions({ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  );
  if (result.error || result.status !== 0) throw new Error(`provider compatibility signer ${command} failed`);
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

function requireDistinct(paths) {
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (samePath(paths[left], paths[right])) throw new Error("provider compatibility paths must be distinct");
    }
  }
}

export function signProviderCompatibility(
  { storePath, inputPath, outputPath },
  { runSigner = runProviderSigner } = {},
) {
  const paths = [
    absolutePath(storePath, "component key store"),
    absolutePath(inputPath, "provider compatibility input"),
    absolutePath(outputPath, "provider compatibility output"),
  ];
  requireDistinct(paths);
  runSigner("sign-provider-compatibility", {
    "--input": inputPath,
    "--output": outputPath,
    "--store": storePath,
  });
}

export function verifyProviderCompatibility({ publicKeyPath, tokenPath }, { runSigner = runProviderSigner } = {}) {
  const paths = [
    absolutePath(publicKeyPath, "component public key"),
    absolutePath(tokenPath, "provider compatibility token"),
  ];
  requireDistinct(paths);
  runSigner("verify-provider-compatibility", {
    "--public-key-file": publicKeyPath,
    "--token": tokenPath,
  });
}

function readCanonicalToken(path) {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    throw new Error("provider compatibility token must be a non-empty regular file");
  }
  if (metadata.size > MAX_TOKEN_BYTES) throw new Error("provider compatibility token exceeds its safety limit");
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== metadata.size || opened.size > MAX_TOKEN_BYTES) {
      throw new Error("provider compatibility token must be a stable regular file");
    }
    const bytes = readFileSync(descriptor);
    const text = bytes.toString("ascii");
    if (!bytes.equals(Buffer.from(text, "ascii")) || !COMPACT_JWS.test(text)) {
      throw new Error("provider compatibility token must be a canonical compact JWS");
    }
    // Signer artifacts end with one LF for filesystem ergonomics. The HTTP representation is the
    // compact JWS itself: publishing the LF would make strict base64url clients reject it.
    return bytes.subarray(0, bytes.length - 1);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function stageProviderCompatibility(
  { tokenPath },
  { root = repositoryRoot(), runSigner = runProviderSigner } = {},
) {
  absolutePath(root, "repository root");
  absolutePath(tokenPath, "provider compatibility token");
  const publicKeyPath = join(root, "tooling", "release", "component-public-key.json");
  const destination = join(root, "apps", "website", "public", "providers", "v1", "compatibility", "stable.jws");
  requireDistinct([tokenPath, publicKeyPath, destination]);
  const existing = lstatSync(destination, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error("provider compatibility destination must be a regular file");
  }
  const bytes = readCanonicalToken(tokenPath);
  const parent = join(root, "apps", "website", "public", "providers", "v1", "compatibility");
  mkdirSync(parent, { recursive: true });
  const temporary = join(parent, `.stable.${process.pid}.${randomBytes(8).toString("hex")}.jws.tmp`);
  let committed = false;
  try {
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    verifyProviderCompatibility({ publicKeyPath, tokenPath: temporary }, { runSigner });
    renameSync(temporary, destination);
    committed = true;
    syncDirectory(parent);
    return destination;
  } finally {
    if (!committed) rmSync(temporary, { force: true });
  }
}

function parseOptions(args, expected) {
  if (args.length !== expected.length * 2) throw new Error("provider compatibility options are invalid");
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!expected.includes(name) || name in options || typeof value !== "string" || value.startsWith("--")) {
      throw new Error("provider compatibility options are invalid");
    }
    options[name] = value;
  }
  return options;
}

function usage() {
  return "usage: node compatibility.mjs sign --store PATH --input PATH --output PATH | verify --public-key-file PATH --token PATH | stage --token PATH";
}

export function runCli(args) {
  const [command, ...tail] = args;
  if (command === "sign") {
    const options = parseOptions(tail, ["--store", "--input", "--output"]);
    signProviderCompatibility({
      storePath: options["--store"],
      inputPath: options["--input"],
      outputPath: options["--output"],
    });
    return;
  }
  if (command === "verify") {
    const options = parseOptions(tail, ["--public-key-file", "--token"]);
    verifyProviderCompatibility({ publicKeyPath: options["--public-key-file"], tokenPath: options["--token"] });
    return;
  }
  if (command === "stage") {
    const options = parseOptions(tail, ["--token"]);
    stageProviderCompatibility({ tokenPath: options["--token"] });
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`provider compatibility: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exitCode = 1;
  }
}
