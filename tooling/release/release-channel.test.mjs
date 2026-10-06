import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildChannelContract,
  buildEnvironment,
  parseReleaseChannelArgs,
  validateBuildInfo,
  validateCompiledChannel,
  validateReleaseBuildArgs,
} from "./release-channel.mjs";

const buildScript = fileURLToPath(new URL("./build-windows.mjs", import.meta.url));

function invokeBuild(args) {
  return spawnSync(process.execPath, [buildScript, ...args], {
    encoding: "utf8",
    env: { ...process.env, KALCODE_CHANNEL: "stable" },
    windowsHide: true,
  });
}

test("an explicit product release channel maps to the native build channel", () => {
  assert.deepEqual(parseReleaseChannelArgs(["--channel", "stable"]), {
    requestedReleaseChannel: "stable",
    compiledChannel: "stable",
  });
  assert.deepEqual(parseReleaseChannelArgs(["--channel=beta"]), {
    requestedReleaseChannel: "beta",
    compiledChannel: "beta",
  });
  assert.deepEqual(parseReleaseChannelArgs(["--channel", "dev"]), {
    requestedReleaseChannel: "dev",
    compiledChannel: "development",
  });
});

test("the child build environment overrides an ambient channel", () => {
  assert.deepEqual(buildEnvironment({ KALCODE_CHANNEL: "stable", KEEP: "yes" }, "development"), {
    KALCODE_CHANNEL: "development",
    KEEP: "yes",
  });
});

test("missing, invalid, and duplicate channel arguments are rejected", () => {
  assert.throws(() => parseReleaseChannelArgs([]), /--channel stable\|beta\|dev is required/);
  assert.throws(() => parseReleaseChannelArgs(["--channel", "preview"]), /Unknown release channel "preview"/);
  assert.throws(
    () => parseReleaseChannelArgs(["--channel", "stable", "--channel", "dev"]),
    /--channel may be specified only once/,
  );
  assert.throws(
    () => parseReleaseChannelArgs(["--channel=stable", "--channel=stable"]),
    /--channel may be specified only once/,
  );
});

test("release build arguments reject unknown, missing, and duplicate options", () => {
  assert.doesNotThrow(() => validateReleaseBuildArgs(["--channel", "stable", "--features", "kalvoice-whisper"]));
  assert.doesNotThrow(() => validateReleaseBuildArgs(["--channel=dev", "--unsigned-local"]));
  assert.throws(() => validateReleaseBuildArgs(["--channel", "stable", "--bogus"]), /unknown build option/);
  assert.throws(() => validateReleaseBuildArgs(["--channel", "stable", "--features"]), /needs one value/);
  assert.throws(
    () => validateReleaseBuildArgs(["--channel", "stable", "--features", "one", "--features", "two"]),
    /only once/,
  );
});

test("invalid build invocations fail on the channel contract before release preflight", () => {
  for (const [args, expected] of [
    [[], /--channel stable\|beta\|dev is required/],
    [["--channel", "preview"], /Unknown release channel "preview"/],
    [["--channel", "stable", "--channel", "dev"], /--channel may be specified only once/],
  ]) {
    const result = invokeBuild(args);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, expected);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /needs a clean working tree/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Building KalCode/);
  }
});

test("the build record names both channel vocabularies and never qualifies an unsigned artifact", () => {
  assert.deepEqual(
    buildChannelContract({
      requestedReleaseChannel: "dev",
      compiledChannel: "development",
      compiledChannelVerified: false,
      signed: false,
      signatureStatus: "NotSigned",
    }),
    {
      requestedReleaseChannel: "dev",
      compiledChannel: "development",
      releaseDescriptorEligible: false,
      releaseDescriptorBlockedReason: "unsigned_build",
    },
  );

  assert.deepEqual(
    buildChannelContract({
      requestedReleaseChannel: "stable",
      compiledChannel: "stable",
      compiledChannelVerified: true,
      signed: true,
      signatureStatus: "Valid",
    }),
    {
      requestedReleaseChannel: "stable",
      compiledChannel: "stable",
      releaseDescriptorEligible: true,
      releaseDescriptorBlockedReason: null,
    },
  );
});

