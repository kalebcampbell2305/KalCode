#!/usr/bin/env node
// Stages immutable, unlisted Stable descriptors for genuine lower-version updater QA. This tool
// can claim version rows, but it has no channel-pointer or mutable-object write capability.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPointerReadStatement,
  buildQaVersionClaimStatement,
  buildVersionReadStatement,
  exactPublicationRowProblems,
  parseD1Rows,
  semverPrecedenceKey,
} from "./publication-safety.mjs";
import { isMissingR2Object } from "./publish-plan.mjs";
import { releaseProcessOptions } from "./signing.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[1-9]\d*)?$/;
const SOURCE_FILES = Object.freeze([
  "Cargo.lock",
  "Cargo.toml",
  "apps/desktop/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
  "crates/updater/src/lib.rs",
]);
const MUTABLE_KEYS = new Set(["releases/latest.json", "releases/updater/stable.json"]);
const D1_DATABASE = "kalcode-web";
const R2_BUCKET = "kalcode-releases";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonDocument(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function exactReplacement(source, from, to) {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + from.length) >= 0) return null;
  return source.slice(0, first) + to + source.slice(first + from.length);
}

function parsePackageBlocks(lock) {
  const prefix = lock.match(/^[\s\S]*?(?=\[\[package\]\])/u)?.[0] ?? "";
  const blocks = lock.slice(prefix.length).split(/(?=\[\[package\]\])/u);
  return { prefix, blocks };
}

function mechanicalLockfile(candidate, workspacePackages, candidateVersion, baselineVersion) {
  const names = new Set(workspacePackages);
  const { prefix, blocks } = parsePackageBlocks(candidate);
  let changed = 0;
  const next = blocks.map((block) => {
    const name = /^name = "([^"]+)"$/mu.exec(block)?.[1];
    if (!name || !names.has(name)) return block;
    const from = `version = "${candidateVersion}"`;
    const replacement = exactReplacement(block, from, `version = "${baselineVersion}"`);
    if (replacement === null) return block;
    changed += 1;
    return replacement;
  });
  return { text: `${prefix}${next.join("")}`, changed };
}

function jsonVersionOnly(candidateText, baselineText, candidateVersion, baselineVersion, label) {
  let candidate;
  let baseline;
  try {
    candidate = JSON.parse(candidateText);
    baseline = JSON.parse(baselineText);
  } catch {
    return [`${label} is not valid JSON`];
  }
  if (candidate.version !== candidateVersion || baseline.version !== baselineVersion) {
    return [`${label} does not declare the exact candidate and baseline versions`];
  }
  const expected = structuredClone(candidate);
  expected.version = baselineVersion;
  return canonicalJson(expected) === canonicalJson(baseline) ? [] : [`${label} changed beyond its version declaration`];
}

