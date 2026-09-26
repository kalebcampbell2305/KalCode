import { basename } from "node:path";

import { parseReleaseChannelArgs, validateReleaseBuildArgs } from "./release-channel.mjs";
import { validateUpdaterPublicKey } from "./updater-signing.mjs";

export const MACOS_MINIMUM_VERSION = "14.0";
export const MACOS_BUNDLE_ID = "com.kalcode.desktop";
export const MACOS_EXECUTABLE = "kalcode";
export const MACOS_PRODUCT = "KalCode";
export const MACOS_UPDATE_HELPER = "kalcode-update-helper";
export const MACOS_UPDATE_HELPER_IDENTIFIER = "com.kalcode.desktop.update-helper";
export const MACOS_HELPERS = Object.freeze([
  Object.freeze({
    name: MACOS_UPDATE_HELPER,
    packageName: "kalcode-desktop",
    identifier: MACOS_UPDATE_HELPER_IDENTIFIER,
    includeReleaseFeatures: true,
    noDefaultFeatures: false,
  }),
  Object.freeze({
    name: "kalcode-provider-guardian",
    packageName: "kalcode-providers",
    identifier: "com.kalcode.desktop.provider-guardian",
    includeReleaseFeatures: false,
    noDefaultFeatures: false,
  }),
  Object.freeze({
    name: "kalcode-hook",
    packageName: "kalcode-hook-bridge",
    identifier: "com.kalcode.desktop.hook",
    includeReleaseFeatures: false,
    noDefaultFeatures: true,
  }),
]);

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SUBMISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export class MacReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MacReleaseError";
    this.code = code;
  }
}

function reject(code, message) {
  throw new MacReleaseError(code, message);
}

export function normalizeMacArchitecture(value) {
  const arch = String(value ?? "").trim();
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  if (arch === "x86_64" || arch === "amd64" || arch === "x64") return "x64";
  reject("unsupported_architecture", "macOS releases require an Apple silicon or Intel x86_64 runner.");
}

export function rustTargetForMacArchitecture(arch) {
  const normalized = normalizeMacArchitecture(arch);
  return normalized === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
}

export function parseMacPackageOptions(args) {
  let buildOnly = false;
  let resume;
  const buildArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--build-only") {
      if (buildOnly) reject("invalid_stage", "--build-only may be specified only once.");
      buildOnly = true;
    } else if (args[index] === "--resume") {
      if (resume || !args[index + 1] || args[index + 1].startsWith("--"))
        reject("invalid_stage", "--resume requires exactly one candidate record.");
      resume = args[++index];
    } else buildArgs.push(args[index]);
  }
  if (resume && (buildOnly || buildArgs.includes("--features")))
    reject("invalid_stage", "--resume cannot be combined with build options.");
  args = buildArgs;
  validateReleaseBuildArgs(args);
  if (args.includes("--unsigned-local")) {
    reject("unsigned_macos_release", "A macOS production package cannot be unsigned.");
  }
  const channel = parseReleaseChannelArgs(args);
  const featuresIndex = args.indexOf("--features");
  const requestedFeatures =
    featuresIndex === -1
      ? []
      : args[featuresIndex + 1]
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
  const features = [...new Set(["kalvoice-whisper", ...requestedFeatures])];
  for (const feature of features) {
    if (!/^[a-z0-9-]+$/.test(feature) || feature === "e2e") {
      reject("invalid_feature", "Release features must be safe Cargo feature names and cannot enable e2e hooks.");
    }
  }
  return { ...channel, features, ...(buildOnly ? { buildOnly } : {}), ...(resume ? { resume } : {}) };
}

export function expectedMacDmgFile(version, arch) {
  if (!VERSION.test(String(version ?? ""))) reject("invalid_version", "The macOS release version must be SemVer.");
  return `KalCode_${version}_${normalizeMacArchitecture(arch)}.dmg`;
}

