import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(join(import.meta.dirname, "build-windows.mjs"), "utf8");
const releaseLibrary = readFileSync(join(import.meta.dirname, "lib.mjs"), "utf8");
const publishSource = readFileSync(join(import.meta.dirname, "publish.mjs"), "utf8");
const signerSource = readFileSync(join(import.meta.dirname, "sign-windows.mjs"), "utf8");
const updaterManifestSource = readFileSync(join(import.meta.dirname, "updater-manifest.mjs"), "utf8");
const verifierSource = readFileSync(join(import.meta.dirname, "verify-windows.mjs"), "utf8");

test("signed release builds fail before compilation without the matching DPAPI updater key", () => {
  const keyCheck = source.indexOf("updaterPublicKey = assertUpdaterKeyReady()");
  const build = source.indexOf('run("pnpm", tauriArgs');
  assert.ok(keyCheck >= 0 && build > keyCheck);
});

test("signed release builds embed the public key and sign the exact staged installer", () => {
  assert.match(source, /childEnvironment\.KALCODE_UPDATER_PUBLIC_KEY = updaterPublicKey/);
  assert.match(source, /signTarget\(\{ targetPath: probePath/);
  assert.match(source, /publisherIdentityOids\[0\] !== ARTIFACT_SIGNING\.publisherIdentityOid/);
  assert.match(source, /childEnvironment\.KALCODE_AUTHENTICODE_IDENTITY_OIDS = ARTIFACT_SIGNING\.publisherIdentityOid/);
  assert.match(source, /publisherIdentityBound/);
  assert.match(source, /artifactPath: staged/);
  assert.match(source, /signaturePath: updaterSignaturePath/);
  assert.match(source, /cryptographicallyVerified: signingMode\.sign/);
  assert.match(source, /versionBound: signingMode\.sign/);
  assert.doesNotMatch(source, /publisherIdentityOids[,:]\s*publisherIdentityOids/);
});

test("temporary publisher identity evidence is cleaned when signing setup fails", () => {
  const workspaceDeclaration = source.indexOf("let signingWorkspace = null");
  const cleanupTry = source.indexOf("try {", workspaceDeclaration);
  const signingSetup = source.indexOf("if (signingMode.sign)", workspaceDeclaration);
  const buildRun = source.indexOf('run("pnpm", tauriArgs', signingSetup);
  const cleanupFinally = source.indexOf("} finally {", buildRun);
  const cleanup = source.indexOf("rmSync(signingWorkspace", cleanupFinally);
  assert.ok(
    workspaceDeclaration >= 0 &&
      cleanupTry > workspaceDeclaration &&
      signingSetup > cleanupTry &&
      buildRun > signingSetup &&
      cleanupFinally > buildRun &&
      cleanup > cleanupFinally,
  );
});

test("publisher identity probing rejects a pre-signed source before copying it", () => {
  assert.doesNotMatch(source, /where\.exe/i);
  const unsignedCheck = source.indexOf('probeSourceSignature.status !== "NotSigned"');
  const copy = source.indexOf("copyFileSync(probeSource, probePath)");
  const sign = source.indexOf("signTarget({ targetPath: probePath");
  assert.ok(unsignedCheck >= 0 && copy > unsignedCheck && sign > copy);
});

test("shared release commands suppress Windows subprocess windows", () => {
  assert.match(releaseLibrary, /export function run[\s\S]*windowsHide: true/);
  assert.match(releaseLibrary, /export function capture[\s\S]*windowsHide: true/);
});

test("every signed artifact and clean-machine verification enforce the durable publisher identity", () => {
  assert.match(signerSource, /parsePublisherIdentityEnvironment/);
  assert.match(signerSource, /authenticodeIdentityOids/);
  assert.match(signerSource, /does not match the approved Artifact Signing publisher identity/);
  assert.match(verifierSource, /durable Artifact Signing publisher identity/);
  assert.match(verifierSource, /sameAuthenticodeSigner/);
});

test("publishing verifies content-addressed objects before atomically advancing D1", () => {
  const immutableReadback = publishSource.indexOf('upload.name === "immutable updater version descriptor"');
  const versionClaim = publishSource.indexOf("buildVersionClaimStatement(pointerCandidate)");
  const pointerAdvance = publishSource.indexOf(
    "buildPointerAdvanceStatement(pointerCandidate, authoritativePreviousRow)",
  );
  const publicReadback = publishSource.indexOf("const verificationNonce", pointerAdvance);
  assert.ok(immutableReadback >= 0 && versionClaim > immutableReadback);
  assert.ok(pointerAdvance > versionClaim && publicReadback > pointerAdvance);
  assert.match(publishSource, /releaseAuthority !== "d1-v1"/);
  assert.match(publishSource, /boundedJsonFetch/);
});

test("the real Windows producer supplies the aggregate publisher's target-and-channel-bound signature", () => {
  assert.match(source, /const updaterV2SignaturePath = `\$\{staged\}\.windows-x86_64\.sig`/);
  assert.match(source, /signaturePath: updaterV2SignaturePath,[\s\S]*target: WINDOWS_UPDATER_TARGET/);
  assert.match(source, /target: WINDOWS_UPDATER_TARGET,[\s\S]*channel: channel\.requestedReleaseChannel/);
  assert.match(source, /signatureFile: signingMode\.sign \? `\$\{file\}\.windows-x86_64\.sig` : null/);
  assert.match(publishSource, /windowsUpdaterV2Problems\(windows\.build, windows\.verify\)/);
  assert.match(publishSource, /safeFile \? `\$\{safeFile\}\$\{mode === "local" \? "" : "\.windows-x86_64"\}\.sig`/);
  assert.match(
    updaterManifestSource,
    /signatureTarget \? `\$\{file\}\.\$\{signatureTarget\}\.sig` : `\$\{file\}\.sig`/,
  );
  assert.match(
    updaterManifestSource,
    /createWindowsManifest\([\s\S]*\{ \.\.\.input, requestedChannel, publishedAt, notes, qaPhase \},[\s\S]*input\.target/,
  );
});

test("preview publication verifies its own updater channel without asserting the stable download route", () => {
  const preflight = publishSource.indexOf('if (channel === "stable")');
  const stableProbe = publishSource.indexOf("boundedJsonFetch(LIVE_MANIFEST_URL)", preflight);
  const channelProbe = publishSource.indexOf(
    "boundedJsonFetch(`https://kalcoded.com/releases/updater/" + "$" + "{channel}.json`)",
    preflight,
  );
  const finalVerification = publishSource.indexOf("const verificationNonce", channelProbe);
  const finalGate = publishSource.indexOf('if (channel === "stable")', finalVerification);
  const finalDownloadProbe = publishSource.indexOf(
    "boundedJsonFetch(`" + "$" + "{LIVE_MANIFEST_URL}?release_verify=",
    finalGate,
  );
  assert.ok(preflight >= 0 && stableProbe > preflight && channelProbe > stableProbe);
  assert.ok(finalVerification > channelProbe && finalGate > finalVerification && finalDownloadProbe > finalGate);
  for (const write of publishSource.matchAll(/writeJson\(WEBSITE_MANIFEST, manifest\)/g)) {
    const stableGuard = publishSource.lastIndexOf('if (channel === "stable")', write.index);
    assert.ok(stableGuard >= 0 && write.index - stableGuard < 100);
  }
});
