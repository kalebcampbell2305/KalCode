const PRODUCT_TO_COMPILED = Object.freeze({
  stable: "stable",
  beta: "beta",
  dev: "development",
});

function channelError(message) {
  return new Error(`release channel: ${message}`);
}

export function validateReleaseBuildArgs(argv) {
  let channelCount = 0;
  let featuresCount = 0;
  let unsignedCount = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--channel" || arg === "--features") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw channelError(`${arg} needs one value`);
      if (arg === "--channel") channelCount += 1;
      else featuresCount += 1;
      index += 1;
    } else if (arg.startsWith("--channel=")) {
      channelCount += 1;
    } else if (arg === "--unsigned-local") {
      unsignedCount += 1;
    } else {
      throw channelError(`unknown build option "${arg}"`);
    }
  }
  if (channelCount > 1) throw channelError("--channel may be specified only once");
  if (featuresCount > 1) throw channelError("--features may be specified only once");
  if (unsignedCount > 1) throw channelError("--unsigned-local may be specified only once");
}

/**
 * Reads the required product channel without treating the process environment as configuration.
 * Other build arguments are intentionally ignored here and remain owned by the build script.
 */
export function parseReleaseChannelArgs(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--channel") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw channelError("--channel needs one of stable, beta, or dev");
      }
      values.push(value);
      index += 1;
    } else if (arg.startsWith("--channel=")) {
      values.push(arg.slice("--channel=".length));
    }
  }

  if (values.length === 0) throw channelError("--channel stable|beta|dev is required");
  if (values.length > 1) throw channelError("--channel may be specified only once");

  const requestedReleaseChannel = values[0];
  const compiledChannel = PRODUCT_TO_COMPILED[requestedReleaseChannel];
  if (compiledChannel === undefined) {
    throw channelError(`Unknown release channel "${requestedReleaseChannel}"; use stable, beta, or dev`);
  }
  return { requestedReleaseChannel, compiledChannel };
}

/** Creates the exact child environment used by Cargo, replacing any case variant on Windows. */
export function buildEnvironment(baseEnvironment, compiledChannel) {
  if (!Object.values(PRODUCT_TO_COMPILED).includes(compiledChannel)) {
    throw channelError(`Unknown compiled channel "${compiledChannel}"`);
  }
  const environment = {};
  for (const [name, value] of Object.entries(baseEnvironment)) {
    if (name.toUpperCase() !== "KALCODE_CHANNEL") environment[name] = value;
  }
  environment.KALCODE_CHANNEL = compiledChannel;
  return environment;
}

/** Fails closed when a post-build probe reports a different native `AppInfo.channel`. */
export function validateCompiledChannel(contract, reportedChannel) {
  const expected = PRODUCT_TO_COMPILED[contract.requestedReleaseChannel];
  if (expected === undefined) throw channelError(`Unknown release channel "${contract.requestedReleaseChannel}"`);
  if (contract.compiledChannel !== expected) {
    throw channelError(
      `compiled channel ${contract.compiledChannel} does not match requested ${contract.requestedReleaseChannel} (expected ${expected})`,
    );
  }
  if (reportedChannel !== expected) {
    throw channelError(
      `compiled channel ${reportedChannel} does not match requested ${contract.requestedReleaseChannel} (expected ${expected})`,
    );
  }
  return reportedChannel;
}

/** Validates the exact JSON contract emitted by `kalcode.exe --build-info`. */
export function validateBuildInfo(output, { version, requestedReleaseChannel }) {
  let info;
  try {
    info = JSON.parse(output);
  } catch {
    throw channelError("production binary --build-info output is not valid JSON");
  }
  if (info === null || typeof info !== "object" || Array.isArray(info)) {
    throw channelError("production binary --build-info output must be a JSON object");
  }

  const expectedFields = new Set(["schemaVersion", "version", "channel", "testHooks", "nativeFingerprint"]);
  const unexpected = Object.keys(info).filter((field) => !expectedFields.has(field));
  if (unexpected.length > 0)
    throw channelError(`production binary --build-info has unexpected fields: ${unexpected.join(", ")}`);
  if (info.schemaVersion !== 1) {
    throw channelError(`production binary --build-info has unsupported schema version ${String(info.schemaVersion)}`);
  }
  if (info.version !== version) {
    throw channelError(`binary version ${String(info.version)} does not match build version ${version}`);
  }
  const compiledChannel = PRODUCT_TO_COMPILED[requestedReleaseChannel];
  validateCompiledChannel({ requestedReleaseChannel, compiledChannel }, info.channel);
  if (info.testHooks !== false) throw channelError("production binary reports test hooks enabled");
  // Live Update's contract: 64 hex characters, or null in a build made without the release tooling.
  const nativeFingerprint = info.nativeFingerprint ?? null;
  if (nativeFingerprint !== null && !/^[0-9a-f]{64}$/.test(nativeFingerprint)) {
    throw channelError("production binary reports an invalid native fingerprint");
  }

  return {
    schemaVersion: info.schemaVersion,
    version: info.version,
    channel: info.channel,
    testHooks: info.testHooks,
    nativeFingerprint,
  };
}

/**
 * Release descriptor eligibility is deliberately stricter than local build eligibility. An
 * unsigned developer build may exist, but no updater/publisher may describe it as installable.
 */
export function buildChannelContract({
  requestedReleaseChannel,
  compiledChannel,
  compiledChannelVerified,
  signed,
  signatureStatus,
}) {
  const expected = PRODUCT_TO_COMPILED[requestedReleaseChannel];
  if (expected === undefined) throw channelError(`Unknown release channel "${requestedReleaseChannel}"`);
  if (compiledChannel !== expected) {
    throw channelError(
      `compiled channel ${compiledChannel} does not match requested ${requestedReleaseChannel} (expected ${expected})`,
    );
  }

  let releaseDescriptorBlockedReason = null;
  if (!signed && signatureStatus === "NotSigned") releaseDescriptorBlockedReason = "unsigned_build";
  else if (!signed || signatureStatus !== "Valid") releaseDescriptorBlockedReason = "signature_not_valid";
  else if (!compiledChannelVerified) releaseDescriptorBlockedReason = "compiled_channel_not_verified";

  return {
    requestedReleaseChannel,
    compiledChannel,
    releaseDescriptorEligible: releaseDescriptorBlockedReason === null,
    releaseDescriptorBlockedReason,
  };
}
