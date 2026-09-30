import { createHash, createPublicKey, timingSafeEqual, verify as verifyBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { validateMacBuildRecord } from "./macos-contract.mjs";
import { semverPrecedenceKey } from "./publication-safety.mjs";
import { validateCompiledChannel } from "./release-channel.mjs";
import { publicSigningProblems, publicVerificationProblems, updaterSigningEvidenceIsExact } from "./signing.mjs";

const CHANNELS = new Set(["stable", "beta", "dev"]);
const MAX_UPDATE_BYTES = 512 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SIGNING_KEYS = [
  "appTimestamped",
  "applicationVerifiedDuringBundle",
  "provider",
  "publisherIdentityBound",
  "timestamped",
];
const MINISIGN_PUBLIC_KEY_BYTES = 42;
const MINISIGN_SIGNATURE_BYTES = 74;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const TARGET_FORMATS = Object.freeze({ "windows-x86_64": "nsis", "darwin-aarch64": "dmg" });
const QA_CHECKS = Object.freeze([
  "install",
  "cleanInstall",
  "launch",
  "auth",
  "providers",
  "accountIsolation",
  "kalvoice",
  "browser",
  "workspace",
  "sleepWake",
]);
const QA_SAFEGUARDS = Object.freeze([
  "authenticationBypassed",
  "cacheSeeded",
  "fixtureOnly",
  "testHooks",
  "tlsBypassed",
]);

function fail(message) {
  throw new Error(`updater manifest blocked: ${message}`);
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function releaseIdentityProblems(value, expected, label) {
  const problems = [];
  if (!exactKeys(value, ["commit", "sha256", "version"])) problems.push(`${label} identity has unexpected fields`);
  if (!VERSION.test(value?.version ?? "")) problems.push(`${label} version is invalid`);
  if (!COMMIT.test(value?.commit ?? "")) problems.push(`${label} commit is invalid`);
  if (!SHA256.test(value?.sha256 ?? "")) problems.push(`${label} SHA-256 is invalid`);
  if (
    expected &&
    (value?.version !== expected.version || value?.commit !== expected.commit || value?.sha256 !== expected.sha256)
  ) {
    problems.push(`${label} does not bind the exact release`);
  }
  return problems;
}

/**
 * Validates customer-device QA separately from package signing. Preliminary evidence is accepted
 * only by the unlisted updater-QA staging tool; the normal publisher requires the complete
 * lower-to-newer, rollback and re-update sequence.
 */
export function updaterQaProblems(record, expected, phase = "final") {
  const problems = [];
  if (
    !exactKeys(record, [
      "channel",
      "checks",
      "release",
      "safeguards",
      "schemaVersion",
      "status",
      "target",
      "updateTrial",
    ])
  ) {
    return ["updater QA record has unexpected fields"];
  }
  if (record.schemaVersion !== 2) problems.push("updater QA schema is unsupported");
  if (!Object.hasOwn(TARGET_FORMATS, record.target) || record.target !== expected?.target) {
    problems.push("updater QA target does not match the release");
  }
  if (!CHANNELS.has(record.channel) || record.channel !== expected?.channel) {
    problems.push("updater QA channel does not match the release");
  }
  problems.push(...releaseIdentityProblems(record.release, expected?.release, "updater QA release"));
  if (!exactKeys(record.checks, QA_CHECKS) || QA_CHECKS.some((key) => record.checks?.[key] !== true)) {
    problems.push("updater QA product checks are incomplete");
  }
  if (!exactKeys(record.safeguards, QA_SAFEGUARDS) || QA_SAFEGUARDS.some((key) => record.safeguards?.[key] !== false)) {
    problems.push("updater QA used a test hook, cache seed, bypass, or fixture-only proof");
  }
  if (phase === "preliminary") {
    if (record.channel !== "stable") problems.push("preliminary updater QA staging is Stable-only");
    if (record.status !== "preliminary-passed" || record.updateTrial !== null) {
      problems.push("preliminary updater QA must leave the real update trial pending");
    }
    return problems;
  }
  if (phase !== "final") return ["updater QA validation phase is invalid"];
  if (record.status !== "passed") problems.push("completed updater QA is required");
  const trial = record.updateTrial;
  if (!exactKeys(trial, ["baseline", "candidate", "method", "outcomes"])) {
    problems.push("completed updater QA trial is invalid");
    return problems;
  }
  const expectedMethod =
    record.channel === "stable" ? "public-unlisted-immutable-version-v1" : "signed-local-candidate-v1";
  if (trial.method !== expectedMethod) {
    problems.push("updater QA did not use the required exact signed candidate method");
  }
  problems.push(...releaseIdentityProblems(trial.baseline, null, "updater QA baseline"));
  problems.push(...releaseIdentityProblems(trial.candidate, expected?.release, "updater QA candidate"));
  try {
    if (semverPrecedenceKey(trial.baseline?.version) >= semverPrecedenceKey(trial.candidate?.version)) {
      problems.push("updater QA baseline is not lower than the candidate");
    }
  } catch {
    problems.push("updater QA trial versions are invalid");
  }
  const required = [
    ["update", trial.baseline, trial.candidate],
    ["rollback", trial.candidate, trial.baseline],
    ["reupdate", trial.baseline, trial.candidate],
  ];
  if (!Array.isArray(trial.outcomes) || trial.outcomes.length !== required.length) {
    problems.push("updater QA must prove update, rollback, and re-update exactly once");
  } else {
    for (let index = 0; index < required.length; index += 1) {
      const [step, from, to] = required[index];
      const outcome = trial.outcomes[index];
      if (!exactKeys(outcome, ["from", "passed", "step", "to"]) || outcome.step !== step || outcome.passed !== true) {
        problems.push(`updater QA ${step} outcome is incomplete`);
        continue;
      }
      problems.push(...releaseIdentityProblems(outcome.from, from, `updater QA ${step} source`));
      problems.push(...releaseIdentityProblems(outcome.to, to, `updater QA ${step} destination`));
    }
  }
  return problems;
}

function signingEvidenceIsExact(signing) {
  return (
    signing !== null &&
    typeof signing === "object" &&
    !Array.isArray(signing) &&
    JSON.stringify(Object.keys(signing).sort()) === JSON.stringify(SIGNING_KEYS) &&
    signing.provider === "azure-artifact-signing" &&
    signing.timestamped === true &&
    signing.appTimestamped === true &&
    signing.applicationVerifiedDuringBundle === true &&
    signing.publisherIdentityBound === true
  );
}

async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function requiredFile(path, label, maxBytes) {
  let info;
  try {
    info = await stat(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (!info.isFile() || info.size === 0) fail(`${label} is missing`);
  if (!Number.isSafeInteger(info.size) || info.size > maxBytes) fail(`${label} exceeds its safety limit`);
  return info;
}

function decodeCanonicalBase64(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /\s/.test(value)) {
    fail(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) fail(`${label} is not canonical base64`);
  return decoded;
}

function minisignLines(bytes, label, expected) {
  const lines = bytes.toString("utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== expected) fail(`${label} is not a Minisign document`);
  return lines;
}

function parsePublicKey(publicKeyBase64) {
  const lines = minisignLines(decodeCanonicalBase64(publicKeyBase64, "updater public key"), "updater public key", 2);
  if (!lines[0].startsWith("untrusted comment: minisign public key: ")) {
    fail("updater public key is not a Minisign public key");
  }
  const record = decodeCanonicalBase64(lines[1], "updater public key record");
  if (record.length !== MINISIGN_PUBLIC_KEY_BYTES || record.subarray(0, 2).toString("ascii") !== "Ed") {
    fail("updater public key is not a Minisign Ed25519 public key");
  }
  try {
    return {
      id: record.subarray(2, 10),
      key: createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, record.subarray(10)]),
        format: "der",
        type: "spki",
      }),
    };
  } catch {
    fail("updater public key is invalid");
  }
}

async function blake2bFile(path) {
  const digest = createHash("blake2b512");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest();
}

async function validateSignature(signatureBase64, publicKeyBase64, artifactPath, version, file, target, channel) {
  const lines = minisignLines(decodeCanonicalBase64(signatureBase64, "updater signature"), "updater signature", 4);
  if (!lines[0].startsWith("untrusted comment: ") || !lines[2].startsWith("trusted comment: ")) {
    fail("updater signature is not a Minisign signature");
  }
  const signatureRecord = decodeCanonicalBase64(lines[1], "updater signature record");
  const globalSignature = decodeCanonicalBase64(lines[3], "updater global signature");
  if (
    signatureRecord.length !== MINISIGN_SIGNATURE_BYTES ||
    signatureRecord.subarray(0, 2).toString("ascii") !== "ED" ||
    globalSignature.length !== 64
  ) {
    fail("updater signature is not a Minisign Ed25519 signature");
  }
  const trustedComment = lines[2].slice("trusted comment: ".length);
  const fields = trustedComment.split("\t");
  const timestamps = fields.filter((field) => field.startsWith("timestamp:"));
  const files = fields.filter((field) => field.startsWith("file:"));
  const versions = fields.filter((field) => field.startsWith("version:"));
  if (timestamps.length !== 1 || files.length !== 1 || versions.length !== 1 || fields.length !== (target ? 5 : 3)) {
    fail("updater signature trusted comment must contain one timestamp, file, and version field");
  }
  if (!/^timestamp:[1-9]\d{9,}$/.test(timestamps[0])) fail("updater signature timestamp field is invalid");
  if (files[0] !== `file:${file}`) fail("updater signature does not bind the updater artifact file");
  if (versions[0] !== `version:${version}`) fail(`updater signature does not bind version ${version}`);
  if (target && fields.filter((field) => field.startsWith("target:")).join() !== `target:${target}`) {
    fail("updater signature does not bind the selected platform target");
  }
  if (target) {
    if (!CHANNELS.has(channel) || fields[4] !== `channel:${channel}`)
      fail("updater signature does not bind the selected release channel");
    if (
      JSON.stringify(fields) !==
      JSON.stringify([timestamps[0], `file:${file}`, `version:${version}`, `target:${target}`, `channel:${channel}`])
    ) {
      fail("updater signature trusted comment fields are not in canonical order");
    }
  }

  const publicKey = parsePublicKey(publicKeyBase64);
  const signatureKeyId = signatureRecord.subarray(2, 10);
  if (!timingSafeEqual(publicKey.id, signatureKeyId)) fail("updater signature is invalid");
  const artifactSignature = signatureRecord.subarray(10);
  const digest = await blake2bFile(artifactPath);
  const artifactValid = verifyBytes(null, digest, publicKey.key, artifactSignature);
  const globalValid = verifyBytes(
    null,
    Buffer.concat([artifactSignature, Buffer.from(trustedComment, "utf8")]),
    publicKey.key,
    globalSignature,
  );
  if (!artifactValid || !globalValid) fail("updater signature is invalid");
}

/**
 * Builds a static Tauri updater feed after verifying release evidence and local artifacts.
 * This function only returns JSON; publishing remains a separately authorized release action.
 */
export async function createUpdaterManifest(input) {
  return createWindowsManifest(input);
}

async function createWindowsManifest(
  {
    build,
    verify,
    artifactPath,
    artifactKey,
    signaturePath,
    publicKeyBase64,
    requestedChannel = build?.requestedReleaseChannel,
    publishedAt,
    notes,
    qa,
    qaPhase = "final",
  },
  signatureTarget,
) {
  if (!CHANNELS.has(requestedChannel)) fail("release channel must be stable, beta, or dev");
  if (build?.requestedReleaseChannel !== requestedChannel)
    fail("build channel does not match the requested feed channel");
  if (build?.releaseDescriptorEligible !== true) fail("build is not eligible for a release descriptor");
  if (build?.signatureStatus !== "Valid") fail("build Authenticode signature is not valid");
  if (!signingEvidenceIsExact(build?.signing)) fail("build signing evidence must be complete and redacted");
  if (!updaterSigningEvidenceIsExact(build?.updater, build?.file)) {
    fail("build updater signature evidence must be complete and redacted");
  }
  if (!VERSION.test(build?.version ?? "")) fail("build version is invalid");
  if (requestedChannel === "stable" && build.version.includes("-")) fail("prerelease versions cannot enter stable");
  if (!COMMIT.test(build?.commit ?? "")) fail("build commit is invalid");
  if (!SHA256.test(build?.sha256 ?? "")) fail("build SHA-256 is invalid");
  const qaProblems = updaterQaProblems(
    qa,
    {
      target: "windows-x86_64",
      channel: requestedChannel,
      release: { version: build.version, commit: build.commit, sha256: build.sha256 },
    },
    qaPhase,
  );
  if (requestedChannel === "stable") {
    const problems = [...publicSigningProblems(build), ...publicVerificationProblems(build, verify)];
    problems.push(...qaProblems);
    if (problems.length > 0) fail(problems.join("; "));
  } else if (qaProblems.length > 0) fail(qaProblems.join("; "));
  if (typeof notes !== "string" || notes.trim().length === 0 || notes.length > 10_000) {
    fail("release notes are required and must be concise");
  }
  if (typeof publishedAt !== "string" || Number.isNaN(Date.parse(publishedAt))) fail("publish date is invalid");

  const file = basename(artifactPath ?? "");
  if (!SAFE_FILE.test(file) || file.includes("..")) fail("updater artifact file name is unsafe");
  if (file !== build.file) fail("updater artifact file does not match the exact build installer");
  const expectedArtifactKey = `releases/updater/${requestedChannel}/${build.version}/${build.sha256}/${file}`;
  if (artifactKey !== expectedArtifactKey) fail("updater artifact object key is not canonical or content-addressed");
  const signatureFile = signatureTarget ? `${file}.${signatureTarget}.sig` : `${file}.sig`;
  if (basename(signaturePath ?? "") !== signatureFile) fail("updater signature file does not match the artifact");
  const artifact = await requiredFile(artifactPath, "updater artifact", MAX_UPDATE_BYTES);
  await requiredFile(signaturePath, "updater signature", MAX_SIGNATURE_BYTES);
  const signatureBase64 = (await readFile(signaturePath, "utf8")).trimEnd();
  await validateSignature(
    signatureBase64,
    publicKeyBase64,
    artifactPath,
    build.version,
    file,
    signatureTarget,
    requestedChannel,
  );
  const sha256 = await sha256File(artifactPath);
  if (artifact.size !== build.size || sha256 !== build.sha256) {
    fail("updater artifact does not match the exact build size and SHA-256");
  }
  return {
    version: build.version,
    notes: notes.trim(),
    pub_date: new Date(publishedAt).toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: signatureBase64,
        url: `https://kalcoded.com/${artifactKey}`,
      },
    },
    kalcode: {
      schemaVersion: 1,
      channel: requestedChannel,
      size: artifact.size,
      sha256,
      commit: build.commit,
    },
  };
}