/** Pure source policy used both by the Git-backed CLI and adversarial unit tests. */
export function validateBaselineSourceSnapshot(snapshot) {
  const problems = [];
  const { candidateFiles, baselineFiles, candidateVersion, baselineVersion, workspacePackages } = snapshot ?? {};
  if (!VERSION.test(candidateVersion ?? "") || !VERSION.test(baselineVersion ?? "")) {
    return ["baseline source versions are invalid"];
  }
  try {
    if (semverPrecedenceKey(baselineVersion) >= semverPrecedenceKey(candidateVersion)) {
      problems.push("QA baseline version must be lower than the candidate");
    }
  } catch {
    problems.push("baseline source versions are invalid");
  }
  if (
    !candidateFiles ||
    !baselineFiles ||
    JSON.stringify(Object.keys(candidateFiles).sort()) !== JSON.stringify([...SOURCE_FILES].sort()) ||
    JSON.stringify(Object.keys(baselineFiles).sort()) !== JSON.stringify([...SOURCE_FILES].sort())
  ) {
    return [...problems, "baseline source snapshot must contain exactly the five canonical authorities"];
  }
  const changedFiles = snapshot.changedFiles ?? SOURCE_FILES;
  if (JSON.stringify([...changedFiles].sort()) !== JSON.stringify([...SOURCE_FILES].sort())) {
    problems.push("baseline source diff contains a file outside the exact QA whitelist");
  }
  const cargoExpected = exactReplacement(
    candidateFiles["Cargo.toml"],
    `version = "${candidateVersion}"`,
    `version = "${baselineVersion}"`,
  );
  if (cargoExpected === null || cargoExpected !== baselineFiles["Cargo.toml"]) {
    problems.push("workspace package version change is not exact");
  }
  problems.push(
    ...jsonVersionOnly(
      candidateFiles["apps/desktop/package.json"],
      baselineFiles["apps/desktop/package.json"],
      candidateVersion,
      baselineVersion,
      "desktop package manifest",
    ),
    ...jsonVersionOnly(
      candidateFiles["apps/desktop/src-tauri/tauri.conf.json"],
      baselineFiles["apps/desktop/src-tauri/tauri.conf.json"],
      candidateVersion,
      baselineVersion,
      "Tauri configuration",
    ),
  );
  if (!Array.isArray(workspacePackages) || workspacePackages.length === 0) {
    problems.push("workspace package names are unavailable for Cargo.lock validation");
  } else {
    const expectedLock = mechanicalLockfile(
      candidateFiles["Cargo.lock"],
      workspacePackages,
      candidateVersion,
      baselineVersion,
    );
    if (expectedLock.changed === 0 || expectedLock.text !== baselineFiles["Cargo.lock"]) {
      problems.push("Cargo.lock has changes beyond mechanical workspace package versions");
    }
  }
  const candidateEndpoint = `Self::Stable => "https://kalcoded.com/releases/updater/stable.json"`;
  const baselineEndpoint = `Self::Stable => "https://kalcoded.com/releases/updater/stable/${candidateVersion}.json"`;
  const expectedUpdater = exactReplacement(
    candidateFiles["crates/updater/src/lib.rs"],
    candidateEndpoint,
    baselineEndpoint,
  );
  if (expectedUpdater === null || expectedUpdater !== baselineFiles["crates/updater/src/lib.rs"]) {
    problems.push("baseline updater source does not pin only Stable to the exact candidate version descriptor");
  }
  return problems;
}

