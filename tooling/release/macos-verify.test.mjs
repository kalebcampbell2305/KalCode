import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { verifyMacCandidate, verifyMacRelease } from "./macos-verify-lib.mjs";

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
  commit: "b".repeat(40),
  notarySubmissionId: submission,
  signed: true,
  signatureStatus: "Valid",
  releaseDescriptorEligible: true,
  releaseDescriptorBlockedReason: null,
  requestedReleaseChannel: "stable",
  compiledChannel: "stable",
  compiledChannelVerification: {
    schemaVersion: 1,
    version: "1.2.3",
    channel: "stable",
    method: "build_info_probe_v1",
    testHooks: false,
  },
  helpers: [
    ["kalcode-update-helper", "com.kalcode.desktop.update-helper"],
    ["kalcode-provider-guardian", "com.kalcode.desktop.provider-guardian"],
    ["kalcode-hook", "com.kalcode.desktop.hook"],
  ].map(([name, identifier], index) => ({
    name,
    identifier,
    architecture: "arm64",
    sha256: String(index + 1).repeat(64),
    signed: true,
    expectedTeamBound: true,
    hardenedRuntime: true,
    timestamped: true,
  })),
};

function fixtureHash(path) {
  const helper = record.helpers.find(({ name }) => path.endsWith(name));
  return helper?.sha256 ?? record.sha256;
}