export function validateMacSigningEnvironment(env) {
  const teamId = String(env.KALCODE_APPLE_TEAM_ID ?? "").trim();
  const signingIdentity = String(env.KALCODE_APPLE_SIGNING_IDENTITY ?? "").trim();
  if (!TEAM_ID.test(teamId))
    reject("missing_team_id", "KALCODE_APPLE_TEAM_ID must be the expected 10-character team ID.");
  if (
    signingIdentity === "-" ||
    signingIdentity.includes("\n") ||
    !signingIdentity.startsWith("Developer ID Application: ") ||
    !signingIdentity.endsWith(` (${teamId})`)
  ) {
    reject(
      "invalid_signing_identity",
      "KALCODE_APPLE_SIGNING_IDENTITY must name the expected Developer ID Application identity for the configured team.",
    );
  }
  return { teamId, signingIdentity };
}

export function validateMacNotaryProfile(value) {
  const notaryProfile = String(value ?? "").trim();
  if (!PROFILE.test(notaryProfile)) {
    reject("missing_notary_profile", "KALCODE_NOTARY_KEYCHAIN_PROFILE must name a stored notarytool keychain profile.");
  }
  return notaryProfile;
}

export function validateMacReleaseEnvironment(env) {
  return {
    ...validateMacSigningEnvironment(env),
    notaryProfile: validateMacNotaryProfile(env.KALCODE_NOTARY_KEYCHAIN_PROFILE),
  };
}

export function macBuildEnvironment(env, signingIdentity, updaterPublicKey) {
  const result = { ...env };
  result.KALCODE_UPDATER_PUBLIC_KEY = validateUpdaterPublicKey(updaterPublicKey);
  for (const name of [
    "APPLE_API_ISSUER",
    "APPLE_API_KEY",
    "APPLE_API_KEY_PATH",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    delete result[name];
  }
  result.APPLE_SIGNING_IDENTITY = signingIdentity;
  result.MACOSX_DEPLOYMENT_TARGET = MACOS_MINIMUM_VERSION;
  return result;
}

export function macSdkBuildEnvironment(env, sdkRoot) {
  const normalized = String(sdkRoot ?? "").trim();
  if (!normalized.startsWith("/") || /[\0\r\n]/.test(normalized)) {
    reject("invalid_macos_sdk", "The selected macOS SDK path is invalid.");
  }
  return {
    ...env,
    SDKROOT: normalized,
    CMAKE_OSX_SYSROOT: normalized,
    // Some Command Line Tools releases keep libc++ in the SDK while Clang's
    // built-in search list points only at the otherwise-empty CLT prefix.
    CXXFLAGS: `-isystem${normalized}/usr/include/c++/v1`,
  };
}

function validateMacBuildInputs(target, features) {
  if (!["aarch64-apple-darwin", "x86_64-apple-darwin"].includes(target)) {
    reject("invalid_target", "The macOS Rust target is not approved.");
  }
  for (const feature of features) {
    if (!/^[a-z0-9-]+$/.test(feature) || feature === "e2e") {
      reject("invalid_feature", "Release features must be safe Cargo feature names and cannot enable e2e hooks.");
    }
  }
}

export function macTauriBuildArgs({ target, features = [] }) {
  validateMacBuildInputs(target, features);
  const args = ["--filter", "@kalcode/desktop", "tauri", "build", "--bundles", "dmg", "--target", target];
  if (features.length > 0) args.push("--features", features.join(","));
  return args;
}

function canonicalMacHelper(helper) {
  const name = typeof helper === "string" ? helper : helper?.name;
  const canonical = MACOS_HELPERS.find((candidate) => candidate.name === name);
  if (!canonical) reject("invalid_helper", "The requested macOS helper is not part of the canonical bundle inventory.");
  return canonical;
}

export function macHelperBuildArgs({ helper, target, features = [] }) {
  validateMacBuildInputs(target, features);
  const spec = canonicalMacHelper(helper);
  const args = ["build", "-p", spec.packageName, "--bin", spec.name, "--release", "--target", target];
  if (spec.noDefaultFeatures) args.push("--no-default-features");
  if (spec.includeReleaseFeatures && features.length > 0) args.push("--features", features.join(","));
  return args;
}

export function macHelperBuildEnvironment(env) {
  return {
    ...env,
    // The checked-in macOS Tauri overlay bundles this binary. Disable that
    // one packaging input while compiling the binary itself, then restore the
    // normal overlay for the Tauri bundle step after the exact helper is
    // staged and signed.
    TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [] } }),
  };
}

