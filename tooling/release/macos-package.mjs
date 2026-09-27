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
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

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
  assertProductionEntitlements,
  expectedMacDmgFile,
  MACOS_BUNDLE_ID,
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

function assertContainedNativeBinary(path, appPath, label, arch) {
  const realApp = realpathSync(appPath);
  const realBinary = realpathSync(path);
  if (!realBinary.startsWith(`${realApp}${sep}`)) {
    throw new MacReleaseError("unsafe_bundled_member", `${label} escapes the mounted app bundle.`);
  }
  assertPlainNativeBinary(path, label, arch);
}

function mountedKalCodeApp(mountPath) {
  const entries = readdirSync(mountPath, { withFileTypes: true });
  const applications = entries.filter(({ name }) => name.endsWith(".app")).map(({ name }) => name);
  if (applications.length !== 1 || applications[0] !== "KalCode.app") {
    throw new MacReleaseError("invalid_dmg_contents", "The DMG must contain exactly one KalCode.app bundle.");
  }
  const applicationsLink = join(mountPath, "Applications");
  const applicationsLinkStat = lstatSync(applicationsLink, { throwIfNoEntry: false });
  if (!applicationsLinkStat?.isSymbolicLink() || readlinkSync(applicationsLink) !== "/Applications") {
    throw new MacReleaseError("invalid_dmg_contents", "The DMG must contain the exact Applications link.");
  }
  const appPath = join(mountPath, applications[0]);
  const appStat = lstatSync(appPath);
  if (!appStat.isDirectory() || appStat.isSymbolicLink()) {
    throw new MacReleaseError("invalid_app_bundle", "The DMG must contain one plain KalCode.app bundle.");
  }
  const realMount = realpathSync(mountPath);
  if (!realpathSync(appPath).startsWith(`${realMount}${sep}`)) {
    throw new MacReleaseError("invalid_app_bundle", "The app bundle escapes the mounted DMG.");
  }
  return appPath;
}

function codesignEntitlements(path) {
  return macProcessRunner.capture("codesign", ["--display", "--entitlements", ":-", path]);
}

function assertNoHelperEntitlements(path) {
  if (codesignEntitlements(path) !== "") {
    throw new MacReleaseError("helper_entitlements_mismatch", "A bundled helper carries app-only entitlements.");
  }
}

function assertExpectedTauriSidecarSignature(path, helper, expectedTeamId) {
  macProcessRunner.run("codesign", ["--verify", "--strict", "--verbose=2", path]);
  assertProductionCodesign(
    macProcessRunner.capture("codesign", ["--display", "--verbose=4", path], { output: "stderr" }),
    expectedTeamId,
    helper.name,
  );
  const entitlements = codesignEntitlements(path);
  if (entitlements === "") {
    throw new MacReleaseError(
      "tauri_sidecar_contract_changed",
      "The pinned Tauri sidecar signature no longer has the expected app entitlement boundary.",
    );
  }
  assertProductionEntitlements(
    macProcessRunner.capture("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
      input: entitlements,
    }),
  );
}

