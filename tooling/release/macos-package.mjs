#!/usr/bin/env node
// Builds one native-architecture macOS DMG, signs it with Developer ID, submits that exact staged
// artifact to Apple, staples the ticket, and writes only redacted evidence. It never publishes.
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
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
  assertProductionCodesign,
  expectedMacDmgFile,
  MACOS_EXECUTABLE,
  MACOS_HELPERS,
  MACOS_MINIMUM_VERSION,
  MacReleaseError,
  macBuildEnvironment,
  macHelperBuildArgs,
  macHelperBuildEnvironment,
  macHelperSidecarName,
  macSdkBuildEnvironment,
  macTauriBuildArgs,
  normalizeMacArchitecture,
  parseMacPackageOptions,
  rustTargetForMacArchitecture,
  validateMacReleaseEnvironment,
  validateMacSigningEnvironment,
} from "./macos-contract.mjs";
import { macCandidateArtifactPath, resumeMacCandidate } from "./macos-resume.mjs";
import { macProcessRunner, verifyMacCandidate } from "./macos-verify-lib.mjs";
import { buildEnvironment, validateBuildInfo } from "./release-channel.mjs";
import { readUpdaterPublicKey } from "./updater-signing.mjs";

function fail(error) {
  const code = error instanceof MacReleaseError ? error.code : "package_failed";
  const message = error instanceof Error ? error.message : "macOS packaging failed.";
  console.error(`macos-package [${code}]: ${message}`);
  process.exit(1);
}

