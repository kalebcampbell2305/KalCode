import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { sha256File } from "./lib.mjs";
import {
  acceptedNotaryInfo,
  acceptedNotaryLog,
  MacReleaseError,
  notaryInfoArgs,
  notaryLogArgs,
  validateMacCandidateRecord,
  validateMacNotaryProfile,
} from "./macos-contract.mjs";
import { macProcessRunner, verifyMacCandidate, verifyMacRelease } from "./macos-verify-lib.mjs";

function fail(code, message) {
  throw new MacReleaseError(code, message);
}
function plain(path, directory = false) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    realpathSync(path) !== resolve(path)
  )
    fail(
      "unsafe_candidate_path",
      "Candidate and release paths must be ordinary files/directories without linked ancestors.",
    );
  return stat;
}
function readJson(path) {
  plain(path);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("invalid_checkpoint", "The candidate or notarization checkpoint is invalid JSON.");
  }
}
function writeNew(path, record) {
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600, flush: true });
}
function replaceJson(path, record) {
  // Same-directory rename gives interruption-safe checkpoint updates. The exclusive
  // invocation lock prevents two resumptions from submitting or stapling concurrently.
  const temporary = `${path}.${process.pid}.tmp`;
  writeNew(temporary, record);
  renameSync(temporary, path);
}
function writeEvidence(path, record) {
  if (!existsSync(path)) return writeNew(path, record);
  if (JSON.stringify(readJson(path)) !== JSON.stringify(record))
    fail("stale_release_output", "Existing release evidence does not match this verified candidate.");
}

export function macCandidateArtifactPath(candidatePath, record) {
  return join(dirname(resolve(candidatePath)), `macos-${record.arch}-candidate`, record.file);
}

/** A signed candidate is immutable. Apple works on those exact bytes; stapling
 * happens on a disposable copy, so an interrupted staple never corrupts resume.
 * The checkpoint contains no credentials, raw Apple logs, or signing material.
 */