function flagValue(args, name) {
  const positions = args.flatMap((value, index) => (value === name ? [index] : []));
  if (positions.length !== 1) throw new Error(`${name} must be specified exactly once`);
  const value = args[positions[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

export function parseQaStageArguments(args) {
  const valueFlags = [
    "--baseline-source",
    "--baseline-staging",
    "--candidate-source",
    "--candidate-staging",
    "--receipt",
    "--approved-tool-commit",
  ];
  const allowed = new Set([...valueFlags, "--dry-run", "--remote"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!allowed.has(arg)) throw new Error(`unknown updater QA stage option: ${arg}`);
    if (valueFlags.includes(arg)) index += 1;
  }
  const modes = ["--dry-run", "--remote"].filter((mode) => args.includes(mode));
  if (modes.length === 0) throw new Error("updater QA staging requires an explicit --dry-run or --remote mode");
  if (modes.length > 1) throw new Error("updater QA staging modes are mutually exclusive");
  const parsed = {
    mode: modes[0].slice(2),
    baselineSource: flagValue(args, "--baseline-source"),
    baselineStaging: flagValue(args, "--baseline-staging"),
    candidateSource: flagValue(args, "--candidate-source"),
    candidateStaging: flagValue(args, "--candidate-staging"),
    receiptPath: flagValue(args, "--receipt"),
  };
  if (args.includes("--approved-tool-commit")) {
    parsed.approvedToolCommit = flagValue(args, "--approved-tool-commit");
    if (!COMMIT.test(parsed.approvedToolCommit))
      throw new Error("approved tool commit must be a full lowercase commit SHA");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "mode" && key !== "approvedToolCommit" && !isAbsolute(value))
      throw new Error(`${key} must be an absolute path`);
  }
  const unique = new Set(
    [
      parsed.baselineSource,
      parsed.baselineStaging,
      parsed.candidateSource,
      parsed.candidateStaging,
      parsed.receiptPath,
    ].map((value) => resolve(value).toLowerCase()),
  );
  if (unique.size !== 5) throw new Error("updater QA source, staging, and receipt paths must be distinct");
  return parsed;
}

function receiptRelease(release) {
  return {
    version: release.version,
    commit: release.commit,
    publication: release.candidate,
    objects: release.objects
      .map((object) => ({ key: object.key, sha256: object.sha256, size: object.size ?? object.bytes?.length }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  };
}

function assertSourceAuthority(authority, candidate) {
  const exactKeys = (value, keys) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
  if (
    !exactKeys(authority, ["toolCommit", "productCommit", "candidateNotesCommit", "baselineQaSha256"]) ||
    ![authority.toolCommit, authority.productCommit, authority.candidateNotesCommit].every(
      (commit) => typeof commit === "string" && COMMIT.test(commit),
    ) ||
    authority.productCommit !== candidate.commit ||
    !exactKeys(authority.baselineQaSha256, ["windows-x86_64", "darwin-aarch64"]) ||
    !Object.values(authority.baselineQaSha256).every(
      (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest),
    )
  )
    throw new Error("tool source authority is incomplete or does not match the candidate");
}

export function createQaStageReceipt({
  baseline,
  candidate,
  pointerRows,
  sourceAuthority,
  createdAt = new Date().toISOString(),
}) {
  if (sourceAuthority !== undefined) assertSourceAuthority(sourceAuthority, candidate);
  const identity = {
    schemaVersion: sourceAuthority === undefined ? 1 : 2,
    channel: "stable",
    ...(sourceAuthority !== undefined && { sourceAuthority: structuredClone(sourceAuthority) }),
    baseline: receiptRelease(baseline),
    candidate: receiptRelease(candidate),
    pointerRows,
  };
  return { ...identity, planSha256: sha256Bytes(canonicalJson(identity)), createdAt };
}

function receiptProblems(receipt, baseline, candidate, pointerRows, sourceAuthority) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return ["durable receipt is missing"];
  const expected = createQaStageReceipt({
    baseline,
    candidate,
    pointerRows,
    sourceAuthority,
    createdAt: receipt.createdAt,
  });
  return canonicalJson(receipt) === canonicalJson(expected)
    ? []
    : ["durable receipt does not match the exact QA stage plan"];
}

/** Writes the plan authority once; subsequent runs may only reuse byte-identical receipt data. */
export function writeQaStageReceipt(path, receipt) {
  const bytes = jsonDocument(receipt);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== bytes)
      throw new Error("existing QA stage receipt does not match the exact plan");
    return "reused";
  }
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, bytes, "utf8");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return "created";
}

function pointerRowsEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function objectResult(result) {
  if (result === null || result === undefined) return null;
  if (Buffer.isBuffer(result) || result instanceof Uint8Array) {
    const bytes = Buffer.from(result);
    return { sha256: sha256Bytes(bytes), size: bytes.length };
  }
  if (SHA256.test(result.sha256 ?? "") && Number.isSafeInteger(result.size) && result.size >= 0) return result;
  throw new Error("remote immutable object probe returned invalid evidence");
}

function qaObjectKeyIsCanonical(key, sha256) {
  if (typeof key !== "string" || MUTABLE_KEYS.has(key) || !SHA256.test(sha256 ?? "")) return false;
  const parts = key.split("/");
  const versionIndex = parts[1] === "updater" ? 3 : 1;
  const canonicalPrefix =
    versionIndex === 3
      ? parts[0] === "releases" && parts[1] === "updater" && parts[2] === "stable"
      : parts[0] === "releases";
  const version = parts[versionIndex];
  const suffix = parts.slice(versionIndex + 1);
  const safeFile = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
  const descriptor = suffix.length === 1 && suffix[0] === `${sha256}.json`;
  const artifact = suffix.length === 2 && suffix[0] === sha256 && safeFile.test(suffix[1]);
  const signature =
    versionIndex === 3 &&
    suffix.length === 3 &&
    SHA256.test(suffix[0]) &&
    suffix[1] === sha256 &&
    safeFile.test(suffix[2]) &&
    suffix[2].endsWith(".sig");
  return canonicalPrefix && VERSION.test(version ?? "") && (descriptor || artifact || signature);
}

