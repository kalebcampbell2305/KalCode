// Builds the Windows x64 installer (NSIS per-user `-setup.exe`) from a clean commit and stages it
// in dist/release/<version>/ with a build record (build.json): version, commit, date, size,
// SHA-256 and redacted signature status. Production artifacts are signed through Microsoft's
// Artifact Signing SignTool integration; certificate subject details are never written.
//
// Usage: pnpm release:build --channel stable|beta|dev [--features <cargo features>]
//   (Windows only)
//        pnpm release:build --channel dev --unsigned-local
//   (explicit local simulation only; never eligible to publish)
//
// Windows release builds include `kalvoice-whisper` by default. `--features` replaces that default
// for bounded beta/dev builds; stable builds always require KalVoice's local engine. Whisper needs
// libclang via LIBCLANG_PATH — see docs/DEVELOPMENT.md. Exact compiled features are recorded.
//
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyComponentNotices } from "./component-notices.mjs";
import {
  GUARDIAN_FILENAME,
  guardianBuildArgs,
  guardianBundleOverlay,
  guardianSignatureEvidence,
} from "./guardian-packaging.mjs";
import {
  appVersion,
  assertCleanTree,
  capture,
  DESKTOP_DIR,
  fail,
  formatBytes,
  headCommit,
  powershellJson,
  productName,
  ROOT,
  readJson,
  run,
  sha256File,
  stagingDir,
  TARGET_DIR,
  TAURI_CONF,
  writeJson,
} from "./lib.mjs";
import {
  buildChannelContract,
  buildEnvironment,
  parseReleaseChannelArgs,
  validateBuildInfo,
  validateReleaseBuildArgs,
} from "./release-channel.mjs";
import {
  ARTIFACT_SIGNING,
  artifactSigningMetadata,
  authenticodeIdentityOids,
  authenticodeStatus,
  buildSigningOverlay,
  expectedWindowsInstallerFile,
  findArtifactSigningTools,
  parseSigningMode,
  signingEnvironment,
  signTarget,
  timestampedAuthenticodeIsValid,
} from "./signing.mjs";
import { assertUpdaterKeyReady, signUpdaterArtifact, UPDATER_SIGNER_BINARY } from "./updater-signing.mjs";

const WINDOWS_KALVOICE_FEATURE = "kalvoice-whisper";
const WINDOWS_NOTICE_RESOURCE_PATH = "third_party/kalvoice-notices";
const WINDOWS_NOTICE_RESOURCE_SOURCE = "../../../third_party/kalvoice-notices/";
const WINDOWS_UPDATER_TARGET = "windows-x86_64";

