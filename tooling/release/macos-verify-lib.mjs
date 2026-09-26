import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { sha256File } from "./lib.mjs";
import {
  acceptedNotaryInfo,
  acceptedNotaryLog,
  assertProductionCodesign,
  assertProductionEntitlements,
  MACOS_BUNDLE_ID,
  MACOS_EXECUTABLE,
  MACOS_MINIMUM_VERSION,
  MACOS_PRODUCT,
  MacReleaseError,
  notaryInfoArgs,
  notaryLogArgs,
  validateMacBuildRecord,
} from "./macos-contract.mjs";

function processResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    input: options.input,
    maxBuffer: 4 * 1024 * 1024,
    timeout: options.timeout ?? 300_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new MacReleaseError("verification_command_failed", `${basename(command)} verification failed.`);
  }
  return result;
}

export const macProcessRunner = {
  run(command, args, options) {
    processResult(command, args, options);
  },
  capture(command, args, options = {}) {
    const result = processResult(command, args, options);
    if (options.output === "stderr") return (result.stderr ?? "").trim();
    if (options.output === "combined") return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    return (result.stdout ?? "").trim();
  },
};

function plainFile(path, label, fs) {
  const stat = fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new MacReleaseError("unsafe_artifact", `${label} must be a regular file, not a symbolic link.`);
  }
  return stat;
}

function plistValue(runner, plist, key) {
  return runner.capture("plutil", ["-extract", key, "raw", "-o", "-", plist]);
}

function expectedArchitectures(arch) {
  if (arch === "arm64") return ["arm64"];
  if (arch === "x64") return ["x86_64"];
  throw new MacReleaseError("invalid_architecture", "The build record architecture is invalid.");
}

function verifyMountedApplication({ appPath, record, expectedTeamId, runner, fs }) {
  const appStat = fs.lstat(appPath);
  if (!appStat.isDirectory() || appStat.isSymbolicLink()) {
    throw new MacReleaseError("invalid_app_bundle", "The DMG must contain one plain KalCode.app bundle.");
  }
  const executable = join(appPath, "Contents", "MacOS", MACOS_EXECUTABLE);
  plainFile(executable, "The app executable", fs);
  const infoPlist = join(appPath, "Contents", "Info.plist");
  plainFile(infoPlist, "The app Info.plist", fs);

  if (plistValue(runner, infoPlist, "CFBundleIdentifier") !== MACOS_BUNDLE_ID) {
    throw new MacReleaseError("bundle_identifier_mismatch", "The mounted app bundle identifier is invalid.");
  }
  if (plistValue(runner, infoPlist, "CFBundleShortVersionString") !== record.version) {
    throw new MacReleaseError("bundle_version_mismatch", "The mounted app version does not match the build record.");
  }
  if (plistValue(runner, infoPlist, "LSMinimumSystemVersion") !== MACOS_MINIMUM_VERSION) {
    throw new MacReleaseError("deployment_target_mismatch", "The app minimum system version is invalid.");
  }
  const microphonePurpose = plistValue(runner, infoPlist, "NSMicrophoneUsageDescription");
  if (!microphonePurpose.startsWith("KalVoice ") || microphonePurpose.length > 160) {
    throw new MacReleaseError(
      "microphone_purpose_missing",
      "The app has no bounded KalVoice microphone purpose string.",
    );
  }

  const archs = runner.capture("lipo", ["-archs", executable]).split(/\s+/).filter(Boolean).sort();
  if (JSON.stringify(archs) !== JSON.stringify(expectedArchitectures(record.arch).sort())) {
    throw new MacReleaseError(
      "binary_architecture_mismatch",
      "The app executable architecture does not match the build record.",
    );
  }

  runner.run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const display = runner.capture("codesign", ["--display", "--verbose=4", appPath], { output: "stderr" });
  assertProductionCodesign(display, expectedTeamId);
  const entitlementPlist = runner.capture("codesign", ["--display", "--entitlements", ":-", appPath]);
  const entitlementJson = runner.capture("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
    input: entitlementPlist,
  });
  assertProductionEntitlements(entitlementJson);
  runner.run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
}

const defaultFs = {
  lstat: lstatSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  mkdtemp: (prefix) => mkdtempSync(prefix),
  readdir: (path) => readdirSync(path, { withFileTypes: true }),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};

/**
 * Verifies one exact signed and notarized DMG. Dependencies are injectable so every decision can
 * be tested on non-macOS hosts; production callers use the real bounded process and filesystem
 * adapters above.
 */
export async function verifyMacRelease({
  artifactPath,
  record,
  expectedTeamId,
  notaryProfile,
  runner = macProcessRunner,
  fs = defaultFs,
  hashFile = sha256File,
  tempRoot = tmpdir(),
}) {
  const absoluteArtifact = resolve(artifactPath);
  validateMacBuildRecord(record, absoluteArtifact);
  const stat = plainFile(absoluteArtifact, "The DMG", fs);
  if (stat.size !== record.size || (await hashFile(absoluteArtifact)) !== record.sha256) {
    throw new MacReleaseError("artifact_digest_mismatch", "The DMG bytes do not match the exact build record.");
  }
  if (!/^[A-Z0-9]{10}$/.test(expectedTeamId ?? "")) {
    throw new MacReleaseError("missing_team_id", "The expected Apple team ID is required.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(notaryProfile ?? "")) {
    throw new MacReleaseError("missing_notary_profile", "A stored notarytool keychain profile is required.");
  }

  const workspace = fs.mkdtemp(join(tempRoot, "kalcode-macos-verify-"));
  const mountPath = join(workspace, "mount");
  fs.mkdir(mountPath);
  let attached = false;
  let pendingError;
  try {
    runner.run("hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      mountPath,
      absoluteArtifact,
    ]);
    attached = true;
    const applications = fs
      .readdir(mountPath)
      .filter((entry) => entry.name.endsWith(".app"))
      .map((entry) => entry.name);
    if (applications.length !== 1 || applications[0] !== `${MACOS_PRODUCT}.app`) {
      throw new MacReleaseError("invalid_dmg_contents", "The DMG must contain exactly one KalCode.app bundle.");
    }
    verifyMountedApplication({
      appPath: join(mountPath, applications[0]),
      record,
      expectedTeamId,
      runner,
      fs,
    });
  } catch (error) {
    pendingError = error;
  } finally {
    if (attached) {
      try {
        runner.run("hdiutil", ["detach", mountPath]);
      } catch (error) {
        pendingError ??= error;
      }
    }
    fs.remove(workspace);
  }
  if (pendingError) throw pendingError;

  runner.run("xcrun", ["stapler", "validate", absoluteArtifact]);
  runner.run("spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=4",
    absoluteArtifact,
  ]);
  const info = runner.capture("xcrun", notaryInfoArgs(record.notarySubmissionId, notaryProfile));
  acceptedNotaryInfo(info, record.notarySubmissionId);
  const log = runner.capture("xcrun", notaryLogArgs(record.notarySubmissionId, notaryProfile));
  acceptedNotaryLog(log, record.notarySubmissionId);

  return {
    schemaVersion: 1,
    status: "passed",
    platform: "macos",
    version: record.version,
    arch: record.arch,
    file: record.file,
    size: record.size,
    sha256: record.sha256,
    exactArtifact: true,
    developerIdApplication: true,
    expectedTeam: true,
    hardenedRuntime: true,
    timestamped: true,
    entitlementsExact: true,
    notaryAccepted: true,
    notaryLogIssueFree: true,
    ticketStapled: true,
    gatekeeperAccepted: true,
  };
}