function assertRelease(release, label) {
  if (!VERSION.test(release?.version ?? "") || !COMMIT.test(release?.commit ?? "")) {
    throw new Error(`${label} release identity is invalid`);
  }
  if (release.candidate?.channel !== "stable" || release.candidate?.version !== release.version) {
    throw new Error(`${label} immutable publication identity is invalid`);
  }
  if (!Array.isArray(release.objects) || release.objects.length === 0)
    throw new Error(`${label} has no immutable objects`);
  const keys = new Set();
  for (const object of release.objects) {
    const allowedObjectKeys = new Set(["bytes", "key", "path", "sha256", "size"]);
    if (
      !object ||
      typeof object !== "object" ||
      Array.isArray(object) ||
      Object.keys(object).some((key) => !allowedObjectKeys.has(key)) ||
      !qaObjectKeyIsCanonical(object.key, object.sha256) ||
      keys.has(object.key) ||
      (!object.key.startsWith(`releases/${release.version}/`) &&
        !object.key.startsWith(`releases/updater/stable/${release.version}/`)) ||
      !Number.isSafeInteger(object.size ?? object.bytes?.length) ||
      (object.size ?? object.bytes?.length) <= 0
    ) {
      throw new Error(`${label} immutable object plan is invalid`);
    }
    keys.add(object.key);
  }
  const descriptors = [release.candidate.updaterDescriptorKey, release.candidate.downloadDescriptorKey];
  if (descriptors.some((key) => !keys.has(key))) throw new Error(`${label} immutable descriptor plan is incomplete`);
}

/** Builds the entire Wrangler mutation command from validated authority, never caller argv. */
export function canonicalQaObjectPutArguments(object) {
  const allowedObjectKeys = new Set(["bytes", "key", "path", "sha256", "size"]);
  if (
    !object ||
    typeof object !== "object" ||
    Array.isArray(object) ||
    Object.keys(object).some((key) => !allowedObjectKeys.has(key)) ||
    !qaObjectKeyIsCanonical(object.key, object.sha256) ||
    typeof object.path !== "string" ||
    !isAbsolute(object.path)
  ) {
    throw new Error("updater QA immutable upload path is invalid");
  }
  let contentType;
  if (object.key.endsWith(".json")) contentType = "application/json; charset=utf-8";
  else if (object.key.endsWith(".sig")) {
    contentType = "text/plain; charset=utf-8";
  } else if (object.key.endsWith(".exe")) contentType = "application/vnd.microsoft.portable-executable";
  else if (object.key.endsWith(".dmg")) contentType = "application/x-apple-diskimage";
  else throw new Error("updater QA immutable upload type is invalid");
  const args = [
    "r2",
    "object",
    "put",
    `${R2_BUCKET}/${object.key}`,
    "--file",
    object.path,
    "--content-type",
    contentType,
  ];
  if (/^releases\/[^/]+\/[0-9a-f]{64}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:exe|dmg)$/u.test(object.key)) {
    args.push("--content-disposition", `attachment; filename="${object.key.split("/").at(-1)}"`);
  }
  args.push("--cache-control", IMMUTABLE_CACHE_CONTROL);
  return args;
}

/**
 * Linearizes only immutable object uploads and immutable version-row claims. `remote` intentionally
 * has no pointer-write method, and the Stable pointer is compared before every claim and afterward.
 */
