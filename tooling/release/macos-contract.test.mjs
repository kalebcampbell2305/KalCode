import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  acceptedNotaryInfo,
  acceptedNotaryLog,
  acceptedNotarySubmission,
  assertProductionCodesign,
  assertProductionEntitlements,
  expectedMacDmgFile,
  MACOS_MINIMUM_VERSION,
  macBuildEnvironment,
  macTauriBuildArgs,
  normalizeMacArchitecture,
  notarySubmitArgs,
  rustTargetForMacArchitecture,
  validateMacReleaseEnvironment,
} from "./macos-contract.mjs";

const team = "A1B2C3D4E5";
const identity = `Developer ID Application: Example (${team})`;
const profile = "kalcode-notary";
const submission = "123e4567-e89b-42d3-a456-426614174000";

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
  const result = macBuildEnvironment(
    {
      KEEP: "yes",
      APPLE_ID: "remove",
      APPLE_PASSWORD: "remove",
      APPLE_API_KEY: "remove",
      APPLE_API_KEY_PATH: "remove",
      APPLE_API_ISSUER: "remove",
      APPLE_TEAM_ID: "remove",
    },
    identity,
  );
  assert.equal(result.KEEP, "yes");
  assert.equal(result.APPLE_SIGNING_IDENTITY, identity);
  assert.equal(result.MACOSX_DEPLOYMENT_TARGET, MACOS_MINIMUM_VERSION);
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
  const bootstrap = readFileSync(join(root, "tooling", "bootstrap-macos.sh"), "utf8");
  const packager = readFileSync(join(root, "tooling", "release", "macos-package.mjs"), "utf8");
  assert.match(bootstrap, /mode="check"/);
  assert.match(bootstrap, /--install/);
  assert.doesNotMatch(bootstrap, /brew install|curl .+\|\s*(ba)?sh/);
  assert.match(packager, /return \["kalvoice-whisper"\]/);
});