export function macHelperSidecarName(helper, target) {
  validateMacBuildInputs(target, []);
  return `${canonicalMacHelper(helper).name}-${target}`;
}

export function notarySubmitArgs(artifactPath, profile) {
  return ["notarytool", "submit", artifactPath, "--keychain-profile", profile, "--wait", "--output-format", "json"];
}

export function notaryInfoArgs(submissionId, profile) {
  if (!SUBMISSION_ID.test(String(submissionId ?? "")))
    reject("invalid_submission", "The notary submission ID is invalid.");
  return ["notarytool", "info", submissionId, "--keychain-profile", profile, "--output-format", "json"];
}

export function notaryLogArgs(submissionId, profile) {
  if (!SUBMISSION_ID.test(String(submissionId ?? "")))
    reject("invalid_submission", "The notary submission ID is invalid.");
  return ["notarytool", "log", submissionId, "--keychain-profile", profile];
}

function jsonObject(value, code, label) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    reject(code, `${label} did not return valid JSON.`);
  }
}

export function acceptedNotarySubmission(value) {
  const parsed = jsonObject(value, "invalid_notary_response", "notarytool");
  if (parsed.status !== "Accepted" || !SUBMISSION_ID.test(String(parsed.id ?? ""))) {
    reject("notary_not_accepted", "Apple notarization was not accepted.");
  }
  return { id: parsed.id, accepted: true };
}

export function acceptedNotaryInfo(value, expectedSubmissionId) {
  const parsed = jsonObject(value, "invalid_notary_info", "notarytool info");
  if (parsed.id !== expectedSubmissionId || parsed.status !== "Accepted") {
    reject("notary_info_mismatch", "The exact notarization submission is not accepted.");
  }
  return true;
}

export function acceptedNotaryLog(value, expectedSubmissionId) {
  const parsed = jsonObject(value, "invalid_notary_log", "notarytool log");
  const id = parsed.jobId ?? parsed.id;
  const issueFree = parsed.issues === null || (Array.isArray(parsed.issues) && parsed.issues.length === 0);
  if (id !== expectedSubmissionId || parsed.status !== "Accepted" || !issueFree) {
    reject("notary_log_failed", "The exact notarization log is not accepted and issue-free.");
  }
  return true;
}

export function assertProductionCodesign(display, expectedTeamId, expectedIdentifier = MACOS_BUNDLE_ID) {
  const text = String(display ?? "");
  const authorities = text.match(/^Authority=Developer ID Application: .+$/gm) ?? [];
  const team = text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const identifier = text.match(/^Identifier=(.+)$/m)?.[1]?.trim();
  const runtime = /^CodeDirectory .+flags=.*\bruntime\b.*$/m.test(text);
  const timestamped = /^Timestamp=.+$/m.test(text) && !/^Timestamp=none$/m.test(text);
  if (
    /^(Signature=adhoc|TeamIdentifier=not set)$/m.test(text) ||
    authorities.length !== 1 ||
    !authorities[0].endsWith(` (${expectedTeamId})`) ||
    team !== expectedTeamId ||
    identifier !== expectedIdentifier ||
    !runtime ||
    !timestamped
  ) {
    reject(
      "codesign_identity_mismatch",
      "The artifact is not a timestamped hardened-runtime Developer ID build for the expected team and identifier.",
    );
  }
  return {
    developerIdApplication: true,
    expectedTeam: true,
    expectedIdentifier: true,
    hardenedRuntime: true,
    timestamped: true,
  };
}

export function assertProductionEntitlements(value) {
  const parsed = jsonObject(value, "invalid_entitlements", "codesign entitlements");
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 1 || keys[0] !== "com.apple.security.device.audio-input" || parsed[keys[0]] !== true) {
    reject("unsafe_entitlements", "The app must carry only the approved KalVoice audio-input entitlement.");
  }
  return true;
}