async function withCanonicalMacSidecarSignatures(
  { sourceArtifactPath, bundleDir, arch, signingIdentity, expectedTeamId },
  consume,
) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "kalcode-macos-sidecar-signatures-")));
  const mountPath = join(workspace, "mount");
  const repairAppPath = join(workspace, "KalCode.app");
  const repairedArtifactPath = join(workspace, "KalCode-repaired.dmg");
  mkdirSync(mountPath);
  let attachAttempted = false;
  let safeToRemoveWorkspace = true;
  let pendingError;
  try {
    macProcessRunner.run("hdiutil", ["verify", sourceArtifactPath]);
    macProcessRunner.run("codesign", ["--verify", "--strict", "--verbose=2", sourceArtifactPath]);
    attachAttempted = true;
    macProcessRunner.run("hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      mountPath,
      sourceArtifactPath,
    ]);
    const appPath = mountedKalCodeApp(mountPath);
    const executable = join(appPath, "Contents", "MacOS", MACOS_EXECUTABLE);
    assertContainedNativeBinary(executable, appPath, "The Tauri KalCode executable", arch);
    macProcessRunner.run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
    assertProductionCodesign(
      macProcessRunner.capture("codesign", ["--display", "--verbose=4", appPath], { output: "stderr" }),
      expectedTeamId,
    );
    for (const helper of MACOS_HELPERS) {
      const path = join(appPath, "Contents", "MacOS", helper.name);
      assertContainedNativeBinary(path, appPath, `The Tauri ${helper.name} helper`, arch);
      assertExpectedTauriSidecarSignature(path, helper, expectedTeamId);
    }
    macProcessRunner.run("ditto", [appPath, repairAppPath]);
  } catch (error) {
    pendingError = error;
  } finally {
    if (attachAttempted) {
      try {
        macProcessRunner.run("hdiutil", ["detach", mountPath]);
      } catch (error) {
        safeToRemoveWorkspace = false;
        pendingError ??= error;
      }
    }
  }
  try {
    if (pendingError) throw pendingError;
    if (
      !existsSync(repairAppPath) ||
      !lstatSync(repairAppPath).isDirectory() ||
      lstatSync(repairAppPath).isSymbolicLink()
    ) {
      throw new MacReleaseError("invalid_app_bundle", "The copied app bundle is not a plain directory.");
    }
    if (!realpathSync(repairAppPath).startsWith(`${workspace}${sep}`)) {
      throw new MacReleaseError("invalid_app_bundle", "The copied app bundle escapes the owned repair workspace.");
    }
    for (const helper of MACOS_HELPERS) {
      const path = join(repairAppPath, "Contents", "MacOS", helper.name);
      assertContainedNativeBinary(path, repairAppPath, `The copied ${helper.name} helper`, arch);
      macProcessRunner.run("codesign", [
        "--force",
        "--sign",
        signingIdentity,
        "--options",
        "runtime",
        "--timestamp",
        "--identifier",
        helper.identifier,
        path,
      ]);
      macProcessRunner.run("codesign", ["--verify", "--strict", "--verbose=2", path]);
      assertProductionCodesign(
        macProcessRunner.capture("codesign", ["--display", "--verbose=4", path], { output: "stderr" }),
        expectedTeamId,
        helper.identifier,
      );
      assertNoHelperEntitlements(path);
    }
    const entitlementsPath = join(ROOT, "apps", "desktop", "src-tauri", "entitlements.plist");
    macProcessRunner.run("codesign", [
      "--force",
      "--sign",
      signingIdentity,
      "--options",
      "runtime",
      "--timestamp",
      "--identifier",
      MACOS_BUNDLE_ID,
      "--entitlements",
      entitlementsPath,
      repairAppPath,
    ]);
    macProcessRunner.run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", repairAppPath]);
    assertProductionCodesign(
      macProcessRunner.capture("codesign", ["--display", "--verbose=4", repairAppPath], { output: "stderr" }),
      expectedTeamId,
    );
    assertProductionEntitlements(
      macProcessRunner.capture("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
        input: codesignEntitlements(repairAppPath),
      }),
    );

    if (
      !existsSync(bundleDir) ||
      !lstatSync(bundleDir).isDirectory() ||
      lstatSync(bundleDir).isSymbolicLink() ||
      realpathSync(bundleDir) !== resolve(bundleDir)
    ) {
      throw new MacReleaseError("unsafe_dmg_tool", "The Tauri DMG tool directory is unsafe.");
    }
    const bundleScript = join(bundleDir, "bundle_dmg.sh");
    const volumeIcon = join(bundleDir, "icon.icns");
    for (const [path, label] of [
      [bundleScript, "The pinned Tauri DMG script"],
      [volumeIcon, "The generated DMG icon"],
    ]) {
      if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
        throw new MacReleaseError("unsafe_dmg_tool", `${label} is not a regular file.`);
      }
      if (!realpathSync(path).startsWith(`${realpathSync(bundleDir)}${sep}`)) {
        throw new MacReleaseError("unsafe_dmg_tool", `${label} escapes the Tauri bundle directory.`);
      }
    }
    const dmgEnvironment = { ...process.env, CI: "true" };
    delete dmgEnvironment.TAURI_BUNDLER_DMG_IGNORE_CI;
    macProcessRunner.run(
      bundleScript,
      [
        "--volname",
        "KalCode",
        "--icon",
        "KalCode.app",
        "180",
        "170",
        "--app-drop-link",
        "480",
        "170",
        "--window-size",
        "660",
        "400",
        "--hide-extension",
        "KalCode.app",
        "--volicon",
        volumeIcon,
        "--skip-jenkins",
        repairedArtifactPath,
        repairAppPath,
      ],
      { cwd: workspace, env: dmgEnvironment, timeout: 600_000 },
    );
    if (
      !existsSync(repairedArtifactPath) ||
      !lstatSync(repairedArtifactPath).isFile() ||
      lstatSync(repairedArtifactPath).isSymbolicLink()
    ) {
      throw new MacReleaseError("missing_repaired_dmg", "The canonical sidecar repair did not produce a plain DMG.");
    }
    macProcessRunner.run("codesign", ["--force", "--sign", signingIdentity, "--timestamp", repairedArtifactPath]);
    macProcessRunner.run("hdiutil", ["verify", repairedArtifactPath]);
    macProcessRunner.run("codesign", ["--verify", "--strict", "--verbose=2", repairedArtifactPath]);
    await consume(repairedArtifactPath);
  } finally {
    if (safeToRemoveWorkspace) rmSync(workspace, { recursive: true, force: true });
  }
}

