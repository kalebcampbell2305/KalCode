#!/usr/bin/env node
// Notarizes an already signed ZIP; never rebuilds or re-signs its code.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadComponentContract } from "./component-contract.mjs";
import {
  validateMacRuntimeCandidateEvidence,
  validateMacRuntimePublicationEvidence,
  verifyMacRuntimeDirectory,
} from "./component-curate-macos.mjs";
import { sha256File } from "./lib.mjs";
import {
  acceptedNotaryInfo,
  acceptedNotaryLog,
  notaryInfoArgs,
  notaryLogArgs,
  validateMacNotaryProfile,
} from "./macos-contract.mjs";
import { macProcessRunner } from "./macos-verify-lib.mjs";

function jsonNew(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600, flush: true });
}
function jsonReplace(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  jsonNew(temp, value);
  renameSync(temp, path);
}
function plain(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path))
    throw Error("Mac notarization inputs must be ordinary files without linked ancestors");
  return stat;
}
function captureBytes(command, args) {
  const result = spawnSync(command, args, { timeout: 60_000, maxBuffer: 128 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw Error("Mac runtime ZIP extraction verification failed");
  return result.stdout;
}
export async function notarizeMacRuntime(
  { artifactPath, recordPath, notaryProfile },
  { runner = macProcessRunner, extractBytes = captureBytes } = {},
) {
  notaryProfile = validateMacNotaryProfile(notaryProfile);
  artifactPath = resolve(artifactPath);
  recordPath = resolve(recordPath);
  plain(recordPath);
  const contract = loadComponentContract(new URL("./components/kalvoice-local-reasoning-v1.json", import.meta.url));
  const policy = contract.runtime.macosAarch64;
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  if (
    plain(artifactPath).size !== record.artifact?.size ||
    (await sha256File(artifactPath)) !== record.artifact?.sha256
  )
    throw Error("Mac runtime artifact digest does not match curation evidence");
  const expectedArtifact = {
    componentId: contract.runtime.componentId,
    kind: contract.runtime.kind,
    version: contract.runtime.version,
    runtimeAbi: contract.runtime.runtimeAbi,
    file: policy.artifactFile,
    sizeBytes: record.artifact.size,
    sha256: record.artifact.sha256,
    licenses: record.licenses,
    provenance: {
      sourceId: policy.source.id,
      sourceRevision: policy.source.revision,
      sourceIntegritySha256: policy.source.sha256,
      buildRecipeSha256: record.recipeSha256,
    },
  };
  if (
    record.componentId !== contract.runtime.componentId ||
    record.version !== contract.runtime.version ||
    record.runtimeAbi !== contract.runtime.runtimeAbi ||
    record.platform !== "macos" ||
    record.arch !== "aarch64"
  )
    throw Error("Mac runtime curation identity mismatch");
  const catalog = { platform: "macos", arch: "aarch64", issuedAt: Math.floor(Date.now() / 1000) };
  if (record.releaseEligible === true)
    validateMacRuntimePublicationEvidence(record, expectedArtifact, catalog, contract);
  else validateMacRuntimeCandidateEvidence(record, expectedArtifact, catalog, contract);
  const { notarization: _notary, releaseEligible: _eligible, ...boundRecord } = record;
  const binding = createHash("sha256").update(JSON.stringify(boundRecord)).digest("hex");
  const checkpointPath = `${recordPath}.notary.json`;
  const lock = `${recordPath}.notary.lock`;
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw Error("Mac runtime notarization lock exists; inspect the owning process before removing a stale lock");
  }
  let staging;
  try {
    const names = runner.capture("/usr/bin/unzip", ["-Z", "-1", artifactPath]).split(/\r?\n/).filter(Boolean).sort();
    if (JSON.stringify(names) !== JSON.stringify([...policy.extractEntries].sort()))
      throw Error("Mac runtime ZIP inventory differs from the consumer closure");
    staging = mkdtempSync(join(dirname(artifactPath), ".mac-runtime-notary-"));
    for (const name of policy.extractEntries) {
      const bytes = extractBytes("/usr/bin/unzip", ["-p", artifactPath, name]);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const expected =
        name === "LICENSE"
          ? policy.licenses[0].noticeSha256
          : record.members?.find((member) => member.file === name)?.sha256;
      if (hash !== expected) throw Error("Mac runtime ZIP member digest does not match signed curation evidence");
      writeFileSync(join(staging, name), bytes, { flag: "wx", mode: name === "LICENSE" ? 0o644 : 0o755 });
    }
    verifyMacRuntimeDirectory(staging, { runner });
    let checkpoint;
    if (existsSync(checkpointPath)) {
      plain(checkpointPath);
      checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
      if (checkpoint.binding !== binding || checkpoint.artifactSha256 !== record.artifact.sha256)
        throw Error("Mac runtime notary checkpoint belongs to different bytes or curation evidence");
      if (!checkpoint.id)
        throw Error("Mac runtime submission is ambiguous; reconcile the original Apple job before retrying");
      notaryInfoArgs(checkpoint.id, notaryProfile);
    } else {
      checkpoint = { schemaVersion: 1, binding, artifactSha256: record.artifact.sha256 };
      jsonNew(checkpointPath, checkpoint);
      const response = JSON.parse(
        runner.capture(
          "xcrun",
          ["notarytool", "submit", artifactPath, "--keychain-profile", notaryProfile, "--output-format", "json"],
          { timeout: 3_600_000 },
        ),
      );
      notaryInfoArgs(response.id, notaryProfile);
      checkpoint.id = response.id;
      jsonReplace(checkpointPath, checkpoint);
    }
    const id = checkpoint.id;
    acceptedNotaryInfo(
      runner.capture(
        "xcrun",
        ["notarytool", "wait", id, "--keychain-profile", notaryProfile, "--timeout", "1h", "--output-format", "json"],
        { timeout: 3_660_000 },
      ),
      id,
    );
    const log = runner.capture("xcrun", notaryLogArgs(id, notaryProfile));
    acceptedNotaryLog(log, id);
    if (JSON.parse(log).sha256 !== record.artifact.sha256)
      throw Error("Apple notary log does not bind the exact runtime ZIP digest");
    // Apple does not support stapling bare command-line tools or dylibs. Verify
    // the system's notarized requirement on every signed member instead.
    verifyMacRuntimeDirectory(staging, { runner, requireNotarized: true });
    const verified = {
      ...record,
      notarization: {
        status: "accepted",
        submissionId: id,
        artifactSha256: record.artifact.sha256,
        logIssueFree: true,
        allCodeNotarized: true,
      },
      releaseEligible: true,
    };
    validateMacRuntimePublicationEvidence(
      verified,
      expectedArtifact,
      { platform: "macos", arch: "aarch64", issuedAt: Math.floor(Date.now() / 1000) },
      contract,
    );
    jsonReplace(recordPath, verified);
    return verified;
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    rmdirSync(lock);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    if (process.platform !== "darwin") throw Error("Mac runtime notarization requires macOS");
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--artifact" || args[2] !== "--record")
      throw Error("usage: component-notarize-macos --artifact PATH --record PATH");
    await notarizeMacRuntime({
      artifactPath: args[1],
      recordPath: args[3],
      notaryProfile: process.env.KALCODE_NOTARY_KEYCHAIN_PROFILE,
    });
    console.log("Exact Mac runtime ZIP notarization and every Mach-O requirement verified. Nothing published.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