function fixture() {
  const calls = [];
  const runner = {
    run(command, args) {
      calls.push(["run", command, args]);
    },
    capture(command, args, options = {}) {
      calls.push(["capture", command, args, options]);
      if (args[0] === "--build-info")
        return JSON.stringify({ schemaVersion: 1, version: "1.2.3", channel: "stable", testHooks: false });
      if (command === "lipo") return "arm64";
      if (command === "codesign" && args.includes("--verbose=4")) {
        const binary = args.at(-1);
        const identifier = binary.endsWith("kalcode-update-helper")
          ? "com.kalcode.desktop.update-helper"
          : binary.endsWith("kalcode-provider-guardian")
            ? "com.kalcode.desktop.provider-guardian"
            : binary.endsWith("kalcode-hook")
              ? "com.kalcode.desktop.hook"
              : "com.kalcode.desktop";
        return [
          `Identifier=${identifier}`,
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

test("signed candidate verifies real mounted binary and helpers without claiming Apple or Gatekeeper acceptance", async () => {
  const { notarySubmissionId: _id, ...base } = record;
  const candidate = {
    ...base,
    kind: "macos-signed-candidate",
    teamId: team,
    releaseDescriptorEligible: false,
    releaseDescriptorBlockedReason: "notarization_pending",
    notarized: false,
    stapled: false,
  };
  const { calls, runner, fs } = fixture();
  const report = await verifyMacCandidate({
    artifactPath: artifact,
    record: candidate,
    expectedTeamId: team,
    runner,
    fs,
    hashFile: async (path) => fixtureHash(path),
  });
  assert.equal(report.releaseDescriptorEligible, false);
  assert.equal(report.status, "signed-candidate-verified");
  assert.equal(
    calls.some(([, command]) => command === "spctl" || command === "xcrun"),
    false,
  );
  assert.ok(calls.some(([, , args]) => args[0] === "--build-info"));
  await assert.rejects(
    verifyMacRelease({ artifactPath: artifact, record: candidate, expectedTeamId: team, runner, fs }),
    /notarization/,
  );
  for (const failure of ["helper", "channel", "entitlements"]) {
    const next = fixture();
    const capture = next.runner.capture;
    next.runner.capture = (command, args, options) => {
      if (failure === "channel" && args[0] === "--build-info")
        return JSON.stringify({ schemaVersion: 1, version: "1.2.3", channel: "beta", testHooks: false });
      if (failure === "entitlements" && command === "plutil" && args.includes("-convert"))
        return JSON.stringify({ "com.apple.security.get-task-allow": true });
      return capture(command, args, options);
    };
    await assert.rejects(
      verifyMacCandidate({
        artifactPath: artifact,
        record: candidate,
        expectedTeamId: team,
        runner: next.runner,
        fs: next.fs,
        hashFile: async (path) =>
          failure === "helper" && path.endsWith("kalcode-hook") ? "0".repeat(64) : fixtureHash(path),
      }),
    );
  }
});

test("production verification binds the exact DMG through app, staple, Gatekeeper, and Apple log checks", async () => {
  const { calls, runner, fs } = fixture();
  const report = await verifyMacRelease({
    artifactPath: artifact,
    record,
    expectedTeamId: team,
    notaryProfile: "kalcode-notary",
    runner,
    fs,
    hashFile: async (path) => fixtureHash(path),
    tempRoot: resolve("tmp"),
  });
  assert.equal(report.status, "passed");
  assert.equal(report.commit, record.commit);
  assert.equal(report.requestedReleaseChannel, "stable");
  assert.equal(report.compiledChannel, "stable");
  assert.equal(report.exactArtifact, true);
  assert.equal(report.updateHelperBundled, true);
  assert.equal(report.updateHelperExpectedTeam, true);
  assert.equal(report.updateHelperHardenedRuntime, true);
  assert.deepEqual(
    report.helpers.map(({ name }) => name),
    ["kalcode-update-helper", "kalcode-provider-guardian", "kalcode-hook"],
  );
  assert.equal(report.notaryLogIssueFree, true);
  assert.ok(
    calls.some(([, command, args]) => command === "hdiutil" && args[0] === "attach" && args.at(-1) === artifact),
  );
  assert.ok(calls.some(([, command, args]) => command === "xcrun" && args[0] === "stapler" && args[1] === "validate"));
  assert.ok(calls.some(([, command, args]) => command === "spctl" && args.includes("context:primary-signature")));
  assert.ok(calls.some(([, command, args]) => command === "xcrun" && args[0] === "notarytool" && args[1] === "log"));
  assert.ok(
    calls.some(
      ([, command, args]) =>
        command === "codesign" && args.includes("--verify") && args.at(-1).endsWith("kalcode-update-helper"),
    ),
  );
});

test("verification rejects unbound commit and binary-channel evidence before mounting", async () => {
  const invalidRecords = [
    { ...record, commit: "not-a-commit" },
    { ...record, compiledChannel: "beta" },
    {
      ...record,
      compiledChannelVerification: { ...record.compiledChannelVerification, channel: "beta" },
    },
    {
      ...record,
      compiledChannelVerification: { ...record.compiledChannelVerification, testHooks: true },
    },
    {
      ...record,
      compiledChannelVerification: { ...record.compiledChannelVerification, version: "1.2.4" },
    },
    { ...record, releaseDescriptorEligible: false, releaseDescriptorBlockedReason: "unsigned_build" },
  ];

  for (const invalidRecord of invalidRecords) {
    const { calls, runner, fs } = fixture();
    await assert.rejects(
      verifyMacRelease({
        artifactPath: artifact,
        record: invalidRecord,
        expectedTeamId: team,
        notaryProfile: "kalcode-notary",
        runner,
        fs,
        hashFile: async (path) => fixtureHash(path),
      }),
      /build record|compiled channel|test hooks/,
    );
    assert.equal(calls.length, 0);
  }
});

for (const helper of ["kalcode-update-helper", "kalcode-provider-guardian", "kalcode-hook"]) {
  test(`a missing or linked ${helper} blocks release verification`, async () => {
    const { calls, runner, fs } = fixture();
    const originalLstat = fs.lstat;
    fs.lstat = (path) => {
      if (path.endsWith(helper)) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => true, size: 1 };
      }
      return originalLstat(path);
    };
    await assert.rejects(
      verifyMacRelease({
        artifactPath: artifact,
        record,
        expectedTeamId: team,
        notaryProfile: "kalcode-notary",
        runner,
        fs,
        hashFile: async (path) => fixtureHash(path),
      }),
      /must be a regular file/i,
    );
    assert.equal(
      calls.some(
        ([, command, args]) => command === "codesign" && args.includes("--verify") && args.at(-1).endsWith(helper),
      ),
      false,
    );
  });
}

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
      hashFile: async (path) => fixtureHash(path),
    }),
    /denied/,
  );
  assert.ok(calls.some(([, command, args]) => command === "hdiutil" && args[0] === "detach"));
});