export async function runQaStagePublication({ baseline, candidate, receipt, remote, sourceAuthority }) {
  assertRelease(baseline, "baseline");
  assertRelease(candidate, "candidate");
  if (semverPrecedenceKey(baseline.version) >= semverPrecedenceKey(candidate.version)) {
    throw new Error("QA baseline must be lower than the candidate");
  }
  if (!receipt) throw new Error("a durable receipt is required before updater QA stage writes");
  const pointerRows = await preflightQaStagePublication({ baseline, candidate, receipt, remote, sourceAuthority });

  for (const release of [baseline, candidate]) {
    for (const object of release.objects) {
      if (objectResult(await remote.readObject(object.key)) === null) await remote.putObject(object);
      const readback = objectResult(await remote.readObject(object.key));
      if (readback?.sha256 !== object.sha256 || readback.size !== (object.size ?? object.bytes.length)) {
        throw new Error(`${object.key} did not read back with exact immutable bytes`);
      }
    }
  }

  for (const release of [baseline, candidate]) {
    if (!pointerRowsEqual(await remote.readPointer(), pointerRows)) {
      throw new Error("Stable pointer changed during updater QA staging");
    }
    const value = { ...release.candidate, precedenceKey: semverPrecedenceKey(release.version) };
    const claimed = await remote.claimVersion(value, pointerRows[0] ?? null);
    let rows = claimed;
    if (!Array.isArray(rows) || rows.length === 0) rows = await remote.readVersion("stable", release.version);
    if (rows.length !== 1 || exactPublicationRowProblems(rows[0], release.candidate).length > 0) {
      throw new Error(`${release.version} immutable version row did not read back exactly`);
    }
    const publicDescriptor = objectResult(await remote.readPublicVersion(release.candidate));
    const expectedDescriptor = release.objects.find((object) => object.key === release.candidate.updaterDescriptorKey);
    if (
      !expectedDescriptor ||
      publicDescriptor?.sha256 !== expectedDescriptor.sha256 ||
      publicDescriptor.size !== (expectedDescriptor.size ?? expectedDescriptor.bytes.length)
    ) {
      throw new Error(`${release.version} public immutable version URL did not read back exactly`);
    }
  }
  const pointerAfter = await remote.readPointer();
  if (!pointerRowsEqual(pointerAfter, pointerRows)) throw new Error("Stable pointer changed during updater QA staging");
  return { pointerRows: pointerAfter, versions: [baseline.version, candidate.version] };
}

/** Read-only collision/pointer preflight. A missing receipt requires every planned key and row to be unused. */
export async function preflightQaStagePublication({ baseline, candidate, receipt, remote, sourceAuthority }) {
  assertRelease(baseline, "baseline");
  assertRelease(candidate, "candidate");
  if (sourceAuthority !== undefined) assertSourceAuthority(sourceAuthority, candidate);
  const pointerRows = await remote.readPointer();
  if (!Array.isArray(pointerRows) || pointerRows.length > 1) throw new Error("Stable pointer readback is invalid");
  if (pointerRows.length === 1) {
    const pointer = pointerRows[0];
    let precedence;
    try {
      precedence = semverPrecedenceKey(pointer?.version);
    } catch {
      throw new Error("Stable pointer readback is invalid");
    }
    if (
      pointer?.channel !== "stable" ||
      pointer?.precedence_key !== precedence ||
      precedence >= semverPrecedenceKey(baseline.version)
    ) {
      throw new Error("Stable pointer is not an exact older release than the private QA baseline");
    }
  }
  // Validate the entire joined pointer/version authority before any object write. The same exact
  // snapshot is embedded into each later version-claim statement to close the preflight gap.
  buildQaVersionClaimStatement(baseline.candidate, pointerRows[0] ?? null);
  const receiptErrors = receipt ? receiptProblems(receipt, baseline, candidate, pointerRows, sourceAuthority) : [];
  if (receiptErrors.length > 0) throw new Error(receiptErrors.join("; "));

  for (const release of [baseline, candidate]) {
    const rows = await remote.readVersion("stable", release.version);
    if (!Array.isArray(rows) || rows.length > 1)
      throw new Error(`${release.version} immutable version readback is invalid`);
    if (rows.length > 0) {
      if (!receipt) throw new Error("an existing immutable version requires the exact durable receipt");
      const problems = exactPublicationRowProblems(rows[0], release.candidate);
      if (problems.length > 0) throw new Error(problems.join("; "));
    }
    for (const object of release.objects) {
      const existing = objectResult(await remote.readObject(object.key));
      if (existing) {
        if (!receipt) throw new Error("an existing immutable object requires the exact durable receipt");
        if (existing.sha256 !== object.sha256 || existing.size !== (object.size ?? object.bytes.length)) {
          throw new Error(`${object.key} exists with different bytes`);
        }
      }
    }
  }

  return pointerRows;
}

function execute(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
}