let channel;
try {
  validateReleaseBuildArgs(process.argv.slice(2));
  channel = parseReleaseChannelArgs(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (process.platform !== "win32") fail("The Windows installer can only be built on Windows.");

let signingMode;
let updaterPublicKey = null;
try {
  signingMode = parseSigningMode(process.argv.slice(2), channel.requestedReleaseChannel);
  if (signingMode.sign) {
    findArtifactSigningTools({ env: signingEnvironment(process.env) });
    updaterPublicKey = assertUpdaterKeyReady();
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const featuresArg = process.argv.indexOf("--features");
const features =
  featuresArg === -1
    ? [WINDOWS_KALVOICE_FEATURE]
    : (process.argv[featuresArg + 1] ?? "")
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
for (const feature of features) {
  if (!/^[a-z0-9-]+$/.test(feature)) fail(`Invalid cargo feature name: ${feature}`);
  if (feature === "e2e") fail("The e2e feature enables test hooks and must never be in a release build.");
}
if (new Set(features).size !== features.length) fail("Cargo features must not be duplicated.");
const kalvoiceLocalSttIncluded = features.includes(WINDOWS_KALVOICE_FEATURE);
if (channel.requestedReleaseChannel === "stable" && !kalvoiceLocalSttIncluded) {
  fail("stable Windows releases require the kalvoice-whisper local STT engine");
}

assertCleanTree("A release build");
const version = appVersion();
const commit = headCommit();
const product = productName();
if (product !== "KalCode") fail(`release productName must remain KalCode (found ${product})`);
const conf = readJson(TAURI_CONF);
const noticeResources = conf.bundle?.resources;
if (
  noticeResources === null ||
  typeof noticeResources !== "object" ||
  Array.isArray(noticeResources) ||
  Object.keys(noticeResources).length !== 1 ||
  noticeResources[WINDOWS_NOTICE_RESOURCE_SOURCE] !== `${WINDOWS_NOTICE_RESOURCE_PATH}/`
) {
  fail("bundle.resources must contain only the pinned KalVoice notice corpus");
}
let noticeEvidence;
try {
  noticeEvidence = await verifyComponentNotices();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const webviewInstallMode = conf.bundle?.windows?.webviewInstallMode?.type;
if (webviewInstallMode !== "downloadBootstrapper") {
  fail(`bundle.windows.webviewInstallMode must stay "downloadBootstrapper" (found ${webviewInstallMode}).`);
}
const installMode = conf.bundle?.windows?.nsis?.installMode ?? "currentUser";
if (installMode !== "currentUser") fail(`NSIS installMode must be "currentUser" (found ${installMode}).`);

let file;
try {
  file = expectedWindowsInstallerFile(version);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const bundled = join(TARGET_DIR, "release", "bundle", "nsis", file);
const builtApp = join(TARGET_DIR, "release", "kalcode.exe");
const builtGuardian = join(TARGET_DIR, "release", GUARDIAN_FILENAME);
const startedAt = Date.now();

console.log(`Building ${product} ${version} for Windows x64 from ${commit.slice(0, 12)}…`);
const tauriArgs = ["--filter", "@kalcode/desktop", "tauri", "build", "--bundles", "nsis"];
if (features.length > 0) tauriArgs.push("--features", features.join(","));
let signingWorkspace = null;
let publisherIdentityOids = [];
let publisherIdentityBound = false;
let guardianSignature = null;
let guardianSha256 = null;
let childEnvironment = buildEnvironment(process.env, channel.compiledChannel);
let buildFailure = null;
try {
  signingWorkspace = mkdtempSync(join(tmpdir(), "kalcode-release-signing-"));
  const metadataPath = join(signingWorkspace, "metadata.json");
  const overlayPath = join(signingWorkspace, "tauri.bundle.json");
  let signingOverlay = {};
  // A signed byte from an earlier run must never be mistaken for this commit's guardian.
  rmSync(builtGuardian, { force: true });
  run("cargo", guardianBuildArgs(), {
    env: {
      ...childEnvironment,
      CARGO_TARGET_DIR: TARGET_DIR,
    },
  });
  if (!existsSync(builtGuardian) || !statSync(builtGuardian).isFile()) {
    throw new Error("the provider guardian build did not produce its canonical executable");
  }
  if (statSync(builtGuardian).mtimeMs < startedAt - 1000) {
    throw new Error("the provider guardian executable is stale");
  }
  const unsignedGuardianSignature = authenticodeStatus(builtGuardian, powershellJson);
  if (unsignedGuardianSignature.status !== "NotSigned" || unsignedGuardianSignature.timestamped) {
    throw new Error("the freshly built provider guardian must be unsigned before release signing");
  }
  if (signingMode.sign) {
    writeJson(metadataPath, artifactSigningMetadata());
    signingOverlay = buildSigningOverlay({
      nodePath: process.execPath,
      signerPath: join(ROOT, "tooling", "release", "sign-windows.mjs"),
    });
    childEnvironment = signingEnvironment(childEnvironment);
    childEnvironment.KALCODE_ARTIFACT_SIGNING_METADATA = metadataPath;
    childEnvironment.KALCODE_UPDATER_PUBLIC_KEY = updaterPublicKey;
    const probeSource = UPDATER_SIGNER_BINARY;
    const probePath = join(signingWorkspace, "publisher-identity-probe.exe");
    if (!existsSync(probeSource) || !statSync(probeSource).isFile()) {
      throw new Error("the KalCode-owned unsigned publisher identity probe source is unavailable");
    }
    const probeSourceSignature = authenticodeStatus(probeSource, powershellJson);
    if (probeSourceSignature.status !== "NotSigned" || probeSourceSignature.timestamped) {
      throw new Error("the publisher identity probe source must be unsigned before copying");
    }
    copyFileSync(probeSource, probePath);
    const unsignedProbeSignature = authenticodeStatus(probePath, powershellJson);
    if (unsignedProbeSignature.status !== "NotSigned" || unsignedProbeSignature.timestamped) {
      throw new Error("the disposable publisher identity probe must begin unsigned");
    }
    signTarget({ targetPath: probePath, metadataPath, env: childEnvironment });
    const probeSignature = authenticodeStatus(probePath, powershellJson);
    if (probeSignature.status !== "Valid" || !probeSignature.timestamped) {
      throw new Error("the publisher identity probe did not receive a valid timestamped signature");
    }
    publisherIdentityOids = authenticodeIdentityOids(probePath, powershellJson);
    if (publisherIdentityOids.length !== 1 || publisherIdentityOids[0] !== ARTIFACT_SIGNING.publisherIdentityOid) {
      throw new Error("the Artifact Signing certificate does not match the pinned KalCode publisher identity");
    }
    childEnvironment.KALCODE_AUTHENTICODE_IDENTITY_OIDS = ARTIFACT_SIGNING.publisherIdentityOid;
    signTarget({ targetPath: builtGuardian, metadataPath, env: childEnvironment });
    guardianSignature = guardianSignatureEvidence({
      signature: authenticodeStatus(builtGuardian, powershellJson),
      identityOids: authenticodeIdentityOids(builtGuardian, powershellJson),
      publisherIdentityOids,
      signingRequired: true,
    });
  } else {
    // Never let an unsigned local simulation inherit artifacts signed by an earlier build.
    rmSync(builtApp, { force: true });
    rmSync(bundled, { force: true });
    guardianSignature = guardianSignatureEvidence({
      signature: unsignedGuardianSignature,
      identityOids: [],
      publisherIdentityOids: [],
      signingRequired: false,
    });
    tauriArgs.push("--no-sign");
  }
  guardianSha256 = await sha256File(builtGuardian);
  writeJson(
    overlayPath,
    guardianBundleOverlay({
      guardianPath: builtGuardian,
      signingOverlay,
    }),
  );
  tauriArgs.push("--config", overlayPath);
  run("pnpm", tauriArgs, {
    env: {
      ...childEnvironment,
      CARGO_TARGET_DIR: TARGET_DIR,
    },
  });
} catch (error) {
  buildFailure = error;
} finally {
  if (signingWorkspace) rmSync(signingWorkspace, { recursive: true, force: true });
}
if (buildFailure) fail(buildFailure instanceof Error ? buildFailure.message : String(buildFailure));

if (!existsSync(bundled)) fail(`The bundler did not produce ${bundled}`);
if (!existsSync(builtApp)) fail(`The build did not produce ${builtApp}`);
if (!existsSync(builtGuardian)) fail(`The build did not retain ${builtGuardian}`);
if (statSync(bundled).mtimeMs < startedAt - 1000) fail(`${bundled} is stale (not written by this build).`);
if ((await sha256File(builtGuardian)) !== guardianSha256) {
  fail("the provider guardian changed while the application was being bundled");
}
const builtAppSignature = authenticodeStatus(builtApp, powershellJson);
const bundledSignature = authenticodeStatus(bundled, powershellJson);
if (signingMode.sign) {
  if (!timestampedAuthenticodeIsValid(builtAppSignature)) {
    fail("the final application executable is not validly signed and timestamped");
  }
  if (!timestampedAuthenticodeIsValid(bundledSignature)) {
    fail("the final bundled installer is not validly signed and timestamped");
  }
  const identities = [
    authenticodeIdentityOids(builtApp, powershellJson),
    authenticodeIdentityOids(bundled, powershellJson),
  ];
  publisherIdentityBound = identities.every(
    (identity) =>
      identity.length === publisherIdentityOids.length &&
      identity.every((oid, index) => oid === publisherIdentityOids[index]),
  );
  if (!publisherIdentityBound) fail("built Windows artifacts do not match the approved publisher identity");
} else if (
  builtAppSignature.status !== "NotSigned" ||
  builtAppSignature.timestamped ||
  bundledSignature.status !== "NotSigned" ||
  bundledSignature.timestamped
) {
  fail("the unsigned local simulation produced an unexpectedly signed build output");
}
let buildInfo;
try {
  buildInfo = validateBuildInfo(capture(builtApp, ["--build-info"]), {
    version,
    requestedReleaseChannel: channel.requestedReleaseChannel,
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
// The build must not have changed tracked files (e.g. a lockfile), or the artifact would not
// match the recorded commit.
assertCleanTree("After the build, the working tree");
if (headCommit() !== commit) fail("HEAD moved during the build.");

const outDir = stagingDir(version);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const staged = join(outDir, file);
copyFileSync(bundled, staged);
const updaterSignaturePath = `${staged}.sig`;
const updaterV2SignaturePath = `${staged}.windows-x86_64.sig`;
if (signingMode.sign) {
  signUpdaterArtifact({
    artifactPath: staged,
    signaturePath: updaterSignaturePath,
    version,
  });
  signUpdaterArtifact({
    artifactPath: staged,
    signaturePath: updaterV2SignaturePath,
    version,
    target: WINDOWS_UPDATER_TARGET,
    channel: channel.requestedReleaseChannel,
  });
  if (!existsSync(updaterSignaturePath) || statSync(updaterSignaturePath).size === 0) {
    fail("the updater signer did not produce the legacy Windows detached signature");
  }
  if (!existsSync(updaterV2SignaturePath) || statSync(updaterV2SignaturePath).size === 0) {
    fail("the updater signer did not produce the target-bound Windows detached signature");
  }
}

const size = statSync(staged).size;
const sha256 = await sha256File(staged);
const signature = authenticodeStatus(staged, powershellJson);
const signed = signature.status === "Valid";
if (signingMode.sign) {
  if (!signed || !signature.timestamped) {
    fail(`staged installer signature is ${signature.status} or has no trusted timestamp`);
  }
} else if (signature.status !== "NotSigned" || signature.timestamped) {
  fail("the unsigned local simulation produced an unexpectedly signed artifact");
}
let channelContract = buildChannelContract({
  requestedReleaseChannel: channel.requestedReleaseChannel,
  compiledChannel: buildInfo.channel,
  compiledChannelVerified: true,
  signed,
  signatureStatus: signature.status,
});
if (signingMode.localSimulation) {
  channelContract = {
    ...channelContract,
    releaseDescriptorEligible: false,
    releaseDescriptorBlockedReason: "unsigned_local_simulation",
  };
}

const record = {
  product,
  version,
  commit,
  features,
  kalvoice: {
    localSttFeature: WINDOWS_KALVOICE_FEATURE,
    localSttIncluded: kalvoiceLocalSttIncluded,
  },
  notices: {
    ...noticeEvidence,
    resourcePath: WINDOWS_NOTICE_RESOURCE_PATH,
    sourceVerifiedBeforeBuild: true,
  },
  builtAt: new Date().toISOString(),
  os: "windows",
  arch: "x64",
  kind: "nsis",
  file,
  size,
  sha256,
  signed,
  signatureStatus: signature.status,
  signing: {
    provider: signingMode.sign ? "azure-artifact-signing" : "none-local-simulation",
    timestamped: signature.timestamped,
    appTimestamped: builtAppSignature.timestamped,
    applicationVerifiedDuringBundle: timestampedAuthenticodeIsValid(builtAppSignature),
    publisherIdentityBound,
  },
  guardian: {
    file: GUARDIAN_FILENAME,
    sha256: guardianSha256,
    ...guardianSignature,
    bundledBesideApplication: true,
  },
  updater: {
    artifactFile: file,
    signatureFile: signingMode.sign ? `${file}.sig` : null,
    signatureStatus: signingMode.sign ? "Valid" : "NotSigned",
    cryptographicallyVerified: signingMode.sign,
    versionBound: signingMode.sign,
    publicKeyConfigured: signingMode.sign,
  },
  updaterV2: {
    schemaVersion: 2,
    artifactFile: file,
    signatureFile: signingMode.sign ? `${file}.windows-x86_64.sig` : null,
    signatureStatus: signingMode.sign ? "Valid" : "NotSigned",
    cryptographicallyVerified: signingMode.sign,
    versionBound: signingMode.sign,
    target: WINDOWS_UPDATER_TARGET,
    targetBound: signingMode.sign,
    channel: channel.requestedReleaseChannel,
    channelBound: signingMode.sign,
    publicKeyConfigured: signingMode.sign,
  },
  ...channelContract,
  compiledChannelVerification: {
    status: "verified",
    method: "build_info_probe_v1",
    schemaVersion: buildInfo.schemaVersion,
    version: buildInfo.version,
    channel: buildInfo.channel,
    testHooks: buildInfo.testHooks,
  },
  installMode,
  webviewInstallMode,
  toolchain: {
    node: process.version,
    rustc: capture("rustc", ["--version"]),
    tauriCli: capture("pnpm", ["--filter", "@kalcode/desktop", "exec", "tauri", "--version"], { cwd: DESKTOP_DIR }),
  },
};
writeJson(join(outDir, "build.json"), record);

console.log(`
Built ${file}
  version    ${version}
  commit     ${commit}
  size       ${formatBytes(size)}
  sha256     ${sha256}
  signature  ${record.signatureStatus}${signed ? " (timestamped)" : " (unsigned local simulation)"}
  channel    ${record.requestedReleaseChannel} (compiled: ${record.compiledChannel})
  descriptor ${record.releaseDescriptorEligible ? "eligible" : `blocked: ${record.releaseDescriptorBlockedReason}`}
  staged at  ${staged}

Next: pnpm release:verify`);