export function validateMacBuildRecord(record, artifactPath) {
  validateMacSignedRecord(record, artifactPath);
  if (!SUBMISSION_ID.test(String(record.notarySubmissionId ?? ""))) {
    reject("invalid_build_record", "The macOS build record has no valid notarization submission.");
  }
  if (record.releaseDescriptorEligible !== true || record.releaseDescriptorBlockedReason !== null) {
    reject("invalid_build_record", "The macOS build record is not eligible for a signed release descriptor.");
  }
  return record;
}

export function validateMacCandidateRecord(record, artifactPath) {
  validateMacSignedRecord(record, artifactPath);
  if (
    record.kind !== "macos-signed-candidate" ||
    !TEAM_ID.test(record.teamId ?? "") ||
    record.releaseDescriptorEligible !== false ||
    record.releaseDescriptorBlockedReason !== "notarization_pending" ||
    record.notarized !== false ||
    record.stapled !== false ||
    Object.hasOwn(record, "notarySubmissionId")
  ) {
    reject("invalid_candidate", "The signed candidate must remain explicitly non-publishable pending notarization.");
  }
  return record;
}

function validateMacSignedRecord(record, artifactPath) {
  if (record?.schemaVersion !== 1 || record.platform !== "macos") {
    reject("invalid_build_record", "The macOS build record schema is invalid.");
  }
  const expected = expectedMacDmgFile(record.version, record.arch);
  if (record.file !== expected || basename(artifactPath) !== expected) {
    reject("artifact_record_mismatch", "The exact DMG does not match its build record.");
  }
  if (!Number.isSafeInteger(record.size) || record.size <= 0 || !SHA256.test(String(record.sha256 ?? ""))) {
    reject("invalid_build_record", "The macOS build record size or SHA-256 is invalid.");
  }
  if (!COMMIT.test(String(record.commit ?? ""))) {
    reject("invalid_build_record", "The macOS build record has no exact source commit.");
  }
  if (record.signed !== true || record.signatureStatus !== "Valid") {
    reject("invalid_build_record", "The macOS build record is not eligible for a signed release descriptor.");
  }
  if (
    !Array.isArray(record.helpers) ||
    record.helpers.length !== MACOS_HELPERS.length ||
    record.helpers.some((helper, index) => {
      const expectedHelper = MACOS_HELPERS[index];
      return (
        helper?.name !== expectedHelper.name ||
        helper?.identifier !== expectedHelper.identifier ||
        helper?.architecture !== record.arch ||
        !SHA256.test(String(helper?.sha256 ?? "")) ||
        helper?.signed !== true ||
        helper?.expectedTeamBound !== true ||
        helper?.hardenedRuntime !== true ||
        helper?.timestamped !== true
      );
    })
  ) {
    reject("invalid_build_record", "The macOS build record does not bind every required signed helper.");
  }
  const requested = record.requestedReleaseChannel;
  const expectedCompiled = requested === "dev" ? "development" : requested;
  if (!["stable", "beta", "dev"].includes(requested) || record.compiledChannel !== expectedCompiled) {
    reject("compiled_channel_mismatch", "The macOS build record compiled channel does not match its release channel.");
  }
  const channelEvidence = record.compiledChannelVerification;
  if (
    !channelEvidence ||
    typeof channelEvidence !== "object" ||
    Array.isArray(channelEvidence) ||
    Object.keys(channelEvidence).sort().join(",") !== "channel,method,schemaVersion,testHooks,version" ||
    channelEvidence.schemaVersion !== 1 ||
    channelEvidence.version !== record.version ||
    channelEvidence.channel !== record.compiledChannel ||
    channelEvidence.method !== "build_info_probe_v1" ||
    channelEvidence.testHooks !== false
  ) {
    reject(
      "invalid_compiled_channel_evidence",
      "The macOS build record compiled channel is not bound to a production binary with test hooks disabled.",
    );
  }
  return record;
}
