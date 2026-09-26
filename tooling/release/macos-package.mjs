#!/usr/bin/env node
// Builds one native-architecture macOS DMG, signs it with Developer ID, submits that exact staged
// artifact to Apple, staples the ticket, and writes only redacted evidence. It never publishes.
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  appVersion,
  assertCleanTree,
  capture,
  headCommit,
  productName,
  ROOT,
  sha256File,
  stagingDir,
  TARGET_DIR,
} from "./lib.mjs";
import {
  acceptedNotaryLog,
  acceptedNotarySubmission,
  expectedMacDmgFile,
  MACOS_MINIMUM_VERSION,
  MacReleaseError,
  macBuildEnvironment,
  macTauriBuildArgs,
  normalizeMacArchitecture,
  notaryLogArgs,
  notarySubmitArgs,
  rustTargetForMacArchitecture,
  validateMacReleaseEnvironment,
} from "./macos-contract.mjs";
import { macProcessRunner, verifyMacRelease } from "./macos-verify-lib.mjs";

function fail(error) {
  const code = error instanceof MacReleaseError ? error.code : "package_failed";
  const message = error instanceof Error ? error.message : "macOS packaging failed.";
  console.error(`macos-package [${code}]: ${message}`);
  process.exit(1);
}

function featuresFromArgs(args) {
  if (args.length === 0) return ["kalvoice-whisper"];
  if (args.length !== 2 || args[0] !== "--features") {
    throw new MacReleaseError("invalid_arguments", "Usage: node tooling/release/macos-package.mjs [--features a,b]");
  }
  const features = args[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (features.length === 0) throw new MacReleaseError("invalid_arguments", "--features cannot be empty.");
  return [...new Set(["kalvoice-whisper", ...features])];
}

function assertRepositoryMacConfig() {
  const configPath = join(ROOT, "apps", "desktop", "src-tauri", "tauri.macos.conf.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const mac = config.bundle?.macOS;
  if (
    config.bundle?.targets?.length !== 1 ||
    config.bundle.targets[0] !== "dmg" ||
    mac?.minimumSystemVersion !== MACOS_MINIMUM_VERSION ||
    mac?.hardenedRuntime !== true ||
    mac?.entitlements !== "entitlements.plist" ||
    mac?.infoPlist !== "Info.plist" ||
    Object.hasOwn(mac, "signingIdentity")
  ) {
    throw new MacReleaseError("unsafe_macos_config", "The checked-in macOS Tauri release policy is invalid.");
  }
  macProcessRunner.run("plutil", ["-lint", join(ROOT, "apps", "desktop", "src-tauri", "Info.plist")]);
  macProcessRunner.run("plutil", ["-lint", join(ROOT, "apps", "desktop", "src-tauri", "entitlements.plist")]);
}

function assertToolchain(target, identity) {
  for (const tool of ["notarytool", "stapler"]) macProcessRunner.capture("xcrun", ["--find", tool]);
  for (const tool of ["codesign", "hdiutil", "lipo", "plutil", "spctl"]) {
    macProcessRunner.capture("xcrun", ["--find", tool]);
  }
  const targets = capture("rustup", ["target", "list", "--installed"]).split(/\r?\n/);
  if (!targets.includes(target)) {
    throw new MacReleaseError(
      "missing_rust_target",
      "Run tooling/bootstrap-macos.sh --install to add the native Rust target.",
    );
  }
  const identities = macProcessRunner.capture("security", ["find-identity", "-v", "-p", "codesigning"]);
  const exact = identities.split(/\r?\n/).filter((line) => line.includes(`"${identity}"`));
  if (exact.length !== 1) {
    throw new MacReleaseError(
      "signing_identity_unavailable",
      "Exactly one expected Developer ID Application identity must be available.",
    );
  }
}

async function main() {
  if (process.platform !== "darwin") {
    throw new MacReleaseError("wrong_platform", "The macOS package must be built and verified on macOS.");
  }
  const features = featuresFromArgs(process.argv.slice(2));
  const credentials = validateMacReleaseEnvironment(process.env);
  const arch = normalizeMacArchitecture(macProcessRunner.capture("uname", ["-m"]));
  const target = rustTargetForMacArchitecture(arch);
  macTauriBuildArgs({ target, features });
  assertToolchain(target, credentials.signingIdentity);
  assertRepositoryMacConfig();
  assertCleanTree("A macOS release build");

  const version = appVersion();
  if (productName() !== "KalCode")
    throw new MacReleaseError("product_mismatch", "The release product name must remain KalCode.");
  const commit = headCommit();
  const expectedFile = expectedMacDmgFile(version, arch);
  const outDir = stagingDir(version);
  const artifactPath = join(outDir, expectedFile);
  const recordPath = join(outDir, `macos-${arch}-build.json`);
  const reportPath = join(outDir, `macos-${arch}-verify.json`);
  for (const path of [artifactPath, recordPath, reportPath]) {
    if (existsSync(path)) {
      throw new MacReleaseError("stale_release_output", "Remove the previous macOS release output before rebuilding.");
    }
  }
  const bundleDir = join(TARGET_DIR, target, "release", "bundle", "dmg");
  const startedAt = Date.now();
  const buildEnv = macBuildEnvironment(process.env, credentials.signingIdentity);
  buildEnv.CARGO_TARGET_DIR = TARGET_DIR;
  macProcessRunner.run("pnpm", macTauriBuildArgs({ target, features }), {
    cwd: ROOT,
    env: buildEnv,
    timeout: 3_600_000,
  });
  assertCleanTree("After the macOS release build, the working tree");
  if (headCommit() !== commit) throw new MacReleaseError("head_moved", "HEAD moved during the macOS build.");

  const candidates = existsSync(bundleDir)
    ? readdirSync(bundleDir)
        .filter((name) => name.endsWith(".dmg"))
        .map((name) => join(bundleDir, name))
        .filter(
          (path) =>
            lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && statSync(path).mtimeMs >= startedAt - 1000,
        )
    : [];
  if (candidates.length !== 1) {
    throw new MacReleaseError("ambiguous_bundle", "The Tauri build did not produce exactly one fresh DMG.");
  }

  mkdirSync(outDir, { recursive: true });
  const outStat = lstatSync(outDir);
  if (!outStat.isDirectory() || outStat.isSymbolicLink() || realpathSync(outDir) !== resolve(outDir)) {
    throw new MacReleaseError("unsafe_staging_directory", "The release staging directory is unsafe.");
  }
  copyFileSync(candidates[0], artifactPath, constants.COPYFILE_EXCL);
  const submittedSha256 = await sha256File(artifactPath);
  const submission = acceptedNotarySubmission(
    macProcessRunner.capture("xcrun", notarySubmitArgs(artifactPath, credentials.notaryProfile), {
      timeout: 3_600_000,
    }),
  );
  const notaryLog = macProcessRunner.capture("xcrun", notaryLogArgs(submission.id, credentials.notaryProfile));
  acceptedNotaryLog(notaryLog, submission.id);
  macProcessRunner.run("xcrun", ["stapler", "staple", artifactPath]);

  const record = {
    schemaVersion: 1,
    platform: "macos",
    version,
    arch,
    file: expectedFile,
    size: statSync(artifactPath).size,
    sha256: await sha256File(artifactPath),
    submittedSha256,
    commit,
    createdAt: new Date().toISOString(),
    minimumSystemVersion: MACOS_MINIMUM_VERSION,
    signed: true,
    hardenedRuntime: true,
    expectedTeamBound: true,
    notarized: true,
    notarySubmissionId: submission.id,
    stapled: true,
    features,
  };
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const report = await verifyMacRelease({
    artifactPath,
    record,
    expectedTeamId: credentials.teamId,
    notaryProfile: credentials.notaryProfile,
  });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(`Verified macOS ${arch} package: ${expectedFile}`);
  console.log("No artifact was published.");
}

main().catch(fail);
