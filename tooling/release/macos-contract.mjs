import { basename } from "node:path";

export const MACOS_MINIMUM_VERSION = "14.0";
export const MACOS_BUNDLE_ID = "com.kalcode.desktop";
export const MACOS_EXECUTABLE = "kalcode";
export const MACOS_PRODUCT = "KalCode";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SUBMISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

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

export function expectedMacDmgFile(version, arch) {
  if (!VERSION.test(String(version ?? ""))) reject("invalid_version", "The macOS release version must be SemVer.");
  return `KalCode_${version}_${normalizeMacArchitecture(arch)}.dmg`;
}

export function validateMacReleaseEnvironment(env) {
  const teamId = String(env.KALCODE_APPLE_TEAM_ID ?? "").trim();
  const signingIdentity = String(env.KALCODE_APPLE_SIGNING_IDENTITY ?? "").trim();
  const notaryProfile = String(env.KALCODE_NOTARY_KEYCHAIN_PROFILE ?? "").trim();
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
  if (!PROFILE.test(notaryProfile)) {
    reject("missing_notary_profile", "KALCODE_NOTARY_KEYCHAIN_PROFILE must name a stored notarytool keychain profile.");
  }
  return { teamId, signingIdentity, notaryProfile };
}

export function macBuildEnvironment(env, signingIdentity) {
  const result = { ...env };
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

export function macTauriBuildArgs({ target, features = [] }) {
  if (!["aarch64-apple-darwin", "x86_64-apple-darwin"].includes(target)) {
    reject("invalid_target", "The macOS Rust target is not approved.");
  }
  for (const feature of features) {
    if (!/^[a-z0-9-]+$/.test(feature) || feature === "e2e") {
      reject("invalid_feature", "Release features must be safe Cargo feature names and cannot enable e2e hooks.");
    }
  }
  const args = ["--filter", "@kalcode/desktop", "tauri", "build", "--bundles", "dmg", "--target", target];
  if (features.length > 0) args.push("--features", features.join(","));
  return args;
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
  const issues = Array.isArray(parsed.issues) ? parsed.issues : null;
  if (id !== expectedSubmissionId || parsed.status !== "Accepted" || !issues || issues.length !== 0) {
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
  if (!SUBMISSION_ID.test(String(record.notarySubmissionId ?? ""))) {
    reject("invalid_build_record", "The macOS build record has no valid notarization submission.");
  }
  return record;
}
