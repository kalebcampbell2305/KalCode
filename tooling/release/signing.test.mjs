import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  ARTIFACT_SIGNING,
  artifactSigningIdentityMatchesPinned,
  artifactSigningMetadata,
  authenticodeIdentityOids,
  authenticodeStatus,
  buildSigningOverlay,
  buildSignToolArgs,
  expectedWindowsInstallerFile,
  findArtifactSigningTools,
  normalizeArtifactSigningIdentityOids,
  normalizeAuthenticodeResult,
  parsePublisherIdentityEnvironment,
  parseSigningMode,
  postBundleApplicationSigningAction,
  publicSigningProblems,
  publicVerificationProblems,
  releaseProcessOptions,
  sameAuthenticodeSigner,
  signingEnvironment,
  signTarget,
  timestampedAuthenticodeIsValid,
  updaterSigningEvidenceIsExact,
  validateSigningTarget,
} from "./signing.mjs";

const fixturePath = (...parts) => join(process.platform === "win32" ? "C:\\" : "/", ...parts);

const subscriberIdentityOid = "1.3.6.1.4.1.311.97.990309390.766961637.194916062.941502583";
const genericArtifactSigningOid = "1.3.6.1.4.1.311.97.1.0";
const guardianEvidence = {
  file: "kalcode-provider-guardian.exe",
  sha256: "c".repeat(64),
  signed: true,
  signatureStatus: "Valid",
  timestamped: true,
  publisherIdentityBound: true,
  bundledBesideApplication: true,
};
const hookEvidence = {
  file: "kalcode-hook.exe",
  sha256: "d".repeat(64),
  signed: true,
  signatureStatus: "Valid",
  timestamped: true,
  publisherIdentityBound: true,
  bundledBesideApplication: true,
};

