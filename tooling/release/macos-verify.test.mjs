import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { verifyMacRelease } from "./macos-verify-lib.mjs";

const team = "A1B2C3D4E5";
const submission = "123e4567-e89b-42d3-a456-426614174000";
const artifact = resolve("KalCode_1.2.3_arm64.dmg");
const record = {
  schemaVersion: 1,
  platform: "macos",
  version: "1.2.3",
  arch: "arm64",
  file: "KalCode_1.2.3_arm64.dmg",
  size: 10,
  sha256: "a".repeat(64),
  notarySubmissionId: submission,
};

function fixture() {
  const calls = [];
  const runner = {
    run(command, args) {
      calls.push(["run", command, args]);
    },
    capture(command, args, options = {}) {
      calls.push(["capture", command, args, options]);
      if (command === "lipo") return "arm64";
      if (command === "codesign" && args.includes("--verbose=4")) {
        return [
          "Identifier=com.kalcode.desktop",
          "CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+1 location=embedded",
          "Authority=Developer ID Application: Example (A1B2C3D4E5)",
          `TeamIdentifier=${team}`,
          "Timestamp=25 Sep 2026 at 12:00:00",
        ].join("\n");
      }
      if (command === "codesign" && args.includes("--entitlements")) return "<plist />";
      if (command === "plutil" && args.includes("-convert")) {
        return JSON.stringify({ "com.apple.security.device.audio-input": true });
      }
      if (command === "plutil") {
        const key = args[1];
        if (key === "CFBundleIdentifier") return "com.kalcode.desktop";
        if (key === "CFBundleShortVersionString") return "1.2.3";
        if (key === "LSMinimumSystemVersion") return "14.0";
        if (key === "NSMicrophoneUsageDescription")
          return "KalVoice uses the microphone only when you start voice input.";
      }
      if (command === "xcrun" && args[1] === "info") return JSON.stringify({ id: submission, status: "Accepted" });
      if (command === "xcrun" && args[1] === "log") {
        return JSON.stringify({ jobId: submission, status: "Accepted", issues: [] });
      }
      throw new Error(`unexpected capture: ${command} ${args.join(" ")}`);
    },
  };
  const temp = resolve("synthetic-mount-workspace");
  const fs = {
    lstat(path) {
      if (path === artifact)
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: 10 };
      if (path.endsWith("KalCode.app"))
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
      return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: 1 };
    },
    mkdir() {},
    mkdtemp() {
      return temp;
    },
    readdir() {
      return [{ name: "KalCode.app", isDirectory: () => true }];
    },
    remove() {},
  };
  return { calls, runner, fs };
}

test("production verification binds the exact DMG through app, staple, Gatekeeper, and Apple log checks", async () => {
  const { calls, runner, fs } = fixture();
  const report = await verifyMacRelease({
    artifactPath: artifact,
    record,
    expectedTeamId: team,
    notaryProfile: "kalcode-notary",
    runner,
    fs,
    hashFile: async () => record.sha256,
    tempRoot: resolve("tmp"),
  });
  assert.equal(report.status, "passed");
  assert.equal(report.exactArtifact, true);
  assert.equal(report.notaryLogIssueFree, true);
  assert.ok(
    calls.some(([, command, args]) => command === "hdiutil" && args[0] === "attach" && args.at(-1) === artifact),
  );
  assert.ok(calls.some(([, command, args]) => command === "xcrun" && args[0] === "stapler" && args[1] === "validate"));
  assert.ok(calls.some(([, command, args]) => command === "spctl" && args.includes("context:primary-signature")));
  assert.ok(calls.some(([, command, args]) => command === "xcrun" && args[0] === "notarytool" && args[1] === "log"));
});

test("digest mismatch stops before mounting untrusted bytes", async () => {
  const { calls, runner, fs } = fixture();
  await assert.rejects(
    verifyMacRelease({
      artifactPath: artifact,
      record,
      expectedTeamId: team,
      notaryProfile: "kalcode-notary",
      runner,
      fs,
      hashFile: async () => "b".repeat(64),
    }),
    /do not match/,
  );
  assert.equal(calls.length, 0);
});

test("a Gatekeeper failure cannot produce passing evidence and the mounted image is detached", async () => {
  const { calls, runner, fs } = fixture();
  const originalRun = runner.run;
  runner.run = (command, args) => {
    originalRun(command, args);
    if (command === "spctl" && args.includes("context:primary-signature")) throw new Error("denied");
  };
  await assert.rejects(
    verifyMacRelease({
      artifactPath: artifact,
      record,
      expectedTeamId: team,
      notaryProfile: "kalcode-notary",
      runner,
      fs,
      hashFile: async () => record.sha256,
    }),
    /denied/,
  );
  assert.ok(calls.some(([, command, args]) => command === "hdiutil" && args[0] === "detach"));
});