test("a detach failure retains the verification workspace instead of traversing a mounted image", async () => {
  const { runner, fs } = fixture();
  let removed = false;
  fs.remove = () => {
    removed = true;
  };
  const originalRun = runner.run;
  runner.run = (command, args) => {
    originalRun(command, args);
    if (command === "hdiutil" && args[0] === "detach") throw new Error("detach failed");
  };

  await assert.rejects(
    verifyMacRelease({
      artifactPath: artifact,
      record,
      expectedTeamId: team,
      notaryProfile: "kalcode-notary",
      runner,
      fs,
      hashFile: async (path) => fixtureHash(path),
    }),
    /detach failed/,
  );
  assert.equal(removed, false);
});

test("an attach error followed by a detach error retains the possibly mounted workspace", async () => {
  const { calls, runner, fs } = fixture();
  let removed = false;
  fs.remove = () => {
    removed = true;
  };
  const originalRun = runner.run;
  runner.run = (command, args) => {
    originalRun(command, args);
    if (command === "hdiutil" && args[0] === "attach") throw new Error("attach failed after a possible mount");
    if (command === "hdiutil" && args[0] === "detach") throw new Error("detach failed");
  };

  await assert.rejects(
    verifyMacRelease({
      artifactPath: artifact,
      record,
      expectedTeamId: team,
      notaryProfile: "kalcode-notary",
      runner,
      fs,
      hashFile: async (path) => fixtureHash(path),
    }),
    /attach failed/,
  );
  assert.ok(calls.some(([, command, args]) => command === "hdiutil" && args[0] === "detach"));
  assert.equal(removed, false);
});

test("an attach error permits workspace removal only after bounded detach succeeds", async () => {
  const { calls, runner, fs } = fixture();
  let removed = false;
  fs.remove = () => {
    removed = true;
  };
  const originalRun = runner.run;
  runner.run = (command, args) => {
    originalRun(command, args);
    if (command === "hdiutil" && args[0] === "attach") throw new Error("attach failed after a possible mount");
  };

  await assert.rejects(
    verifyMacRelease({
      artifactPath: artifact,
      record,
      expectedTeamId: team,
      notaryProfile: "kalcode-notary",
      runner,
      fs,
      hashFile: async (path) => fixtureHash(path),
    }),
    /attach failed/,
  );
  assert.ok(calls.some(([, command, args]) => command === "hdiutil" && args[0] === "detach"));
  assert.equal(removed, true);
});

test("a build candidate needs its full version and the matching CFBundleVersion", async () => {
  const buildArtifact = resolve("KalCode_1.2.3_build41_arm64.dmg");
  const { notarySubmissionId: _id, ...base } = record;
  const candidate = {
    ...base,
    version: "1.2.3+41",
    file: "KalCode_1.2.3_build41_arm64.dmg",
    kind: "macos-signed-candidate",
    teamId: team,
    releaseDescriptorEligible: false,
    releaseDescriptorBlockedReason: "notarization_pending",
    notarized: false,
    stapled: false,
    compiledChannelVerification: { ...record.compiledChannelVerification, version: "1.2.3+41" },
  };
  const verify = (bundleVersion, shortVersion = "1.2.3+41") => {
    const { runner, fs } = fixture();
    const capture = runner.capture;
    runner.capture = (command, args, options) => {
      if (args[0] === "--build-info")
        return JSON.stringify({ schemaVersion: 1, version: "1.2.3+41", channel: "stable", testHooks: false });
      if (command === "plutil" && args[1] === "CFBundleShortVersionString") return shortVersion;
      if (command === "plutil" && args[1] === "CFBundleVersion") return bundleVersion;
      return capture(command, args, options);
    };
    const lstat = fs.lstat;
    fs.lstat = (path) => lstat(path === buildArtifact ? artifact : path);
    return verifyMacCandidate({
      artifactPath: buildArtifact,
      record: candidate,
      expectedTeamId: team,
      runner,
      fs,
      hashFile: async (path) => fixtureHash(path),
    });
  };
  assert.equal((await verify("41")).status, "signed-candidate-verified");
  await assert.rejects(verify("40"), /build number/);
  await assert.rejects(verify("1.2.3+41"), /build number/);
  await assert.rejects(verify("41", "1.2.3"), /app version/);
});
