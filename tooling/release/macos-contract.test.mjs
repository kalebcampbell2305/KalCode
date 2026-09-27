import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  acceptedNotaryInfo,
  acceptedNotaryLog,
  acceptedNotarySubmission,
  assertProductionCodesign,
  assertProductionEntitlements,
  expectedMacDmgFile,
  MACOS_HELPERS,
  MACOS_MINIMUM_VERSION,
  MACOS_UPDATE_HELPER,
  MACOS_UPDATE_HELPER_IDENTIFIER,
  macBuildEnvironment,
  macHelperBuildArgs,
  macHelperBuildEnvironment,
  macHelperSidecarName,
  macSdkBuildEnvironment,
  macTauriBuildArgs,
  normalizeMacArchitecture,
  notarySubmitArgs,
  parseMacPackageOptions,
  rustTargetForMacArchitecture,
  validateMacReleaseEnvironment,
} from "./macos-contract.mjs";
import { readUpdaterPublicKey } from "./updater-signing.mjs";

const team = "A1B2C3D4E5";
const identity = `Developer ID Application: Example (${team})`;
const profile = "kalcode-notary";
const submission = "123e4567-e89b-42d3-a456-426614174000";
const packager = fileURLToPath(new URL("./macos-package.mjs", import.meta.url));

test("native architecture is detected and never guessed", () => {
  assert.equal(normalizeMacArchitecture("arm64\n"), "arm64");
  assert.equal(normalizeMacArchitecture("x86_64"), "x64");
  assert.equal(rustTargetForMacArchitecture("arm64"), "aarch64-apple-darwin");
  assert.equal(rustTargetForMacArchitecture("x64"), "x86_64-apple-darwin");
  assert.throws(() => normalizeMacArchitecture("universal"), /require an Apple silicon or Intel/);
});

test("artifact names bind SemVer and native architecture", () => {
  assert.equal(expectedMacDmgFile("1.2.3", "arm64"), "KalCode_1.2.3_arm64.dmg");
  assert.equal(expectedMacDmgFile("1.2.3-beta.1", "x86_64"), "KalCode_1.2.3-beta.1_x64.dmg");
  assert.throws(() => expectedMacDmgFile("../1", "arm64"), /SemVer/);
});

test("release credentials require Developer ID for the exact team and a stored notary profile", () => {
  assert.deepEqual(
    validateMacReleaseEnvironment({
      KALCODE_APPLE_TEAM_ID: team,
      KALCODE_APPLE_SIGNING_IDENTITY: identity,
      KALCODE_NOTARY_KEYCHAIN_PROFILE: profile,
    }),
    { teamId: team, signingIdentity: identity, notaryProfile: profile },
  );
  assert.throws(
    () =>
      validateMacReleaseEnvironment({
        KALCODE_APPLE_TEAM_ID: team,
        KALCODE_APPLE_SIGNING_IDENTITY: "-",
        KALCODE_NOTARY_KEYCHAIN_PROFILE: profile,
      }),
    /Developer ID Application/,
  );
});

test("Tauri receives only signing identity and the explicit deployment target", () => {
  const inherited = {
    KEEP: "yes",
    CI: "false",
    TAURI_BUNDLER_DMG_IGNORE_CI: "true",
    APPLE_ID: "remove",
    APPLE_PASSWORD: "remove",
    APPLE_API_KEY: "remove",
    APPLE_API_KEY_PATH: "remove",
    APPLE_API_ISSUER: "remove",
    APPLE_TEAM_ID: "remove",
  };
  const original = { ...inherited };
  const result = macBuildEnvironment(inherited, identity, readUpdaterPublicKey());
  assert.equal(result.KEEP, "yes");
  assert.equal(result.CI, "true");
  assert.equal(result.TAURI_BUNDLER_DMG_IGNORE_CI, undefined);
  assert.equal(result.APPLE_SIGNING_IDENTITY, identity);
  assert.equal(result.MACOSX_DEPLOYMENT_TARGET, MACOS_MINIMUM_VERSION);
  assert.deepEqual(inherited, original);
  for (const key of [
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_PATH",
    "APPLE_API_ISSUER",
    "APPLE_TEAM_ID",
  ]) {
    assert.equal(result[key], undefined);
  }
});

test("Mac builds bind the tracked updater key instead of inheriting missing or substituted trust", () => {
  const trustedKey = readUpdaterPublicKey();
  for (const inherited of [{}, { KALCODE_UPDATER_PUBLIC_KEY: "substituted" }]) {
    const original = { ...inherited };
    const result = macBuildEnvironment(inherited, identity, trustedKey);
    assert.equal(result.KALCODE_UPDATER_PUBLIC_KEY, trustedKey);
    assert.deepEqual(inherited, original);
  }
  assert.throws(() => macBuildEnvironment({}, identity), /public key is missing/);
  assert.throws(() => macBuildEnvironment({}, identity, "invalid"), /public key/);
});