// An owner-waived update trial (publish.mjs verifies the waiver receipt) lowers exactly that artifact's QA record to
// the preliminary contract: every product check and safeguard still applies and the trial must stay pending (null).
function artifactQaPhase(input, qaPhase) {
  if (input.updateTrialWaived === undefined) return qaPhase;
  if (input.updateTrialWaived !== true || qaPhase !== "final")
    fail("an update-trial waiver applies only to a final publication");
  return "preliminary";
}

/** A v2 feed contains only explicitly supplied, independently verified platform artifacts. */
export async function createPlatformUpdaterManifest({
  artifacts,
  requestedChannel,
  publishedAt,
  notes,
  qaPhase = "final",
}) {
  if (
    !Array.isArray(artifacts) ||
    artifacts.length < 1 ||
    artifacts.length > 2 ||
    artifacts.some((artifact) => !Object.hasOwn(TARGET_FORMATS, artifact?.target ?? "")) ||
    new Set(artifacts.map((artifact) => artifact.target)).size !== artifacts.length
  )
    fail("platform artifacts must contain distinct supported targets");
  if (!CHANNELS.has(requestedChannel)) fail("release channel must be stable, beta, or dev");
  if (typeof notes !== "string" || !notes.trim() || notes.length > 10_000)
    fail("release notes are required and must be concise");
  if (typeof publishedAt !== "string" || Number.isNaN(Date.parse(publishedAt))) fail("publish date is invalid");
  const version = artifacts[0].build?.version;
  const commit = artifacts[0].build?.commit;
  if (!VERSION.test(version ?? "") || !COMMIT.test(commit ?? "")) fail("release version or commit is invalid");
  if (requestedChannel === "stable" && version.includes("-")) fail("prerelease versions cannot enter stable");
  const platforms = {};
  const metadata = {};
  for (const input of artifacts) {
    if (input.build?.version !== version || input.build?.commit !== commit)
      fail("platform artifacts must share an exact version and source commit");
    let artifact;
    if (input.target === "windows-x86_64") {
      const legacy = await createWindowsManifest(
        { ...input, requestedChannel, publishedAt, notes, qaPhase: artifactQaPhase(input, qaPhase) },
        input.target,
      );
      artifact = { ...legacy.platforms[input.target], size: legacy.kalcode.size, sha256: legacy.kalcode.sha256 };
    } else {
      artifact = await validateMacUpdateArtifact(input, requestedChannel, artifactQaPhase(input, qaPhase));
    }
    platforms[input.target] = { url: artifact.url, signature: artifact.signature };
    metadata[input.target] = {
      target: input.target,
      format: TARGET_FORMATS[input.target],
      size: artifact.size,
      sha256: artifact.sha256,
    };
  }
  return {
    version,
    notes: notes.trim(),
    pub_date: new Date(publishedAt).toISOString(),
    platforms,
    kalcode: { schemaVersion: 2, channel: requestedChannel, commit, artifacts: metadata },
  };
}