async function inspectPackagedDmg({ artifactPath, arch, expectedTeamId }) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "kalcode-macos-package-")));
  const mountPath = join(workspace, "mount");
  mkdirSync(mountPath);
  let attachAttempted = false;
  let pendingError;
  let evidence;
  try {
    macProcessRunner.run("hdiutil", ["verify", artifactPath]);
    macProcessRunner.run("codesign", ["--verify", "--strict", "--verbose=2", artifactPath]);
    attachAttempted = true;
    macProcessRunner.run("hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      mountPath,
      artifactPath,
    ]);
    const appPath = mountedKalCodeApp(mountPath);
    const executable = join(appPath, "Contents", "MacOS", MACOS_EXECUTABLE);
    assertContainedNativeBinary(executable, appPath, "The mounted KalCode executable", arch);
    macProcessRunner.run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
    assertProductionCodesign(
      macProcessRunner.capture("codesign", ["--display", "--verbose=4", appPath], { output: "stderr" }),
      expectedTeamId,
    );
    const helpers = [];
    for (const helper of MACOS_HELPERS) {
      const path = join(appPath, "Contents", "MacOS", helper.name);
      assertContainedNativeBinary(path, appPath, `The mounted ${helper.name} helper`, arch);
      macProcessRunner.run("codesign", ["--verify", "--strict", "--verbose=2", path]);
      assertProductionCodesign(
        macProcessRunner.capture("codesign", ["--display", "--verbose=4", path], { output: "stderr" }),
        expectedTeamId,
        helper.identifier,
      );
      assertNoHelperEntitlements(path);
      helpers.push({
        name: helper.name,
        identifier: helper.identifier,
        architecture: arch,
        sha256: await sha256File(path),
        signed: true,
        expectedTeamBound: true,
        hardenedRuntime: true,
        timestamped: true,
      });
    }
    evidence = {
      buildInfoOutput: macProcessRunner.capture(executable, ["--build-info"]),
      helpers,
    };
  } catch (error) {
    pendingError = error;
  } finally {
    let safeToRemoveWorkspace = !attachAttempted;
    if (attachAttempted) {
      try {
        macProcessRunner.run("hdiutil", ["detach", mountPath]);
        safeToRemoveWorkspace = true;
      } catch (error) {
        pendingError ??= error;
      }
    }
    if (safeToRemoveWorkspace) rmSync(workspace, { recursive: true, force: true });
  }
  if (pendingError) throw pendingError;
  return evidence;
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
  let packagedEvidence;
  await withCanonicalMacSidecarSignatures(
    {
      sourceArtifactPath: candidates[0],
      bundleDir,
      arch,
      signingIdentity: credentials.signingIdentity,
      expectedTeamId: credentials.teamId,
    },
    async (correctedArtifactPath) => {
      copyFileSync(correctedArtifactPath, artifactPath, constants.COPYFILE_EXCL);
      packagedEvidence = await inspectPackagedDmg({
        artifactPath,
        arch,
        expectedTeamId: credentials.teamId,
      });
    },
  );
  assertCleanTree("After the canonical macOS sidecar-signature correction, the working tree");
  if (headCommit() !== commit) throw new MacReleaseError("head_moved", "HEAD moved during macOS package correction.");
  const buildInfo = validateBuildInfo(packagedEvidence.buildInfoOutput, {
    version,
    requestedReleaseChannel: options.requestedReleaseChannel,
  });
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
    helpers: packagedEvidence.helpers,
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