test("the native build is bound to the selected SDK and its libc++ headers", () => {
  const result = macSdkBuildEnvironment({ KEEP: "yes", CXXFLAGS: "unsafe-inherited" }, "/SDK/MacOSX.sdk\n");
  assert.equal(result.KEEP, "yes");
  assert.equal(result.SDKROOT, "/SDK/MacOSX.sdk");
  assert.equal(result.CMAKE_OSX_SYSROOT, "/SDK/MacOSX.sdk");
  assert.equal(result.CXXFLAGS, "-isystem/SDK/MacOSX.sdk/usr/include/c++/v1");
  assert.throws(() => macSdkBuildEnvironment({}, "relative/sdk"), /SDK path is invalid/);
  assert.throws(() => macSdkBuildEnvironment({}, "/SDK\0injected"), /SDK path is invalid/);
});

test("the release build is a native DMG and cannot include e2e hooks", () => {
  assert.deepEqual(macTauriBuildArgs({ target: "aarch64-apple-darwin", features: ["kalvoice-whisper"] }), [
    "--filter",
    "@kalcode/desktop",
    "tauri",
    "build",
    "--bundles",
    "dmg",
    "--target",
    "aarch64-apple-darwin",
    "--features",
    "kalvoice-whisper",
  ]);
  assert.throws(() => macTauriBuildArgs({ target: "aarch64-apple-darwin", features: ["e2e"] }), /cannot enable e2e/);
  assert.throws(() => macTauriBuildArgs({ target: "universal-apple-darwin" }), /not approved/);
});

test("every required helper is built for the exact target and named as a Tauri sidecar", () => {
  assert.deepEqual(
    MACOS_HELPERS.map(({ name, packageName, identifier }) => ({ name, packageName, identifier })),
    [
      {
        name: "kalcode-update-helper",
        packageName: "kalcode-desktop",
        identifier: "com.kalcode.desktop.update-helper",
      },
      {
        name: "kalcode-provider-guardian",
        packageName: "kalcode-providers",
        identifier: "com.kalcode.desktop.provider-guardian",
      },
      {
        name: "kalcode-hook",
        packageName: "kalcode-hook-bridge",
        identifier: "com.kalcode.desktop.hook",
      },
    ],
  );
  assert.deepEqual(
    macHelperBuildArgs({ helper: MACOS_HELPERS[0], target: "aarch64-apple-darwin", features: ["kalvoice-whisper"] }),
    [
      "build",
      "-p",
      "kalcode-desktop",
      "--bin",
      MACOS_UPDATE_HELPER,
      "--release",
      "--target",
      "aarch64-apple-darwin",
      "--features",
      "kalvoice-whisper",
    ],
  );
  assert.deepEqual(macHelperBuildArgs({ helper: MACOS_HELPERS[1], target: "aarch64-apple-darwin" }), [
    "build",
    "-p",
    "kalcode-providers",
    "--bin",
    "kalcode-provider-guardian",
    "--release",
    "--target",
    "aarch64-apple-darwin",
  ]);
  assert.deepEqual(macHelperBuildArgs({ helper: MACOS_HELPERS[2], target: "aarch64-apple-darwin" }), [
    "build",
    "-p",
    "kalcode-hook-bridge",
    "--bin",
    "kalcode-hook",
    "--release",
    "--target",
    "aarch64-apple-darwin",
    "--no-default-features",
  ]);
  assert.equal(
    macHelperSidecarName(MACOS_HELPERS[0], "aarch64-apple-darwin"),
    "kalcode-update-helper-aarch64-apple-darwin",
  );
  assert.equal(
    macHelperSidecarName(MACOS_HELPERS[1], "aarch64-apple-darwin"),
    "kalcode-provider-guardian-aarch64-apple-darwin",
  );
  assert.equal(MACOS_UPDATE_HELPER_IDENTIFIER, "com.kalcode.desktop.update-helper");
  assert.throws(
    () => macHelperBuildArgs({ helper: MACOS_HELPERS[0], target: "universal-apple-darwin" }),
    /not approved/,
  );
  assert.throws(
    () => macHelperBuildArgs({ helper: MACOS_HELPERS[0], target: "aarch64-apple-darwin", features: ["e2e"] }),
    /cannot enable e2e/,
  );
  const helperEnvironment = macHelperBuildEnvironment({ KEEP: "yes", TAURI_CONFIG: "unsafe-inherited" });
  assert.equal(helperEnvironment.KEEP, "yes");
  assert.deepEqual(JSON.parse(helperEnvironment.TAURI_CONFIG), { bundle: { externalBin: [] } });
});

test("macOS package options require an explicit product channel and always include local KalVoice", () => {
  assert.deepEqual(parseMacPackageOptions(["--channel", "stable"]), {
    requestedReleaseChannel: "stable",
    compiledChannel: "stable",
    features: ["kalvoice-whisper"],
  });
  assert.deepEqual(parseMacPackageOptions(["--features", "safe-extra", "--channel=dev"]), {
    requestedReleaseChannel: "dev",
    compiledChannel: "development",
    features: ["kalvoice-whisper", "safe-extra"],
  });
  assert.throws(() => parseMacPackageOptions([]), /--channel stable\|beta\|dev is required/);
  assert.throws(() => parseMacPackageOptions(["--channel", "stable", "--unsigned-local"]), /cannot be unsigned/);
  assert.throws(() => parseMacPackageOptions(["--channel", "stable", "--features", "e2e"]), /cannot enable e2e/);
});