async function validateMacUpdateArtifact(input, channel, qaPhase) {
  const { build, verify, qa, artifactPath, artifactKey, signaturePath, publicKeyBase64 } = input;
  validateMacBuildRecord(build, artifactPath);
  if (build.arch !== "arm64" || build.requestedReleaseChannel !== channel)
    fail("Mac target or release channel does not match");
  validateCompiledChannel(build, build.compiledChannelVerification?.channel);
  if (build.compiledChannelVerification?.testHooks !== false)
    fail("Mac production build must have test hooks disabled");
  const required = [
    "exactArtifact",
    "developerIdApplication",
    "expectedTeam",
    "hardenedRuntime",
    "timestamped",
    "entitlementsExact",
    "notaryAccepted",
    "notaryLogIssueFree",
    "ticketStapled",
    "gatekeeperAccepted",
  ];
  if (
    verify?.status !== "passed" ||
    verify.platform !== "macos" ||
    verify.arch !== "arm64" ||
    required.some((key) => verify[key] !== true)
  )
    fail("Mac signing and notarization verification is incomplete");
  for (const key of ["version", "file", "size", "sha256", "commit"]) {
    if (verify[key] !== build[key]) fail("Mac verification does not bind the exact artifact and source");
  }
  // Signing alone does not certify the actual application or its update/recovery path.
  const qaProblems = updaterQaProblems(
    qa,
    {
      target: input.target,
      channel,
      release: { version: build.version, commit: build.commit, sha256: build.sha256 },
    },
    qaPhase,
  );
  if (qaProblems.length > 0) fail(`Mac physical-device QA is incomplete: ${qaProblems.join("; ")}`);
  const file = basename(artifactPath ?? "");
  const expectedKey = `releases/updater/${channel}/${build.version}/${build.sha256}/${file}`;
  if (
    !SAFE_FILE.test(file) ||
    file.includes("..") ||
    artifactKey !== expectedKey ||
    basename(signaturePath ?? "") !== `${file}.sig`
  )
    fail("Mac updater artifact paths are not canonical");
  const info = await requiredFile(artifactPath, "updater artifact", MAX_UPDATE_BYTES);
  await requiredFile(signaturePath, "updater signature", MAX_SIGNATURE_BYTES);
  const signature = (await readFile(signaturePath, "utf8")).trimEnd();
  await validateSignature(signature, publicKeyBase64, artifactPath, build.version, file, input.target, channel);
  if (info.size !== build.size || (await sha256File(artifactPath)) !== build.sha256)
    fail("Mac artifact does not match the exact build size and SHA-256");
  return { url: `https://kalcoded.com/${artifactKey}`, signature, size: info.size, sha256: build.sha256 };
}
