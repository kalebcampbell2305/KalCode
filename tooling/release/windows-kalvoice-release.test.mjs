import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const buildSource = readFileSync(join(import.meta.dirname, "build-windows.mjs"), "utf8");
const verifySource = readFileSync(join(import.meta.dirname, "verify-windows.mjs"), "utf8");
const tauriConfig = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
);
const desktopManifest = readFileSync(
  join(import.meta.dirname, "..", "..", "apps", "desktop", "src-tauri", "Cargo.toml"),
  "utf8",
);

function kalvoiceEvidenceValidator() {
  const start = verifySource.indexOf("function validateWindowsKalVoiceEvidence");
  const end = verifySource.indexOf("\nfunction finish", start);
  assert.ok(start >= 0 && end > start, "KalVoice evidence validator must remain independently testable");
  return new Function(
    `const WINDOWS_KALVOICE_FEATURE = "kalvoice-whisper";\n${verifySource.slice(start, end)}\nreturn validateWindowsKalVoiceEvidence;`,
  )();
}

function updaterV2EvidenceValidator() {
  const start = verifySource.indexOf("function validateWindowsUpdaterV2Evidence");
  const end = verifySource.indexOf("\nfunction finish", start);
  assert.ok(start >= 0 && end > start, "Windows updater v2 evidence validator must remain independently testable");
  return new Function(
    `const WINDOWS_UPDATER_TARGET = "windows-x86_64";\n${verifySource.slice(start, end)}\nreturn validateWindowsUpdaterV2Evidence;`,
  )();
}

function noticeEvidenceValidator() {
  const start = verifySource.indexOf("function validateWindowsNoticeEvidence");
  const end = verifySource.indexOf("\nfunction validateWindowsUpdaterV2Evidence", start);
  assert.ok(start >= 0 && end > start, "Windows notice evidence validator must remain independently testable");
  return new Function(
    `const WINDOWS_NOTICE_RESOURCE_PATH = "third_party/kalvoice-notices";\n${verifySource.slice(start, end)}\nreturn validateWindowsNoticeEvidence;`,
  )();
}

test("Windows release defaults include the local KalVoice engine", () => {
  assert.match(desktopManifest, /^kalvoice-whisper = \["kalcode-kalvoice\/whisper"\]$/m);
  assert.match(buildSource, /const WINDOWS_KALVOICE_FEATURE = "kalvoice-whisper"/);
  assert.match(
    buildSource,
    /featuresArg === -1\s*\? \[WINDOWS_KALVOICE_FEATURE\]/,
    "the no-override path must compile the local engine",
  );
  assert.match(buildSource, /const kalvoiceLocalSttIncluded = features\.includes\(WINDOWS_KALVOICE_FEATURE\)/);
  assert.match(buildSource, /tauriArgs\.push\("--features", features\.join\(","\)\)/);
});

test("stable builds fail before compilation if an explicit feature set omits KalVoice", () => {
  const stableGate = buildSource.indexOf('channel.requestedReleaseChannel === "stable" && !kalvoiceLocalSttIncluded');
  const build = buildSource.indexOf('run("pnpm", tauriArgs');
  assert.ok(stableGate >= 0 && build > stableGate);
  assert.match(buildSource, /stable Windows releases require the kalvoice-whisper local STT engine/);
});

test("Windows bundles the exact checked-in KalVoice notices and verifies them before compilation", () => {
  assert.deepEqual(tauriConfig.bundle.resources, {
    "../../../third_party/kalvoice-notices/": "third_party/kalvoice-notices/",
  });
  const noticeVerification = buildSource.indexOf("await verifyComponentNotices()");
  const build = buildSource.indexOf('run("pnpm", tauriArgs');
  assert.ok(noticeVerification >= 0 && build > noticeVerification);
  assert.match(buildSource, /sourceVerifiedBeforeBuild: true/);
});

test("Windows verification rejects substituted notice evidence and verifies installed notice bytes", () => {
  const validate = noticeEvidenceValidator();
  const source = {
    schemaVersion: 1,
    noticeCount: 4,
    componentCount: 7,
    files: ["a.txt", "b.txt", "c.txt", "d.txt"],
  };
  const build = {
    notices: {
      ...source,
      resourcePath: "third_party/kalvoice-notices",
      sourceVerifiedBeforeBuild: true,
    },
  };
  assert.deepEqual(validate(build, source), build.notices);
  for (const [field, value] of [
    ["resourcePath", "notices"],
    ["componentCount", 6],
    ["sourceVerifiedBeforeBuild", false],
  ]) {
    assert.throws(() => validate({ notices: { ...build.notices, [field]: value } }, source), /notice evidence/);
  }
  assert.match(
    verifySource,
    /verifyComponentNotices\(\{\s*noticeDirectory: join\(installDir, \.\.\.WINDOWS_NOTICE_RESOURCE_PATH\.split\("\/"\)\),\s*\}\)/,
  );
  assert.match(verifySource, /allInstallPassesVerified/);
});