test("release subprocesses are hidden and bounded", () => {
  assert.deepEqual(releaseProcessOptions({ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
    windowsHide: true,
  });
});

test("release evidence accepts only a valid timestamped Authenticode result", () => {
  assert.equal(timestampedAuthenticodeIsValid({ status: "Valid", timestamped: true }), true);
  assert.equal(timestampedAuthenticodeIsValid({ status: "Valid", timestamped: false }), false);
  assert.equal(timestampedAuthenticodeIsValid({ status: "HashMismatch", timestamped: true }), false);
  assert.equal(timestampedAuthenticodeIsValid(null), false);
});

test("post-bundle application signing repairs only Tauri's unsigned restore", () => {
  assert.equal(postBundleApplicationSigningAction({ status: "NotSigned", timestamped: false }), "sign");
  assert.equal(postBundleApplicationSigningAction({ status: "Valid", timestamped: true }), "accept");
  for (const evidence of [
    { status: "NotSigned", timestamped: true },
    { status: "Valid", timestamped: false },
    { status: "HashMismatch", timestamped: false },
    { status: "Unknown", timestamped: false },
    null,
  ]) {
    assert.throws(() => postBundleApplicationSigningAction(evidence), /unexpected Authenticode state/);
  }
});

test("release installer names are derived from canonical SemVer only", () => {
  assert.equal(expectedWindowsInstallerFile("1.2.3"), "KalCode_1.2.3_x64-setup.exe");
  assert.equal(expectedWindowsInstallerFile("1.2.3-beta.1"), "KalCode_1.2.3-beta.1_x64-setup.exe");
  assert.throws(() => expectedWindowsInstallerFile("../private"), /SemVer/);
  assert.equal(expectedWindowsInstallerFile("0.1.7+779"), "KalCode_0.1.7_build779_x64-setup.exe");
  assert.throws(() => expectedWindowsInstallerFile("0.1.7+0779"), /SemVer/);
});

test("updater signing evidence has a closed redacted schema", () => {
  const evidence = {
    artifactFile: "KalCode_1.2.3_x64-setup.exe",
    signatureFile: "KalCode_1.2.3_x64-setup.exe.sig",
    signatureStatus: "Valid",
    cryptographicallyVerified: true,
    versionBound: true,
    publicKeyConfigured: true,
  };
  assert.equal(updaterSigningEvidenceIsExact(evidence, evidence.artifactFile), true);
  assert.equal(updaterSigningEvidenceIsExact({ ...evidence, privateKey: "forbidden" }, evidence.artifactFile), false);
});

test("Artifact Signing metadata identifies only the approved East US account and profile", () => {
  assert.deepEqual(artifactSigningMetadata(), {
    Endpoint: "https://eus.codesigning.azure.net/",
    CodeSigningAccountName: "kalcodesigning",
    CertificateProfileName: "kalcodewindows",
  });
  assert.equal(ARTIFACT_SIGNING.publisherIdentityOid, "1.3.6.1.4.1.311.97.208143396.135769116.211620001.449325895");
  assert.equal(ARTIFACT_SIGNING.timestampUrl, "http://timestamp.acs.microsoft.com");
});

test("clean-machine verification accepts only the pinned Artifact Signing subscriber identity", () => {
  assert.equal(artifactSigningIdentityMatchesPinned([ARTIFACT_SIGNING.publisherIdentityOid]), true);
  assert.equal(artifactSigningIdentityMatchesPinned([subscriberIdentityOid]), false);
  assert.equal(
    artifactSigningIdentityMatchesPinned([ARTIFACT_SIGNING.publisherIdentityOid, subscriberIdentityOid]),
    false,
  );
  assert.equal(artifactSigningIdentityMatchesPinned([]), false);
});

test("the Tauri release overlay routes every binary through the privacy-preserving signer", () => {
  const nodePath = fixturePath("Program Files", "nodejs", "node.exe");
  const signerPath = fixturePath("repo", "sign.mjs");
  const overlay = buildSigningOverlay({
    nodePath,
    signerPath,
  });
  assert.deepEqual(overlay, {
    bundle: {
      windows: {
        digestAlgorithm: "sha256",
        signCommand: {
          cmd: nodePath,
          args: [signerPath, "%1"],
        },
      },
    },
  });
});

test("SignTool receives SHA-256, the Microsoft timestamp authority, dlib, metadata, and exact target", () => {
  assert.deepEqual(
    buildSignToolArgs({
      dlibPath: "C:\\tools\\Azure.CodeSigning.Dlib.dll",
      metadataPath: "C:\\temp\\metadata.json",
      targetPath: "C:\\build\\KalCode.exe",
    }),
    [
      "sign",
      "/fd",
      "SHA256",
      "/tr",
      "http://timestamp.acs.microsoft.com",
      "/td",
      "SHA256",
      "/dlib",
      "C:\\tools\\Azure.CodeSigning.Dlib.dll",
      "/dmdf",
      "C:\\temp\\metadata.json",
      "C:\\build\\KalCode.exe",
    ],
  );
});

test("tool discovery accepts only an existing x64 SignTool and matching Artifact Signing dlib", () => {
  const programFilesX86 = fixturePath("Program Files (x86)");
  const root = join(programFilesX86, "Microsoft", "ArtifactSigningClientTools", "bin");
  const existing = new Set([join(root, "signtool.exe"), join(root, "Azure.CodeSigning.Dlib.dll")]);
  const tools = findArtifactSigningTools({
    env: {},
    programFilesX86,
    exists: (path) => existing.has(path),
    stat: () => ({ isFile: () => true }),
  });
  assert.deepEqual(tools, {
    signToolPath: join(root, "signtool.exe"),
    dlibPath: join(root, "Azure.CodeSigning.Dlib.dll"),
  });

  assert.throws(
    () => findArtifactSigningTools({ env: {}, programFilesX86: fixturePath("missing"), exists: () => false }),
    /Artifact Signing Client Tools/,
  );
  assert.throws(
    () =>
      findArtifactSigningTools({
        env: {
          KALCODE_SIGNTOOL_PATH: fixturePath("tools", "signtool.exe"),
          KALCODE_ARTIFACT_SIGNING_DLIB_PATH: fixturePath("tools", "Azure.CodeSigning.Dlib.dll"),
        },
        exists: () => true,
        stat: () => ({ isFile: () => false }),
      }),
    /regular file/,
  );
});

test("tool discovery finds the WinGet per-user dlib and Windows SDK SignTool", () => {
  const programFilesX86 = "C:\\Program Files (x86)";
  const localAppData = "C:\\Users\\owner\\AppData\\Local";
  const sdkRoot = join(programFilesX86, "Windows Kits", "10", "bin");
  const signToolPath = join(sdkRoot, "10.0.26100.0", "x64", "signtool.exe");
  const dlibPath = join(localAppData, "Microsoft", "MicrosoftArtifactSigningClientTools", "Azure.CodeSigning.Dlib.dll");
  const existing = new Set([sdkRoot, signToolPath, dlibPath]);
  const tools = findArtifactSigningTools({
    env: {},
    programFilesX86,
    localAppData,
    exists: (path) => existing.has(path),
    stat: (path) => ({ isFile: () => path !== sdkRoot }),
    listDirectories: (path) => (path === sdkRoot ? ["10.0.26100.0", "10.0.22621.0"] : []),
  });
  assert.deepEqual(tools, { signToolPath, dlibPath });
});

test("signing target validation is absolute, existing, regular, and executable", () => {
  const target = fixturePath("build", "KalCode.exe");
  assert.equal(
    validateSigningTarget(target, {
      exists: () => true,
      stat: () => ({ isFile: () => true }),
    }),
    target,
  );
  assert.throws(() => validateSigningTarget("relative.exe", { exists: () => true }), /absolute/);
  assert.throws(() => validateSigningTarget(fixturePath("build", "notes.txt"), { exists: () => true }), /file type/);
  assert.throws(() => validateSigningTarget(target, { exists: () => false }), /does not exist/);
});

test("unsigned builds are limited to explicit local dev simulation", () => {
  assert.deepEqual(parseSigningMode([], "stable"), { sign: true, localSimulation: false });
  assert.deepEqual(parseSigningMode(["--unsigned-local"], "dev"), { sign: false, localSimulation: true });
  assert.throws(() => parseSigningMode(["--unsigned-local"], "stable"), /only valid with --channel dev/);
  assert.throws(() => parseSigningMode(["--unsigned-local"], "beta"), /only valid with --channel dev/);
});

test("a public release requires valid timestamped installer and application signatures", () => {
  const build = {
    version: "1.2.3",
    signed: true,
    signatureStatus: "Valid",
    requestedReleaseChannel: "stable",
    compiledChannel: "stable",
    releaseDescriptorEligible: true,
    releaseDescriptorBlockedReason: null,
    compiledChannelVerification: {
      status: "verified",
      method: "build_info_probe_v1",
      schemaVersion: 1,
      version: "1.2.3",
      channel: "stable",
      testHooks: false,
    },
    signing: {
      provider: "azure-artifact-signing",
      timestamped: true,
      appTimestamped: true,
      applicationVerifiedDuringBundle: true,
      publisherIdentityBound: true,
    },
    updater: {
      artifactFile: "KalCode_1.2.3_x64-setup.exe",
      signatureFile: "KalCode_1.2.3_x64-setup.exe.sig",
      signatureStatus: "Valid",
      cryptographicallyVerified: true,
      versionBound: true,
      publicKeyConfigured: true,
    },
    file: "KalCode_1.2.3_x64-setup.exe",
    guardian: guardianEvidence,
    hook: hookEvidence,
  };
  assert.deepEqual(publicSigningProblems(build), []);
  assert.match(publicSigningProblems({ ...build, hook: undefined }).join("\n"), /hook helper/);
  assert.match(
    publicSigningProblems({
      ...build,
      hook: { ...hookEvidence, signatureStatus: "NotSigned", signed: false },
    }).join("\n"),
    /signed hook helper/,
  );
  assert.match(publicSigningProblems({ ...build, guardian: undefined }).join("\n"), /guardian/);
  assert.match(
    publicSigningProblems({
      ...build,
      guardian: { ...guardianEvidence, signatureStatus: "NotSigned", signed: false },
    }).join("\n"),
    /signed guardian/,
  );
  assert.match(publicSigningProblems({ ...build, signed: false }).join("\n"), /signed/);
  assert.match(
    publicSigningProblems({ ...build, requestedReleaseChannel: "beta", compiledChannel: "beta" }).join("\n"),
    /stable/,
  );
  assert.match(
    publicSigningProblems({ ...build, signing: { ...build.signing, timestamped: false } }).join("\n"),
    /timestamp/,
  );
  assert.match(
    publicSigningProblems({
      ...build,
      signing: { ...build.signing, applicationVerifiedDuringBundle: false },
    }).join("\n"),
    /application/,
  );
  assert.match(
    publicSigningProblems({ ...build, signing: { ...build.signing, publisherIdentityBound: false } }).join("\n"),
    /publisher identity/,
  );
  assert.match(
    publicSigningProblems({ ...build, updater: { ...build.updater, versionBound: false } }).join("\n"),
    /updater signature/,
  );
  assert.match(
    publicSigningProblems({
      ...build,
      releaseDescriptorEligible: false,
      releaseDescriptorBlockedReason: "unsigned_build",
    }).join("\n"),
    /not eligible/,
  );
  assert.match(
    publicSigningProblems({ ...build, releaseDescriptorBlockedReason: "forged_reason" }).join("\n"),
    /internally inconsistent/,
  );
  assert.match(
    publicSigningProblems({
      ...build,
      compiledChannelVerification: { ...build.compiledChannelVerification, testHooks: true },
    }).join("\n"),
    /production binary probe/,
  );
  for (const compiledChannelVerification of [
    { ...build.compiledChannelVerification, version: "1.2.2" },
    { ...build.compiledChannelVerification, channel: "beta" },
  ]) {
    assert.match(
      publicSigningProblems({ ...build, compiledChannelVerification }).join("\n"),
      /production binary probe/,
    );
  }
});

test("signature evidence drops certificate identity details", () => {
  assert.deepEqual(
    normalizeAuthenticodeResult({
      status: "Valid",
      timestamped: true,
      subject: "private identity",
      address: "private",
    }),
    { status: "Valid", timestamped: true },
  );
  assert.deepEqual(normalizeAuthenticodeResult(null), { status: "Unknown", timestamped: false });
});

test("signing failures never echo SignTool output that can contain certificate identity data", () => {
  const target = fixturePath("build", "KalCode.exe");
  const metadata = fixturePath("temp", "metadata.json");
  const signTool = fixturePath("tools", "signtool.exe");
  const dlib = fixturePath("tools", "Azure.CodeSigning.Dlib.dll");
  const exists = (path) => [target, metadata, signTool, dlib].includes(path);
  let spawnOptions;
  assert.throws(
    () =>
      signTarget({
        targetPath: target,
        metadataPath: metadata,
        env: {
          KALCODE_SIGNTOOL_PATH: signTool,
          KALCODE_ARTIFACT_SIGNING_DLIB_PATH: dlib,
        },
        exists,
        stat: () => ({ isFile: () => true }),
        spawn: (_command, _args, options) => {
          spawnOptions = options;
          return { status: 7, stdout: "CN=private identity", stderr: "private address" };
        },
      }),
    (error) => {
      assert.match(error.message, /exited with 7/);
      assert.doesNotMatch(error.message, /private/i);
      return true;
    },
  );
  assert.equal(spawnOptions.timeout, 300_000);
  assert.equal(spawnOptions.killSignal, "SIGKILL");
  assert.equal(spawnOptions.maxBuffer, 8 * 1024 * 1024);
});

test("the signer makes the official Azure CLI available to DefaultAzureCredential", () => {
  const cli = "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin";
  const result = signingEnvironment(
    { Path: "C:\\Windows\\System32", PATH: "stale-duplicate", KEEP: "yes" },
    { exists: (path) => path === join(cli, "az.cmd") },
  );
  assert.equal(result.KEEP, "yes");
  assert.equal(result.PATH, undefined);
  assert.equal(result.Path, `C:\\Windows\\System32;${cli}`);
});

test("Authenticode probing records only status and timestamp presence", () => {
  let script = "";
  const result = normalizeAuthenticodeResult({ status: "Valid", timestamped: true });
  assert.deepEqual(result, { status: "Valid", timestamped: true });

  const probe = (value) => {
    script = value;
    return { status: "Valid", timestamped: true };
  };
  assert.deepEqual(authenticodeStatus("C:\\build\\KalCode.exe", probe), {
    status: "Valid",
    timestamped: true,
  });
  assert.doesNotMatch(script, /Subject|Thumbprint|CertificateProfile|Street/i);
});

test("Artifact Signing publisher binding accepts one subscriber EKU and rejects generic or ambiguous identity", () => {
  assert.deepEqual(
    normalizeArtifactSigningIdentityOids({
      oids: ["1.3.6.1.5.5.7.3.3", genericArtifactSigningOid, subscriberIdentityOid],
    }),
    [subscriberIdentityOid],
  );
  assert.deepEqual(parsePublisherIdentityEnvironment(subscriberIdentityOid), [subscriberIdentityOid]);
  assert.throws(
    () => normalizeArtifactSigningIdentityOids({ oids: ["1.3.6.1.5.5.7.3.3", genericArtifactSigningOid] }),
    /subscriber identity/,
  );
  assert.throws(() => normalizeArtifactSigningIdentityOids({ oids: [subscriberIdentityOid] }), /Public Trust marker/);
  assert.throws(
    () =>
      normalizeArtifactSigningIdentityOids({
        oids: [genericArtifactSigningOid, subscriberIdentityOid, "1.3.6.1.4.1.311.97.2.3.4.5"],
      }),
    /exactly one/,
  );
  assert.throws(
    () => parsePublisherIdentityEnvironment(`${subscriberIdentityOid},${subscriberIdentityOid}`),
    /canonical/,
  );
  assert.throws(() => parsePublisherIdentityEnvironment("1.3.6.1.4.1.311.97.01.2"), /malformed/);
});

test("publisher EKU probe emits only OIDs and never certificate identity fields", () => {
  let script = "";
  const result = authenticodeIdentityOids("C:\\build\\KalCode.exe", (value) => {
    script = value;
    return { oids: ["1.3.6.1.5.5.7.3.3", genericArtifactSigningOid, subscriberIdentityOid] };
  });
  assert.deepEqual(result, [subscriberIdentityOid]);
  assert.match(script, /EnhancedKeyUsages/);
  assert.doesNotMatch(script, /Subject|Street|Thumbprint|CertificateProfile/i);
});

test("public verification requires the exact build plus clean, shortcut, and update-mode install probes", () => {
  const build = {
    version: "1.2.3",
    file: "KalCode_1.2.3_x64-setup.exe",
    commit: "a".repeat(40),
    sha256: "b".repeat(64),
    guardian: guardianEvidence,
    hook: hookEvidence,
  };
  const verify = {
    status: "passed",
    version: build.version,
    file: build.file,
    commit: build.commit,
    sha256: build.sha256,
    signatureStatus: "Valid",
    timestamped: true,
    publisherIdentityBound: true,
    updater: { signatureStatus: "Valid", exactBytes: true, versionBound: true },
    guardian: {
      file: guardianEvidence.file,
      sha256: guardianEvidence.sha256,
      signatureStatus: "Valid",
      timestamped: true,
      publisherIdentityBound: true,
      allInstallPassesVerified: true,
    },
    hook: {
      file: hookEvidence.file,
      sha256: hookEvidence.sha256,
      signatureStatus: "Valid",
      timestamped: true,
      publisherIdentityBound: true,
      allInstallPassesVerified: true,
    },
    launchedApp: false,
    preflight: { existingInstall: [], runningKalcode: [] },
    checks: [{ name: "all release checks completed", ok: true }],
    passes: [
      {
        name: "no-shortcuts",
        installedAppSignature: { status: "Valid", timestamped: true },
        installedAppSignerMatchesInstaller: true,
        installedGuardian: {
          file: guardianEvidence.file,
          sha256: guardianEvidence.sha256,
          signatureStatus: "Valid",
          timestamped: true,
          signerMatchesInstaller: true,
        },
        installedHook: {
          file: hookEvidence.file,
          sha256: hookEvidence.sha256,
          signatureStatus: "Valid",
          timestamped: true,
          signerMatchesInstaller: true,
        },
        afterUninstall: {
          uninstallEntry: false,
          installFolder: false,
          desktopShortcut: false,
          startMenuShortcut: false,
        },
      },
      {
        name: "default",
        installedAppSignature: { status: "Valid", timestamped: true },
        installedAppSignerMatchesInstaller: true,
        installedGuardian: {
          file: guardianEvidence.file,
          sha256: guardianEvidence.sha256,
          signatureStatus: "Valid",
          timestamped: true,
          signerMatchesInstaller: true,
        },
        installedHook: {
          file: hookEvidence.file,
          sha256: hookEvidence.sha256,
          signatureStatus: "Valid",
          timestamped: true,
          signerMatchesInstaller: true,
        },
        afterUninstall: {
          uninstallEntry: false,
          installFolder: false,
          desktopShortcut: false,
          startMenuShortcut: false,
        },
      },
      {
        name: "upgrade",
        installedAppSignature: { status: "Valid", timestamped: true },
        installedAppSignerMatchesInstaller: true,
        installedGuardian: {
          file: guardianEvidence.file,
          sha256: guardianEvidence.sha256,
          signatureStatus: "Valid",
          timestamped: true,
          signerMatchesInstaller: true,
        },
        installedHook: {
          file: hookEvidence.file,
          sha256: hookEvidence.sha256,
          signatureStatus: "Valid",
          timestamped: true,
          signerMatchesInstaller: true,
        },
        updateModeRehearsal: true,
        afterUninstall: {
          uninstallEntry: false,
          installFolder: false,
          desktopShortcut: false,
          startMenuShortcut: false,
        },
      },
    ],
  };
  assert.deepEqual(publicVerificationProblems(build, verify), []);
  assert.match(publicVerificationProblems(build, { ...verify, hook: undefined }).join("\n"), /hook helper/);
  assert.match(
    publicVerificationProblems(build, {
      ...verify,
      passes: verify.passes.map((pass, index) => (index === 2 ? { ...pass, installedHook: undefined } : pass)),
    }).join("\n"),
    /hook helper/,
  );
  assert.match(publicVerificationProblems(build, { ...verify, guardian: undefined }).join("\n"), /guardian/);
  assert.match(
    publicVerificationProblems(build, {
      ...verify,
      guardian: { ...verify.guardian, sha256: "d".repeat(64) },
    }).join("\n"),
    /guardian/,
  );
  assert.match(
    publicVerificationProblems(build, {
      ...verify,
      passes: verify.passes.map((pass, index) => (index === 1 ? { ...pass, installedGuardian: undefined } : pass)),
    }).join("\n"),
    /guardian/,
  );
  assert.match(
    publicVerificationProblems(build, {
      ...verify,
      passes: [...verify.passes, { ...verify.passes[0], installedGuardian: undefined }],
    }).join("\n"),
    /guardian/,
  );
  assert.match(
    publicVerificationProblems(build, {
      ...verify,
      guardian: { ...verify.guardian, signatureStatus: "NotSigned" },
    }).join("\n"),
    /guardian/,
  );
  assert.match(
    publicVerificationProblems(build, {
      ...verify,
      guardian: { ...verify.guardian, publisherIdentityBound: false },
    }).join("\n"),
    /guardian/,
  );
  assert.match(publicVerificationProblems(build, null).join("\n"), /verification report/);
  assert.match(publicVerificationProblems(build, { ...verify, version: "1.2.4" }).join("\n"), /exact build/);
  assert.match(publicVerificationProblems(build, { ...verify, launchedApp: true }).join("\n"), /never launch/);
  assert.match(
    publicVerificationProblems(build, { ...verify, publisherIdentityBound: false }).join("\n"),
    /publisher identity/,
  );
  assert.match(
    publicVerificationProblems(build, { ...verify, updater: { ...verify.updater, exactBytes: false } }).join("\n"),
    /updater signature/,
  );
  assert.match(
    publicVerificationProblems(build, { ...verify, checks: [{ name: "failure", ok: false }] }).join("\n"),
    /all recorded checks/,
  );
  assert.match(
    publicVerificationProblems(build, {
      ...verify,
      passes: verify.passes.map((pass, index) =>
        index === 0 ? { ...pass, afterUninstall: { ...pass.afterUninstall, installFolder: true } } : pass,
      ),
    }).join("\n"),
    /cleanup/,
  );
  assert.match(
    publicVerificationProblems(build, { ...verify, passes: verify.passes.slice(0, 1) }).join("\n"),
    /both installer test passes/,
  );
  assert.match(
    publicVerificationProblems(build, {
      ...verify,
      passes: verify.passes.map((pass, index) =>
        index === 1 ? { ...pass, installedAppSignature: { status: "HashMismatch", timestamped: true } } : pass,
      ),
    }).join("\n"),
    /installed application signature/,
  );
  assert.match(
    publicVerificationProblems(build, {
      ...verify,
      passes: verify.passes.map((pass, index) =>
        index === 1 ? { ...pass, installedAppSignerMatchesInstaller: false } : pass,
      ),
    }).join("\n"),
    /same signing identity/,
  );
  assert.match(
    publicVerificationProblems(build, {
      ...verify,
      passes: verify.passes.map((pass) => (pass.name === "upgrade" ? { ...pass, updateModeRehearsal: false } : pass)),
    }).join("\n"),
    /update-mode/,
  );
});

test("signer comparison uses the durable subscriber EKU and returns only a boolean", () => {
  const scripts = [];
  const same = sameAuthenticodeSigner("C:\\build\\installer.exe", "C:\\install\\kalcode.exe", (value) => {
    scripts.push(value);
    return { oids: [genericArtifactSigningOid, subscriberIdentityOid] };
  });
  assert.equal(same, true);
  assert.equal(scripts.length, 2);
  assert.match(scripts.join("\n"), /EnhancedKeyUsages/);
  assert.doesNotMatch(scripts.join("\n"), /Subject|Street|Thumbprint|CertificateProfile/i);
});