test("missing release channel fails before host or signing preflight", () => {
  const result = spawnSync(process.execPath, [packager], { encoding: "utf8", windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /--channel stable\|beta\|dev is required/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /wrong_platform|Developer ID|working tree/);
});

test("notarization accepts only an exact accepted submission and issue-free matching log", () => {
  assert.deepEqual(acceptedNotarySubmission({ id: submission, status: "Accepted" }), {
    id: submission,
    accepted: true,
  });
  assert.equal(acceptedNotaryInfo({ id: submission, status: "Accepted" }, submission), true);
  assert.equal(acceptedNotaryLog({ jobId: submission, status: "Accepted", issues: [] }, submission), true);
  assert.throws(() => acceptedNotarySubmission({ id: submission, status: "Invalid" }), /not accepted/);
  assert.throws(
    () => acceptedNotaryLog({ jobId: submission, status: "Accepted", issues: [{ severity: "warning" }] }, submission),
    /issue-free/,
  );
  assert.deepEqual(notarySubmitArgs("/tmp/KalCode.dmg", profile).slice(0, 3), [
    "notarytool",
    "submit",
    "/tmp/KalCode.dmg",
  ]);
});

test("production codesign evidence rejects ad hoc, wrong team, missing runtime, and missing timestamp", () => {
  const valid = [
    "Identifier=com.kalcode.desktop",
    "CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+1 location=embedded",
    "Authority=Developer ID Application: Example (A1B2C3D4E5)",
    `TeamIdentifier=${team}`,
    "Timestamp=25 Sep 2026 at 12:00:00",
  ].join("\n");
  assert.equal(assertProductionCodesign(valid, team).hardenedRuntime, true);
  assert.throws(() => assertProductionCodesign(`${valid}\nSignature=adhoc`, team), /not a timestamped/);
  assert.throws(() => assertProductionCodesign(valid.replace(team, "Z9Y8X7W6V5"), team), /expected team/);
  assert.throws(() => assertProductionCodesign(valid.replace("(runtime)", ""), team), /hardened-runtime/);
  assert.throws(() => assertProductionCodesign(valid.replace(/^Timestamp=.*$/m, ""), team), /timestamped/);
});

test("release entitlements are exactly the KalVoice audio-input grant", () => {
  assert.equal(assertProductionEntitlements({ "com.apple.security.device.audio-input": true }), true);
  assert.throws(
    () =>
      assertProductionEntitlements({
        "com.apple.security.device.audio-input": true,
        "com.apple.security.get-task-allow": true,
      }),
    /only the approved/,
  );
  assert.throws(
    () => assertProductionEntitlements({ "com.apple.security.cs.disable-library-validation": true }),
    /approved/,
  );
});

test("checked-in macOS configuration is hardened and bootstrap is read-only by default", () => {
  const root = join(import.meta.dirname, "..", "..");
  const config = JSON.parse(readFileSync(join(root, "apps", "desktop", "src-tauri", "tauri.macos.conf.json"), "utf8"));
  assert.equal(config.bundle.macOS.minimumSystemVersion, "14.0");
  assert.equal(config.bundle.macOS.hardenedRuntime, true);
  assert.equal(config.bundle.macOS.entitlements, "entitlements.plist");
  assert.equal(Object.hasOwn(config.bundle.macOS, "signingIdentity"), false);
  assert.deepEqual(config.bundle.externalBin, [
    "binaries/kalcode-update-helper",
    "binaries/kalcode-provider-guardian",
    "binaries/kalcode-hook",
  ]);
  const bootstrap = readFileSync(join(root, "tooling", "bootstrap-macos.sh"), "utf8");
  const packager = readFileSync(join(root, "tooling", "release", "macos-package.mjs"), "utf8");
  assert.match(bootstrap, /mode="check"/);
  assert.match(bootstrap, /--install/);
  assert.doesNotMatch(bootstrap, /brew install|curl .+\|\s*(ba)?sh/);
  assert.doesNotMatch(
    bootstrap.match(/required_commands=\([^\n]+\)/)?.[0] ?? "",
    /xcodebuild/,
    "Command Line Tools are sufficient for development bootstrap",
  );
  assert.match(bootstrap, /release_failure=0/);
  assert.match(bootstrap, /release prerequisites are incomplete/);
  assert.match(packager, /parseMacPackageOptions\(process\.argv\.slice\(2\)\)/);
  assert.match(packager, /const features = options\.features;/);
  assert.match(packager, /const updaterPublicKey = readUpdaterPublicKey\(\);/);
  assert.match(packager, /macBuildEnvironment\([\s\S]*?credentials\.signingIdentity,\s*updaterPublicKey,/);
});