test("build evidence records actual KalVoice compilation without claiming an absent engine", () => {
  assert.match(
    buildSource,
    /kalvoice:\s*\{\s*localSttFeature: WINDOWS_KALVOICE_FEATURE,\s*localSttIncluded: kalvoiceLocalSttIncluded,\s*\}/,
  );
  assert.doesNotMatch(buildSource, /localSttIncluded:\s*true/);
});

test("verification validates KalVoice evidence and rejects a stable record without the engine", () => {
  const evidenceCheck = verifySource.indexOf("validateWindowsKalVoiceEvidence(build)");
  const installerRead = verifySource.indexOf("statSync(installer)");
  assert.ok(evidenceCheck >= 0 && installerRead > evidenceCheck);
  assert.match(verifySource, /build\.features\.includes\(WINDOWS_KALVOICE_FEATURE\)/);
  assert.match(verifySource, /build\.requestedReleaseChannel === "stable" && !included/);
  assert.match(verifySource, /stable Windows release does not include the local KalVoice STT engine/);
  assert.match(verifySource, /report\.kalvoice = kalvoiceEvidence/);
});

test("verification behavior rejects stable omission while reporting beta and dev honestly", () => {
  const validate = kalvoiceEvidenceValidator();
  const evidence = (channel, features, localSttIncluded) => ({
    requestedReleaseChannel: channel,
    features,
    kalvoice: { localSttFeature: "kalvoice-whisper", localSttIncluded },
  });

  assert.deepEqual(validate(evidence("stable", ["kalvoice-whisper"], true)), {
    localSttFeature: "kalvoice-whisper",
    localSttIncluded: true,
    requiredForChannel: true,
  });
  assert.throws(() => validate(evidence("stable", [], false)), /does not include/);
  for (const channel of ["beta", "dev"]) {
    assert.deepEqual(validate(evidence(channel, [], false)), {
      localSttFeature: "kalvoice-whisper",
      localSttIncluded: false,
      requiredForChannel: false,
    });
  }
  assert.throws(() => validate(evidence("beta", [], true)), /truthfully describe/);
  assert.throws(
    () => validate(evidence("dev", ["kalvoice-whisper", "kalvoice-whisper"], true)),
    /invalid or duplicate/,
  );
});

test("production builds emit legacy v1 and target-channel-bound v2 signatures", () => {
  assert.match(buildSource, /const WINDOWS_UPDATER_TARGET = "windows-x86_64"/);
  assert.match(buildSource, /const updaterV2SignaturePath = `\$\{staged\}\.windows-x86_64\.sig`/);
  assert.match(
    buildSource,
    /signaturePath: updaterSignaturePath,\s*version,\s*\}\);[\s\S]*signaturePath: updaterV2SignaturePath,\s*version,\s*target: WINDOWS_UPDATER_TARGET,\s*channel: channel\.requestedReleaseChannel,/,
  );
  assert.match(
    buildSource,
    /updaterV2:\s*\{\s*schemaVersion: 2,\s*artifactFile: file,\s*signatureFile: signingMode\.sign \? `\$\{file\}\.windows-x86_64\.sig` : null,/,
  );
});

test("Windows verification independently verifies legacy and v2 updater signatures", () => {
  const legacy = verifySource.indexOf("signaturePath: join(outDir, build.updater.signatureFile)");
  const bound = verifySource.indexOf("signaturePath: join(outDir, updaterV2.signatureFile)");
  assert.ok(legacy >= 0 && bound > legacy);
  assert.match(verifySource, /target: updaterV2\.target,\s*channel: updaterV2\.channel,\s*\}\);/);
  assert.match(verifySource, /report\.updaterV2 = \{/);
});

test("v2 updater evidence rejects filename, target, channel, and binding substitution", () => {
  const validate = updaterV2EvidenceValidator();
  const build = {
    file: "KalCode_1.2.3_x64-setup.exe",
    requestedReleaseChannel: "stable",
    updaterV2: {
      schemaVersion: 2,
      artifactFile: "KalCode_1.2.3_x64-setup.exe",
      signatureFile: "KalCode_1.2.3_x64-setup.exe.windows-x86_64.sig",
      signatureStatus: "Valid",
      cryptographicallyVerified: true,
      versionBound: true,
      target: "windows-x86_64",
      targetBound: true,
      channel: "stable",
      channelBound: true,
      publicKeyConfigured: true,
    },
  };
  assert.deepEqual(validate(build), build.updaterV2);
  for (const [field, value] of [
    ["signatureFile", "KalCode_1.2.3_x64-setup.exe.sig"],
    ["target", "darwin-aarch64"],
    ["channel", "dev"],
    ["targetBound", false],
    ["channelBound", false],
  ]) {
    assert.throws(
      () => validate({ ...build, updaterV2: { ...build.updaterV2, [field]: value } }),
      /updater v2 evidence/,
    );
  }
});