function assertRepositoryMacConfig() {
  const configPath = join(ROOT, "apps", "desktop", "src-tauri", "tauri.macos.conf.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const mac = config.bundle?.macOS;
  if (
    config.bundle?.targets?.length !== 1 ||
    config.bundle.targets[0] !== "dmg" ||
    JSON.stringify(config.bundle?.externalBin) !==
      JSON.stringify(MACOS_HELPERS.map(({ name }) => `binaries/${name}`)) ||
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

function expectedBinaryArchitecture(arch) {
  return arch === "arm64" ? "arm64" : "x86_64";
}

function assertPlainNativeBinary(path, label, arch) {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new MacReleaseError("missing_built_helper", `${label} was not produced as a regular file.`);
  }
  const architectures = macProcessRunner.capture("lipo", ["-archs", path]).split(/\s+/).filter(Boolean);
  if (architectures.length !== 1 || architectures[0] !== expectedBinaryArchitecture(arch)) {
    throw new MacReleaseError("helper_architecture_mismatch", `${label} has the wrong architecture.`);
  }
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
  const sdkRoot = realpathSync(macProcessRunner.capture("xcrun", ["--show-sdk-path"]));
  const libcxxArray = join(sdkRoot, "usr", "include", "c++", "v1", "array");
  if (
    !existsSync(sdkRoot) ||
    !lstatSync(sdkRoot).isDirectory() ||
    !existsSync(libcxxArray) ||
    !lstatSync(libcxxArray).isFile()
  ) {
    throw new MacReleaseError(
      "invalid_macos_sdk",
      "The selected macOS SDK does not contain the required libc++ headers.",
    );
  }
  return sdkRoot;
}

async function main() {
  const options = parseMacPackageOptions(process.argv.slice(2));
  if (process.platform !== "darwin") {
    throw new MacReleaseError("wrong_platform", "The macOS package must be built and verified on macOS.");
  }
  const features = options.features;
  const credentials = options.buildOnly
    ? validateMacSigningEnvironment(process.env)
    : validateMacReleaseEnvironment(process.env);
  const arch = normalizeMacArchitecture(macProcessRunner.capture("uname", ["-m"]));
  if (options.resume) {
    assertCleanTree("A macOS notarization resume");
    const result = await resumeMacCandidate({
      candidatePath: options.resume,
      expected: {
        commit: headCommit(),
        version: appVersion(),
        arch,
        requestedReleaseChannel: options.requestedReleaseChannel,
        teamId: credentials.teamId,
      },
      notaryProfile: credentials.notaryProfile,
    });
    console.log(`Verified macOS ${arch} package: ${result.record.file}`);
    console.log("No artifact was published.");
    return;
  }
  const target = rustTargetForMacArchitecture(arch);
  const updaterPublicKey = readUpdaterPublicKey();
  macTauriBuildArgs({ target, features });
  const sdkRoot = assertToolchain(target, credentials.signingIdentity);
  assertRepositoryMacConfig();
  assertCleanTree("A macOS release build");

  const version = appVersion();
  if (productName() !== "KalCode")
    throw new MacReleaseError("product_mismatch", "The release product name must remain KalCode.");
  const commit = headCommit();
  const expectedFile = expectedMacDmgFile(version, arch);
  const outDir = stagingDir(version);
  const candidatePath = join(outDir, `macos-${arch}-candidate.json`);
  const artifactPath = macCandidateArtifactPath(candidatePath, { arch, file: expectedFile });
  const recordPath = join(outDir, `macos-${arch}-build.json`);
  const reportPath = join(outDir, `macos-${arch}-verify.json`);
  for (const path of [
    artifactPath,
    candidatePath,
    join(outDir, expectedFile),
    recordPath,
    reportPath,
    join(outDir, `macos-${arch}-notary.json`),
  ]) {
    if (existsSync(path)) {
      throw new MacReleaseError("stale_release_output", "Remove the previous macOS release output before rebuilding.");
    }
  }
  const bundleDir = join(TARGET_DIR, target, "release", "bundle", "dmg");
  const builtExecutable = join(TARGET_DIR, target, "release", MACOS_EXECUTABLE);
  const startedAt = Date.now();
  const buildEnv = macSdkBuildEnvironment(
    macBuildEnvironment(
      buildEnvironment(process.env, options.compiledChannel),
      credentials.signingIdentity,
      updaterPublicKey,
    ),
    sdkRoot,
  );
  buildEnv.CARGO_TARGET_DIR = TARGET_DIR;
  const helperDirectory = join(ROOT, "apps", "desktop", "src-tauri", "binaries");
  const helpers = MACOS_HELPERS.map((helper) => ({
    ...helper,
    source: join(TARGET_DIR, target, "release", helper.name),
    sidecar: join(helperDirectory, macHelperSidecarName(helper, target)),
  }));
  if (helpers.some(({ sidecar }) => existsSync(sidecar))) {
    throw new MacReleaseError("stale_release_helper", "Remove every previous staged macOS helper before rebuilding.");
  }
  const createdSidecars = [];
  const builtHelperEvidence = [];
  try {
    mkdirSync(helperDirectory, { recursive: true });
    const helperDirectoryStat = lstatSync(helperDirectory);
    if (
      !helperDirectoryStat.isDirectory() ||
      helperDirectoryStat.isSymbolicLink() ||
      realpathSync(helperDirectory) !== resolve(helperDirectory)
    ) {
      throw new MacReleaseError("unsafe_helper_directory", "The release-helper staging directory is unsafe.");
    }
    for (const helper of helpers) {
      macProcessRunner.run("cargo", macHelperBuildArgs({ helper, target, features }), {
        cwd: ROOT,
        env: macHelperBuildEnvironment(buildEnv),
        timeout: 3_600_000,
      });
      assertPlainNativeBinary(helper.source, `The ${helper.name} helper`, arch);
      copyFileSync(helper.source, helper.sidecar, constants.COPYFILE_EXCL);
      createdSidecars.push(helper.sidecar);
      chmodSync(helper.sidecar, 0o755);
      macProcessRunner.run("codesign", [
        "--force",
        "--sign",
        credentials.signingIdentity,
        "--options",
        "runtime",
        "--timestamp",
        "--identifier",
        helper.identifier,
        helper.sidecar,
      ]);
      assertProductionCodesign(
        macProcessRunner.capture("codesign", ["--display", "--verbose=4", helper.sidecar], { output: "stderr" }),
        credentials.teamId,
        helper.identifier,
      );
      builtHelperEvidence.push({
        name: helper.name,
        identifier: helper.identifier,
        architecture: arch,
        sha256: await sha256File(helper.sidecar),
        signed: true,
        expectedTeamBound: true,
        hardenedRuntime: true,
        timestamped: true,
      });
    }
    macProcessRunner.run("pnpm", macTauriBuildArgs({ target, features }), {
      cwd: ROOT,
      env: buildEnv,
      timeout: 3_600_000,
    });
  } finally {
    for (const sidecar of createdSidecars) rmSync(sidecar, { force: true });
  }
  assertCleanTree("After the macOS release build, the working tree");
  if (headCommit() !== commit) throw new MacReleaseError("head_moved", "HEAD moved during the macOS build.");
  assertPlainNativeBinary(builtExecutable, "The KalCode release executable", arch);
  const buildInfo = validateBuildInfo(macProcessRunner.capture(builtExecutable, ["--build-info"]), {
    version,
    requestedReleaseChannel: options.requestedReleaseChannel,
  });

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
  mkdirSync(join(outDir, `macos-${arch}-candidate`), { mode: 0o700 });
  copyFileSync(candidates[0], artifactPath, constants.COPYFILE_EXCL);
  const record = {
    schemaVersion: 1,
    kind: "macos-signed-candidate",
    platform: "macos",
    teamId: credentials.teamId,
    version,
    arch,
    file: expectedFile,
    size: statSync(artifactPath).size,
    sha256: await sha256File(artifactPath),
    commit,
    createdAt: new Date().toISOString(),
    minimumSystemVersion: MACOS_MINIMUM_VERSION,
    signed: true,
    signatureStatus: "Valid",
    hardenedRuntime: true,
    expectedTeamBound: true,
    notarized: false,
    stapled: false,
    releaseDescriptorEligible: false,
    releaseDescriptorBlockedReason: "notarization_pending",
    features,
    helpers: builtHelperEvidence,
    requestedReleaseChannel: options.requestedReleaseChannel,
    compiledChannel: buildInfo.channel,
    compiledChannelVerification: {
      schemaVersion: buildInfo.schemaVersion,
      version: buildInfo.version,
      channel: buildInfo.channel,
      method: "build_info_probe_v1",
      testHooks: buildInfo.testHooks,
    },
  };
  await verifyMacCandidate({ artifactPath, record, expectedTeamId: credentials.teamId });
  writeFileSync(candidatePath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  if (options.buildOnly) {
    console.log(`Signed macOS candidate verified: ${candidatePath}`);
    console.log("Notarization is pending. This candidate is not eligible for publishing.");
    return;
  }
  await resumeMacCandidate({
    candidatePath,
    expected: {
      commit,
      version,
      arch,
      requestedReleaseChannel: options.requestedReleaseChannel,
      teamId: credentials.teamId,
    },
    notaryProfile: credentials.notaryProfile,
  });
  console.log(`Verified macOS ${arch} package: ${expectedFile}`);
  console.log("No artifact was published.");
}

main().catch(fail);