test("a mismatched or unverified compiled channel cannot qualify for a release descriptor", () => {
  assert.throws(
    () => validateCompiledChannel({ requestedReleaseChannel: "beta", compiledChannel: "beta" }, "development"),
    /compiled channel development does not match requested beta/,
  );
  assert.throws(
    () =>
      buildChannelContract({
        requestedReleaseChannel: "stable",
        compiledChannel: "development",
        compiledChannelVerified: true,
        signed: true,
        signatureStatus: "Valid",
      }),
    /compiled channel development does not match requested stable/,
  );
  assert.deepEqual(
    buildChannelContract({
      requestedReleaseChannel: "beta",
      compiledChannel: "beta",
      compiledChannelVerified: true,
      signed: false,
      signatureStatus: "UnknownError",
    }),
    {
      requestedReleaseChannel: "beta",
      compiledChannel: "beta",
      releaseDescriptorEligible: false,
      releaseDescriptorBlockedReason: "signature_not_valid",
    },
  );
});

test("a signed build remains descriptor-ineligible until its binary channel is probed", () => {
  assert.deepEqual(
    buildChannelContract({
      requestedReleaseChannel: "stable",
      compiledChannel: "stable",
      compiledChannelVerified: false,
      signed: true,
      signatureStatus: "Valid",
    }),
    {
      requestedReleaseChannel: "stable",
      compiledChannel: "stable",
      releaseDescriptorEligible: false,
      releaseDescriptorBlockedReason: "compiled_channel_not_verified",
    },
  );
});

test("the production binary probe must report the exact version, native channel, and no test hooks", () => {
  const output = JSON.stringify({
    schemaVersion: 1,
    version: "0.1.5",
    channel: "beta",
    testHooks: false,
  });
  assert.deepEqual(validateBuildInfo(output, { version: "0.1.5", requestedReleaseChannel: "beta" }), {
    schemaVersion: 1,
    version: "0.1.5",
    channel: "beta",
    testHooks: false,
    nativeFingerprint: null,
  });
  const fingerprint = "a".repeat(64);
  assert.equal(
    validateBuildInfo(JSON.stringify({ ...JSON.parse(output), nativeFingerprint: fingerprint }), {
      version: "0.1.5",
      requestedReleaseChannel: "beta",
    }).nativeFingerprint,
    fingerprint,
  );
  assert.throws(
    () =>
      validateBuildInfo(JSON.stringify({ ...JSON.parse(output), nativeFingerprint: "dev" }), {
        version: "0.1.5",
        requestedReleaseChannel: "beta",
      }),
    /invalid native fingerprint/,
  );

  assert.throws(
    () => validateBuildInfo(output, { version: "0.1.6", requestedReleaseChannel: "beta" }),
    /binary version 0\.1\.5 does not match build version 0\.1\.6/,
  );
  assert.throws(
    () => validateBuildInfo(output, { version: "0.1.5", requestedReleaseChannel: "stable" }),
    /compiled channel beta does not match requested stable/,
  );
  assert.throws(
    () =>
      validateBuildInfo(JSON.stringify({ schemaVersion: 1, version: "0.1.5", channel: "beta", testHooks: true }), {
        version: "0.1.5",
        requestedReleaseChannel: "beta",
      }),
    /production binary reports test hooks enabled/,
  );
});

test("malformed or widened production binary probe output is rejected", () => {
  assert.throws(
    () => validateBuildInfo("not json", { version: "0.1.5", requestedReleaseChannel: "dev" }),
    /valid JSON/,
  );
  assert.throws(
    () =>
      validateBuildInfo(
        JSON.stringify({ schemaVersion: 2, version: "0.1.5", channel: "development", testHooks: false }),
        { version: "0.1.5", requestedReleaseChannel: "dev" },
      ),
    /unsupported schema version 2/,
  );
  assert.throws(
    () =>
      validateBuildInfo(
        JSON.stringify({
          schemaVersion: 1,
          version: "0.1.5",
          channel: "development",
          testHooks: false,
          unexpected: true,
        }),
        { version: "0.1.5", requestedReleaseChannel: "dev" },
      ),
    /unexpected fields: unexpected/,
  );
});