export async function resumeMacCandidate({
  candidatePath,
  expected,
  notaryProfile,
  runner = macProcessRunner,
  hashFile = sha256File,
  verifyCandidate = verifyMacCandidate,
  verifyRelease = verifyMacRelease,
}) {
  candidatePath = resolve(candidatePath);
  const outDir = dirname(candidatePath);
  plain(outDir, true);
  const candidate = readJson(candidatePath);
  const artifactPath = macCandidateArtifactPath(candidatePath, candidate);
  validateMacCandidateRecord(candidate, artifactPath);
  for (const key of ["commit", "version", "arch", "requestedReleaseChannel", "teamId"]) {
    if (candidate[key] !== expected[key])
      fail(
        "candidate_context_mismatch",
        "The candidate does not match the current source, channel, architecture or Apple team.",
      );
  }
  validateMacNotaryProfile(notaryProfile);
  if (plain(artifactPath).size !== candidate.size || (await hashFile(artifactPath)) !== candidate.sha256)
    fail("candidate_digest_mismatch", "The signed candidate digest does not match its record.");
  const binding = {
    candidateSha256: candidate.sha256,
    candidateRecordSha256: createHash("sha256").update(readFileSync(candidatePath)).digest("hex"),
  };
  const prefix = join(outDir, `macos-${candidate.arch}`);
  const checkpointPath = `${prefix}-notary.json`;
  const lock = `${prefix}-notary.lock`;
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    fail(
      "notary_locked",
      "A notary resume lock exists. Confirm no packaging process is running before removing this lock directory.",
    );
  }
  let workspace;
  try {
    // This repeats signature, entitlement, architecture, helper digest and actual
    // executable --build-info checks even when a prior Apple job is being reused.
    await verifyCandidate({ artifactPath, record: candidate, expectedTeamId: expected.teamId, runner, hashFile });
    let checkpoint;
    if (existsSync(checkpointPath)) {
      checkpoint = readJson(checkpointPath);
      if (
        checkpoint.schemaVersion !== 1 ||
        checkpoint.candidateSha256 !== binding.candidateSha256 ||
        checkpoint.candidateRecordSha256 !== binding.candidateRecordSha256
      )
        fail("checkpoint_mismatch", "The notarization checkpoint belongs to a different candidate.");
      if (!checkpoint.submissionId)
        fail(
          "ambiguous_submission",
          "The previous Apple submission is ambiguous; reconcile its job ID before resuming. Do not silently resubmit.",
        );
      notaryInfoArgs(checkpoint.submissionId, notaryProfile); // Validate the persisted UUID.
    } else {
      checkpoint = { schemaVersion: 1, ...binding, submissionStarted: true };
      writeNew(checkpointPath, checkpoint);
      // No --wait: persist Apple's job ID immediately, then wait separately.
      const response = runner.capture(
        "xcrun",
        ["notarytool", "submit", artifactPath, "--keychain-profile", notaryProfile, "--output-format", "json"],
        { timeout: 3_600_000 },
      );
      let submission;
      try {
        submission = JSON.parse(response);
      } catch {
        fail("invalid_submission", "Apple submission did not return a job ID.");
      }
      notaryInfoArgs(submission?.id, notaryProfile);
      checkpoint.submissionId = submission.id;
      replaceJson(checkpointPath, checkpoint);
    }
    const id = checkpoint.submissionId;
    acceptedNotaryInfo(
      runner.capture(
        "xcrun",
        ["notarytool", "wait", id, "--keychain-profile", notaryProfile, "--timeout", "1h", "--output-format", "json"],
        { timeout: 3_660_000 },
      ),
      id,
    );
    acceptedNotaryLog(runner.capture("xcrun", notaryLogArgs(id, notaryProfile)), id);
    const finalArtifact = join(outDir, candidate.file);
    let record;
    let verifiedArtifact;
    if (existsSync(finalArtifact)) {
      // Recover a crash between final artifact promotion and evidence writes.
      // An unowned/unknown existing DMG is never overwritten or trusted.
      if (!checkpoint.verifiedRecord) fail("stale_release_output", "An unrelated final DMG already exists.");
      record = checkpoint.verifiedRecord;
      for (const key of [
        "commit",
        "version",
        "arch",
        "file",
        "helpers",
        "compiledChannelVerification",
        "requestedReleaseChannel",
        "compiledChannel",
      ])
        if (JSON.stringify(record[key]) !== JSON.stringify(candidate[key]))
          fail("checkpoint_mismatch", "The verified checkpoint no longer matches the candidate.");
      if (record.notarySubmissionId !== id || record.submittedSha256 !== candidate.sha256)
        fail("checkpoint_mismatch", "The verified checkpoint has a different Apple job or submitted digest.");
      plain(finalArtifact);
      verifiedArtifact = finalArtifact;
    } else {
      workspace = mkdtempSync(join(outDir, `macos-${candidate.arch}-staple-`));
      verifiedArtifact = join(workspace, candidate.file);
      copyFileSync(artifactPath, verifiedArtifact, constants.COPYFILE_EXCL);
      runner.run("xcrun", ["stapler", "staple", verifiedArtifact]);
      const { kind: _kind, ...base } = candidate;
      record = {
        ...base,
        size: statSync(verifiedArtifact).size,
        sha256: await hashFile(verifiedArtifact),
        submittedSha256: candidate.sha256,
        notarySubmissionId: id,
        notarized: true,
        stapled: true,
        releaseDescriptorEligible: true,
        releaseDescriptorBlockedReason: null,
      };
    }
    const report = await verifyRelease({
      artifactPath: verifiedArtifact,
      record,
      expectedTeamId: expected.teamId,
      notaryProfile,
      runner,
      hashFile,
    });
    if (report?.status !== "passed") fail("verification_failed", "Final macOS verification did not pass.");
    checkpoint.verifiedRecord = record;
    replaceJson(checkpointPath, checkpoint);
    if (verifiedArtifact !== finalArtifact) linkSync(verifiedArtifact, finalArtifact);
    writeEvidence(`${prefix}-build.json`, record);
    writeEvidence(`${prefix}-verify.json`, report);
    return { record, report, artifactPath: finalArtifact };
  } finally {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    rmdirSync(lock); // Never remove a stale lock owned by an earlier invocation.
  }
}