function createWranglerRemote(websiteDir) {
  const wrangler = join(websiteDir, "node_modules", "wrangler", "bin", "wrangler.js");
  const executeD1 = (statement) => {
    const result = execute(
      process.execPath,
      [wrangler, "d1", "execute", D1_DATABASE, "--remote", "--json", "--command", statement],
      releaseProcessOptions({ cwd: websiteDir, timeout: 30_000, maxBuffer: 256 * 1024 }),
    );
    if (result.status !== 0) throw new Error("updater QA D1 operation failed");
    return parseD1Rows(result.stdout);
  };
  const probeDir = mkdtempSync(join(tmpdir(), "kalcode-updater-qa-r2-"));
  return {
    dispose() {
      rmSync(probeDir, { recursive: true, force: true });
    },
    readPointer() {
      return executeD1(buildPointerReadStatement("stable"));
    },
    readVersion(channel, version) {
      return executeD1(buildVersionReadStatement(channel, version));
    },
    async readObject(key) {
      const path = join(probeDir, sha256Bytes(key));
      const result = execute(
        process.execPath,
        [wrangler, "r2", "object", "get", `${R2_BUCKET}/${key}`, "--file", path, "--remote"],
        releaseProcessOptions({ cwd: websiteDir, timeout: 120_000, maxBuffer: 128 * 1024 }),
      );
      if (result.status !== 0) {
        if (isMissingR2Object(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)) return null;
        throw new Error("updater QA immutable object probe failed");
      }
      try {
        return { sha256: await sha256File(path), size: statSync(path).size };
      } finally {
        unlinkSync(path);
      }
    },
    putObject(object) {
      const args = canonicalQaObjectPutArguments(object);
      const result = execute(
        process.execPath,
        [wrangler, ...args, "--remote"],
        releaseProcessOptions({ cwd: websiteDir, timeout: 30 * 60_000, maxBuffer: 128 * 1024 }),
      );
      if (result.status !== 0) throw new Error("updater QA immutable object upload failed");
    },
    claimVersion(candidate, expectedPointer) {
      return executeD1(buildQaVersionClaimStatement(candidate, expectedPointer));
    },
    async readPublicVersion(candidate) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(
          `https://kalcoded.com/releases/updater/stable/${candidate.version}.json?qa_stage=${candidate.updaterDescriptorSha256.slice(0, 16)}`,
          { redirect: "error", signal: controller.signal },
        );
        if (!response.ok || response.headers.get("x-kalcode-release-authority") !== "d1-v1") {
          throw new Error("public immutable version route is unavailable");
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 64 * 1024) throw new Error("public immutable version descriptor exceeds its limit");
        return { sha256: sha256Bytes(bytes), size: bytes.length };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function usageError() {
  return new Error(
    "usage: stage-updater-qa --baseline-source ABS --baseline-staging ABS --candidate-source ABS --candidate-staging ABS --receipt ABS [--approved-tool-commit FULL_SHA] (--dry-run|--remote)",
  );
}

// Packet assembly is intentionally imported lazily so unit tests exercise the authority-free core.
async function main() {
  let options;
  try {
    options = parseQaStageArguments(process.argv.slice(2));
  } catch (error) {
    throw error instanceof Error ? error : usageError();
  }
  const { assembleUpdaterQaStage } = await import("./updater-qa-stage-assembly.mjs");
  const bundle = await assembleUpdaterQaStage(options);
  if (options.mode === "dry-run") {
    console.log(
      `Verified updater QA stage ${bundle.baseline.version} -> ${bundle.candidate.version}; ${bundle.baseline.objects.length + bundle.candidate.objects.length} immutable objects planned. No external effect occurred.`,
    );
    return;
  }
  const remote = createWranglerRemote(join(options.candidateSource, "apps", "website"));
  try {
    let pointerRows = await remote.readPointer();
    let receipt;
    if (existsSync(options.receiptPath)) {
      receipt = JSON.parse(readFileSync(options.receiptPath, "utf8"));
      const problems = receiptProblems(receipt, bundle.baseline, bundle.candidate, pointerRows, bundle.sourceAuthority);
      if (problems.length > 0) throw new Error(problems.join("; "));
    } else {
      pointerRows = await preflightQaStagePublication({ ...bundle, receipt: null, remote });
      receipt = createQaStageReceipt({ ...bundle, pointerRows });
      writeQaStageReceipt(options.receiptPath, receipt);
    }
    await runQaStagePublication({ ...bundle, receipt, remote });
    console.log(
      `Staged immutable updater QA versions ${bundle.baseline.version} and ${bundle.candidate.version}; Stable pointer unchanged.`,
    );
  } finally {
    remote.dispose();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`updater QA stage: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
