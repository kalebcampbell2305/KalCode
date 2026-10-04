import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseUpdaterDescriptor } from "../../apps/website/worker/updater-descriptor.ts";
import {
  createPlatformUpdaterManifest,
  createUpdaterManifest,
  qaChangeDeclarationProblems,
  updaterQaProblems,
} from "./updater-manifest.mjs";

const commit = "a".repeat(40);
const artifactBytes = Buffer.from("updater artifact");
const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
const guardianSha256 = "c".repeat(64);
const hookSha256 = "e".repeat(64);
const baselineCommit = "b".repeat(40);
const baselineSha256 = "d".repeat(64);

function qaEvidence(target, version = "1.2.3", candidateCommit = commit, candidateSha256 = artifactSha256) {
  const baseline = { version: "1.2.2", commit: baselineCommit, sha256: baselineSha256 };
  const candidate = { version, commit: candidateCommit, sha256: candidateSha256 };
  return {
    schemaVersion: 2,
    status: "passed",
    target,
    channel: "stable",
    release: candidate,
    safeguards: {
      testHooks: false,
      cacheSeeded: false,
      authenticationBypassed: false,
      tlsBypassed: false,
      fixtureOnly: false,
    },
    checks: Object.fromEntries(
      [
        "install",
        "cleanInstall",
        "launch",
        "auth",
        "providers",
        "accountIsolation",
        "kalvoice",
        "browser",
        "workspace",
        "sleepWake",
      ].map((key) => [key, true]),
    ),
    updateTrial: {
      method: "public-unlisted-immutable-version-v1",
      baseline,
      candidate,
      outcomes: [
        { step: "update", from: baseline, to: candidate, passed: true },
        { step: "rollback", from: candidate, to: baseline, passed: true },
        { step: "reupdate", from: baseline, to: candidate, passed: true },
      ],
    },
  };
}

function signer() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const rawPublicKey = publicDer.subarray(publicDer.length - 32);
  const keyId = Buffer.from("0102030405060708", "hex");
  const publicRecord = Buffer.concat([Buffer.from("Ed"), keyId, rawPublicKey]);
  const publicText = ["untrusted comment: minisign public key: test fixture", publicRecord.toString("base64"), ""].join(
    "\n",
  );
  return {
    privateKey,
    keyId,
    publicKeyBase64: Buffer.from(publicText, "utf8").toString("base64"),
  };
}

const releaseSigner = signer();

function signature(
  version = "1.2.3",
  bytes = artifactBytes,
  signingKey = releaseSigner,
  trustedFields = [],
  file = "KalCode_1.2.3_x64-setup.exe",
  orderFields = (fields) => fields,
) {
  const digest = createHash("blake2b512").update(bytes).digest();
  const artifactSignature = signBytes(null, digest, signingKey.privateKey);
  const signatureRecord = Buffer.concat([Buffer.from("ED"), signingKey.keyId, artifactSignature]);
  const trustedComment = orderFields([
    `timestamp:1789992000`,
    `file:${file}`,
    `version:${version}`,
    ...trustedFields,
  ]).join("\t");
  const globalSignature = signBytes(
    null,
    Buffer.concat([artifactSignature, Buffer.from(trustedComment, "utf8")]),
    signingKey.privateKey,
  );
  const text = [
    "untrusted comment: signature from minisign secret key",
    signatureRecord.toString("base64"),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString("base64"),
  ].join("\n");
  return Buffer.from(text, "utf8").toString("base64");
}

function evidence(channel = "stable") {
  const build = {
    version: "1.2.3",
    file: "KalCode_1.2.3_x64-setup.exe",
    commit,
    sha256: artifactSha256,
    size: artifactBytes.length,
    requestedReleaseChannel: channel,
    compiledChannel: channel,
    signed: true,
    releaseDescriptorEligible: true,
    releaseDescriptorBlockedReason: null,
    signatureStatus: "Valid",
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
    guardian: {
      file: "kalcode-provider-guardian.exe",
      sha256: guardianSha256,
      signed: true,
      signatureStatus: "Valid",
      timestamped: true,
      publisherIdentityBound: true,
      bundledBesideApplication: true,
    },
    hook: {
      file: "kalcode-hook.exe",
      sha256: hookSha256,
      signed: true,
      signatureStatus: "Valid",
      timestamped: true,
      publisherIdentityBound: true,
      bundledBesideApplication: true,
    },
    compiledChannelVerification: {
      status: "verified",
      method: "build_info_probe_v1",
      schemaVersion: 1,
      version: "1.2.3",
      channel,
      testHooks: false,
    },
  };
  const installedAppSignature = { status: "Valid", timestamped: true };
  const afterUninstall = {
    uninstallEntry: false,
    installFolder: false,
    desktopShortcut: false,
    startMenuShortcut: false,
  };
  const installedGuardian = {
    file: build.guardian.file,
    sha256: guardianSha256,
    signatureStatus: "Valid",
    timestamped: true,
    signerMatchesInstaller: true,
  };
  const installedHook = {
    file: build.hook.file,
    sha256: hookSha256,
    signatureStatus: "Valid",
    timestamped: true,
    signerMatchesInstaller: true,
  };
  const verify = {
    status: "passed",
    version: build.version,
    file: build.file,
    commit,
    sha256: artifactSha256,
    signatureStatus: "Valid",
    timestamped: true,
    publisherIdentityBound: true,
    updater: { signatureStatus: "Valid", exactBytes: true, versionBound: true },
    guardian: {
      file: build.guardian.file,
      sha256: guardianSha256,
      signatureStatus: "Valid",
      timestamped: true,
      publisherIdentityBound: true,
      allInstallPassesVerified: true,
    },
    hook: {
      file: build.hook.file,
      sha256: hookSha256,
      signatureStatus: "Valid",
      timestamped: true,
      publisherIdentityBound: true,
      allInstallPassesVerified: true,
    },
    launchedApp: false,
    preflight: { existingInstall: [], runningKalcode: [] },
    checks: [{ name: "all checks", ok: true }],
    passes: [
      {
        name: "no-shortcuts",
        installedAppSignature,
        installedAppSignerMatchesInstaller: true,
        installedUninstallerSignature: { status: "Valid", timestamped: true },
        installedUninstallerSignerMatchesInstaller: true,
        installedGuardian,
        installedHook,
        afterUninstall,
      },
      {
        name: "default",
        installedAppSignature,
        installedAppSignerMatchesInstaller: true,
        installedUninstallerSignature: { status: "Valid", timestamped: true },
        installedUninstallerSignerMatchesInstaller: true,
        installedGuardian,
        installedHook,
        afterUninstall,
      },
      {
        name: "upgrade",
        installedAppSignature,
        installedAppSignerMatchesInstaller: true,
        installedUninstallerSignature: { status: "Valid", timestamped: true },
        installedUninstallerSignerMatchesInstaller: true,
        installedGuardian,
        installedHook,
        updateModeRehearsal: true,
        afterUninstall,
      },
    ],
  };
  return { build, verify, qa: qaEvidence("windows-x86_64") };
}

function fixture(channel = "stable") {
  const dir = mkdtempSync(join(tmpdir(), "kalcode-updater-feed-"));
  const artifactPath = join(dir, "KalCode_1.2.3_x64-setup.exe");
  const signaturePath = `${artifactPath}.sig`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(artifactPath, artifactBytes);
  writeFileSync(signaturePath, signature());
  return {
    ...evidence(channel),
    artifactPath,
    artifactKey: `releases/updater/${channel}/1.2.3/${artifactSha256}/KalCode_1.2.3_x64-setup.exe`,
    signaturePath,
    publicKeyBase64: releaseSigner.publicKeyBase64,
  };
}

test("emits the static Tauri feed only from complete signed and verified evidence", async () => {
  const input = fixture();
  const manifest = await createUpdaterManifest({
    ...input,
    publishedAt: "2026-09-25T12:00:00.000Z",
    notes: "Safer updates and faster workspace startup.",
  });
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.pub_date, "2026-09-25T12:00:00.000Z");
  assert.deepEqual(Object.keys(manifest.platforms), ["windows-x86_64"]);
  assert.equal(manifest.platforms["windows-x86_64"].signature, signature());
  assert.equal(
    manifest.platforms["windows-x86_64"].url,
    `https://kalcoded.com/releases/updater/stable/1.2.3/${artifactSha256}/KalCode_1.2.3_x64-setup.exe`,
  );
  assert.equal(manifest.kalcode.channel, "stable");
  assert.equal(manifest.kalcode.commit, commit);
  assert.equal(manifest.kalcode.size, Buffer.byteLength("updater artifact"));
  assert.match(manifest.kalcode.sha256, /^[0-9a-f]{64}$/);
});

test("the website accepts the exact updater descriptor emitted by the release generator", async () => {
  const input = fixture();
  const manifest = await createUpdaterManifest({
    ...input,
    publishedAt: "2026-09-25T12:00:00.000Z",
    notes: "Safer updates and faster workspace startup.",
  });

  const parsed = parseUpdaterDescriptor(manifest, "stable", input.build.version);
  assert.ok(parsed);
  assert.equal(parsed.artifactKey, input.artifactKey);
  assert.equal(parsed.signature, manifest.platforms["windows-x86_64"].signature);
});

test("a build of the public version publishes as X.Y.Z+N with a plus-free artifact name", async () => {
  const version = "1.2.3+41";
  const file = "KalCode_1.2.3_build41_x64-setup.exe";
  const base = evidence();
  const build = {
    ...base.build,
    version,
    file,
    updater: { ...base.build.updater, artifactFile: file, signatureFile: `${file}.sig` },
    compiledChannelVerification: { ...base.build.compiledChannelVerification, version },
  };
  const dir = mkdtempSync(join(tmpdir(), "kalcode-updater-build-"));
  const artifactPath = join(dir, file);
  writeFileSync(artifactPath, artifactBytes);
  writeFileSync(`${artifactPath}.sig`, signature(version, artifactBytes, releaseSigner, [], file));
  const manifest = await createUpdaterManifest({
    build,
    verify: { ...base.verify, version, file },
    qa: qaEvidence("windows-x86_64", version),
    artifactPath,
    artifactKey: `releases/updater/stable/${version}/${artifactSha256}/${file}`,
    signaturePath: `${artifactPath}.sig`,
    publicKeyBase64: releaseSigner.publicKeyBase64,
    publishedAt: "2026-09-30T12:00:00.000Z",
    notes: "A new build of KalCode 1.2.3.",
  });
  assert.equal(manifest.version, version);
  assert.equal(
    manifest.platforms["windows-x86_64"].url,
    `https://kalcoded.com/releases/updater/stable/${version}/${artifactSha256}/${file}`,
  );
  const parsed = parseUpdaterDescriptor(manifest, "stable", version);
  assert.ok(parsed);
  assert.equal(parsed.artifactKey, `releases/updater/stable/${version}/${artifactSha256}/${file}`);
  assert.equal(parseUpdaterDescriptor(manifest, "stable", "1.2.3"), null);
});

test("fails closed for missing updater artifact or detached signature", async () => {
  const missingArtifact = fixture();
  await assert.rejects(
    createUpdaterManifest({
      ...missingArtifact,
      artifactPath: join(missingArtifact.artifactPath, "missing", missingArtifact.build.file),
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /updater artifact is missing/,
  );
  const missingSignature = fixture();
  await assert.rejects(
    createUpdaterManifest({
      ...missingSignature,
      signaturePath: join(missingSignature.signaturePath, "missing", `${missingSignature.build.file}.sig`),
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /updater signature is missing/,
  );
});

test("rejects updater URLs that are not digest-qualified for the exact artifact", async () => {
  const input = fixture();
  await assert.rejects(
    createUpdaterManifest({
      ...input,
      artifactKey: "releases/updater/stable/1.2.3/KalCode_1.2.3_x64-setup.exe",
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /content-addressed/,
  );
});

test("rejects ineligible, unsigned, mismatched-channel, and identity-bearing build evidence", async () => {
  for (const mutate of [
    (input) => ({ ...input, build: { ...input.build, releaseDescriptorEligible: false } }),
    (input) => ({ ...input, build: { ...input.build, signatureStatus: "NotSigned" } }),
    (input) => ({
      ...input,
      build: {
        ...input.build,
        signing: { ...input.build.signing, publisherIdentityBound: false },
      },
    }),
    (input) => ({ ...input, requestedChannel: "beta" }),
    (input) => ({
      ...input,
      build: { ...input.build, signing: { ...input.build.signing, certificateSubject: "private identity" } },
    }),
  ]) {
    const input = mutate(fixture());
    await assert.rejects(
      createUpdaterManifest({
        ...input,
        requestedChannel: input.requestedChannel ?? "stable",
        publishedAt: "2026-09-25T12:00:00.000Z",
        notes: "Update.",
      }),
      /not eligible|signature|channel|redacted/,
    );
  }
});

test("public updater publication requires signed timestamped publisher-bound uninstallers in every Windows pass", async () => {
  for (const name of ["no-shortcuts", "default", "upgrade"]) {
    for (const mutate of [
      (pass) => {
        delete pass.installedUninstallerSignature;
      },
      (pass) => {
        pass.installedUninstallerSignature.status = "NotSigned";
      },
      (pass) => {
        pass.installedUninstallerSignature.timestamped = false;
      },
      (pass) => {
        delete pass.installedUninstallerSignerMatchesInstaller;
      },
      (pass) => {
        pass.installedUninstallerSignerMatchesInstaller = false;
      },
    ]) {
      const input = fixture();
      mutate(input.verify.passes.find((pass) => pass.name === name));
      await assert.rejects(
        createUpdaterManifest({ ...input, publishedAt: "2026-09-25T12:00:00.000Z", notes: "Update." }),
        /installed uninstaller/,
      );
    }
  }
});

test("public updater publication requires the exact installed hook helper in every Windows pass", async () => {
  for (const mutate of [
    (input) => ({ ...input, build: { ...input.build, hook: undefined } }),
    (input) => ({ ...input, verify: { ...input.verify, hook: undefined } }),
    (input) => ({
      ...input,
      verify: {
        ...input.verify,
        passes: input.verify.passes.map((pass) =>
          pass.name === "upgrade"
            ? { ...pass, installedHook: { ...pass.installedHook, sha256: "f".repeat(64) } }
            : pass,
        ),
      },
    }),
  ]) {
    const input = mutate(fixture());
    await assert.rejects(
      createUpdaterManifest({
        ...input,
        publishedAt: "2026-09-25T12:00:00.000Z",
        notes: "Update.",
      }),
      /hook helper/,
    );
  }
});

test("stable feed requires exact clean-install and upgrade verification", async () => {
  const input = fixture();
  for (const verify of [
    { ...input.verify, status: "failed" },
    { ...input.verify, commit: "f".repeat(40) },
    { ...input.verify, passes: input.verify.passes.filter((pass) => pass.name !== "upgrade") },
    {
      ...input.verify,
      passes: input.verify.passes.map((pass) =>
        pass.name === "upgrade" ? { ...pass, updateModeRehearsal: false } : pass,
      ),
    },
  ]) {
    await assert.rejects(
      createUpdaterManifest({
        ...input,
        verify,
        publishedAt: "2026-09-25T12:00:00.000Z",
        notes: "Update.",
      }),
      /verification|upgrade/,
    );
  }
});

test("signature trusted comment must bind the exact manifest version", async () => {
  const input = fixture();
  writeFileSync(input.signaturePath, signature("1.2.4"));
  await assert.rejects(
    createUpdaterManifest({
      ...input,
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /does not bind version 1.2.3/,
  );
});

test("cryptographically verifies the exact updater bytes with the configured public key", async () => {
  const tamperedArtifact = fixture();
  writeFileSync(tamperedArtifact.artifactPath, Buffer.from("tampered artifact"));
  await assert.rejects(
    createUpdaterManifest({
      ...tamperedArtifact,
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /signature is invalid/,
  );

  const wrongSigner = fixture();
  writeFileSync(wrongSigner.signaturePath, signature("1.2.3", artifactBytes, signer()));
  await assert.rejects(
    createUpdaterManifest({
      ...wrongSigner,
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /signature is invalid/,
  );
});

test("a valid signature cannot substitute bytes from a different build record", async () => {
  const input = fixture();
  const substitutedSha256 = "b".repeat(64);
  await assert.rejects(
    createUpdaterManifest({
      ...input,
      artifactKey: `releases/updater/stable/1.2.3/${substitutedSha256}/${input.build.file}`,
      build: { ...input.build, sha256: substitutedSha256 },
      verify: { ...input.verify, sha256: substitutedSha256 },
      qa: {
        ...input.qa,
        release: { ...input.qa.release, sha256: substitutedSha256 },
        updateTrial: {
          ...input.qa.updateTrial,
          candidate: { ...input.qa.updateTrial.candidate, sha256: substitutedSha256 },
          outcomes: input.qa.updateTrial.outcomes.map((outcome) => ({
            ...outcome,
            ...(outcome.step === "rollback"
              ? { from: { ...outcome.from, sha256: substitutedSha256 } }
              : { to: { ...outcome.to, sha256: substitutedSha256 } }),
          })),
        },
      },
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Release notes.",
    }),
    /exact build size and SHA-256/,
  );
});

test("rejects missing keys and ambiguous signed version fields", async () => {
  const missingKey = fixture();
  await assert.rejects(
    createUpdaterManifest({
      ...missingKey,
      publicKeyBase64: undefined,
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /public key/,
  );

  const duplicateVersion = fixture();
  writeFileSync(duplicateVersion.signaturePath, signature("1.2.3", artifactBytes, releaseSigner, ["version:1.2.3"]));
  await assert.rejects(
    createUpdaterManifest({
      ...duplicateVersion,
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /version field/,
  );
});

test("v2 preserves Windows gates and cryptographically binds its platform target", async () => {
  const input = fixture();
  input.signaturePath = `${input.artifactPath}.windows-x86_64.sig`;
  writeFileSync(input.signaturePath, signature());
  const options = {
    artifacts: [{ ...input, target: "windows-x86_64" }],
    requestedChannel: "stable",
    publishedAt: "2026-09-25T12:00:00.000Z",
    notes: "Update.",
  };
  await assert.rejects(createPlatformUpdaterManifest(options), /trusted comment/);
  writeFileSync(
    input.signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:windows-x86_64", "channel:stable"]),
  );
  const manifest = await createPlatformUpdaterManifest(options);
  assert.equal(manifest.kalcode.schemaVersion, 2);
  writeFileSync(
    input.signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:windows-x86_64", "channel:dev"]),
  );
  await assert.rejects(createPlatformUpdaterManifest(options), /channel/);
  assert.deepEqual(manifest.kalcode.artifacts["windows-x86_64"], {
    target: "windows-x86_64",
    format: "nsis",
    size: artifactBytes.length,
    sha256: artifactSha256,
  });
  assert.deepEqual(Object.keys(manifest.platforms), ["windows-x86_64"]);
  writeFileSync(
    input.signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:darwin-aarch64", "channel:stable"]),
  );
  await assert.rejects(createPlatformUpdaterManifest(options), /selected platform target/);
});

test("Windows Beta and Dev publication retain exact channel-bound final QA", async () => {
  for (const channel of ["beta", "dev"]) {
    const input = fixture(channel);
    if (channel === "dev") {
      input.build.compiledChannel = "development";
      input.build.compiledChannelVerification.channel = "development";
    }
    input.qa.channel = channel;
    input.qa.updateTrial.method = "signed-local-candidate-v1";
    input.signaturePath = `${input.artifactPath}.windows-x86_64.sig`;
    writeFileSync(
      input.signaturePath,
      signature("1.2.3", artifactBytes, releaseSigner, ["target:windows-x86_64", `channel:${channel}`]),
    );
    const manifest = await createPlatformUpdaterManifest({
      artifacts: [{ ...input, target: "windows-x86_64" }],
      requestedChannel: channel,
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Preview update.",
    });
    assert.equal(manifest.kalcode.channel, channel);
    input.qa.channel = "stable";
    await assert.rejects(
      createPlatformUpdaterManifest({
        artifacts: [{ ...input, target: "windows-x86_64" }],
        requestedChannel: channel,
        publishedAt: "2026-09-25T12:00:00.000Z",
        notes: "Preview update.",
      }),
      /channel does not match/,
    );
  }
});

test("v2 rejects missing, duplicate and unsupported platform artifacts", async () => {
  const options = { requestedChannel: "stable", publishedAt: "2026-09-25T12:00:00.000Z", notes: "Update." };
  for (const artifacts of [
    [],
    [{ target: "darwin-x86_64" }],
    [{ target: "windows-x86_64" }, { target: "windows-x86_64" }],
  ]) {
    await assert.rejects(createPlatformUpdaterManifest({ ...options, artifacts }), /platform artifacts/);
  }
});

test("v2 rejects a valid cryptographic signature with noncanonical field order", async () => {
  const input = fixture();
  input.signaturePath = `${input.artifactPath}.windows-x86_64.sig`;
  writeFileSync(
    input.signaturePath,
    signature(
      "1.2.3",
      artifactBytes,
      releaseSigner,
      ["target:windows-x86_64", "channel:stable"],
      input.build.file,
      ([timestamp, file, version, target, channel]) => [timestamp, version, file, target, channel],
    ),
  );
  await assert.rejects(
    createPlatformUpdaterManifest({
      artifacts: [{ ...input, target: "windows-x86_64" }],
      requestedChannel: "stable",
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /canonical order/,
  );
});

test("preliminary staging and final publication produce byte-identical candidate descriptors", async () => {
  const input = fixture();
  input.signaturePath = `${input.artifactPath}.windows-x86_64.sig`;
  writeFileSync(
    input.signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:windows-x86_64", "channel:stable"]),
  );
  const preliminary = {
    ...input.qa,
    status: "preliminary-passed",
    updateTrial: null,
  };
  const common = {
    requestedChannel: "stable",
    publishedAt: "2026-09-25T12:00:00.000Z",
    notes: "Update.",
  };
  const staged = await createPlatformUpdaterManifest({
    ...common,
    qaPhase: "preliminary",
    artifacts: [{ ...input, qa: preliminary, target: "windows-x86_64" }],
  });
  const final = await createPlatformUpdaterManifest({
    ...common,
    artifacts: [{ ...input, target: "windows-x86_64" }],
  });
  assert.equal(`${JSON.stringify(staged, null, 2)}\n`, `${JSON.stringify(final, null, 2)}\n`);
  await assert.rejects(
    createPlatformUpdaterManifest({
      ...common,
      artifacts: [{ ...input, qa: preliminary, target: "windows-x86_64" }],
    }),
    /completed updater QA/,
  );
});

test("an owner-waived update trial lowers only that artifact to the preliminary contract", async () => {
  const input = fixture();
  input.signaturePath = `${input.artifactPath}.windows-x86_64.sig`;
  writeFileSync(
    input.signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:windows-x86_64", "channel:stable"]),
  );
  const pending = { ...input.qa, status: "preliminary-passed", updateTrial: null };
  const common = { requestedChannel: "stable", publishedAt: "2026-09-25T12:00:00.000Z", notes: "Update." };
  const final = await createPlatformUpdaterManifest({ ...common, artifacts: [{ ...input, target: "windows-x86_64" }] });
  const waived = await createPlatformUpdaterManifest({
    ...common,
    artifacts: [{ ...input, qa: pending, target: "windows-x86_64", updateTrialWaived: true }],
  });
  assert.equal(JSON.stringify(waived), JSON.stringify(final));
  // The waiver never excuses product checks or safeguards, and is only an explicit boolean on a final publication.
  const broken = { ...pending, checks: { ...pending.checks, [Object.keys(pending.checks)[0]]: false } };
  await assert.rejects(
    createPlatformUpdaterManifest({
      ...common,
      artifacts: [{ ...input, qa: broken, target: "windows-x86_64", updateTrialWaived: true }],
    }),
    /product checks are incomplete/,
  );
  await assert.rejects(
    createPlatformUpdaterManifest({
      ...common,
      artifacts: [{ ...input, qa: pending, target: "windows-x86_64", updateTrialWaived: "yes" }],
    }),
    /waiver applies only to a final publication/,
  );
  await assert.rejects(
    createPlatformUpdaterManifest({
      ...common,
      qaPhase: "preliminary",
      artifacts: [{ ...input, qa: pending, target: "windows-x86_64", updateTrialWaived: true }],
    }),
    /waiver applies only to a final publication/,
  );
});

test("publish.mjs carries an update-trial waiver into every platform manifest it builds or re-verifies", () => {
  // Regression (deputy R1): the final readback re-verification must use the same per-artifact waiver as the
  // first build, or a waived publication fails in Bootstrap/ConfirmAfterDeploy after the uploads.
  const source = readFileSync(new URL("./publish.mjs", import.meta.url), "utf8");
  const builds = source.match(/createPlatformUpdaterManifest\(/g) ?? [];
  const spreads = source.match(/\.\.\.packet,/g) ?? [];
  const waived =
    source.match(
      /\.\.\.packet,\s+\.\.\.\(trialWaiver\?\.target === packet\.target && \{ updateTrialWaived: true \}\),/g,
    ) ?? [];
  assert.equal(builds.length, 2);
  assert.equal(spreads.length, builds.length);
  assert.equal(waived.length, builds.length);
});

test("publish.mjs builds every updater descriptor in the staging tool's platform order", () => {
  // Regression: the staged, immutable stable/<version>.json lists windows-x86_64 before darwin-aarch64; an
  // alphabetical order produces different bytes and the frozen-file check refuses the publication.
  const source = readFileSync(new URL("./publish.mjs", import.meta.url), "utf8");
  assert.match(source, /const UPDATER_TARGET_ORDER = \["windows-x86_64", "darwin-aarch64"\];/);
  assert.equal((source.match(/createPlatformUpdaterManifest\(/g) ?? []).length, 2);
  assert.equal((source.match(/inUpdaterOrder\((?:packets|downloadedInputs)\)/g) ?? []).length, 2);
});

test("stable generators reject prerelease versions before artifact I/O", async () => {
  const input = fixture();
  input.build.version = "1.2.3-beta.1";
  const common = { requestedChannel: "stable", publishedAt: "2026-09-25T12:00:00.000Z", notes: "Update." };
  await assert.rejects(createUpdaterManifest({ ...input, ...common }), /prerelease/);
  await assert.rejects(
    createPlatformUpdaterManifest({ ...common, artifacts: [{ ...input, target: "windows-x86_64" }] }),
    /prerelease/,
  );
});

function macFixture() {
  const file = "KalCode_1.2.3_arm64.dmg";
  const dir = mkdtempSync(join(tmpdir(), "kalcode-mac-feed-"));
  const artifactPath = join(dir, file);
  const signaturePath = `${artifactPath}.sig`;
  writeFileSync(artifactPath, artifactBytes);
  writeFileSync(
    signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:darwin-aarch64", "channel:stable"], file),
  );
  const build = {
    schemaVersion: 1,
    platform: "macos",
    arch: "arm64",
    version: "1.2.3",
    file,
    size: artifactBytes.length,
    sha256: artifactSha256,
    commit,
    notarySubmissionId: "12345678-1234-4234-8234-123456789abc",
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
  const verify = {
    ...build,
    status: "passed",
    exactArtifact: true,
    developerIdApplication: true,
    expectedTeam: true,
    hardenedRuntime: true,
    timestamped: true,
    entitlementsExact: true,
    notaryAccepted: true,
    notaryLogIssueFree: true,
    ticketStapled: true,
    gatekeeperAccepted: true,
  };
  const qa = qaEvidence("darwin-aarch64");
  return {
    target: "darwin-aarch64",
    build,
    verify,
    qa,
    artifactPath,
    signaturePath,
    artifactKey: `releases/updater/stable/1.2.3/${artifactSha256}/${file}`,
    publicKeyBase64: releaseSigner.publicKeyBase64,
  };
}

test("v2 publishes only the verified platforms without inventing parity", async () => {
  const mac = macFixture();
  const options = {
    artifacts: [mac],
    requestedChannel: "stable",
    publishedAt: "2026-09-25T12:00:00.000Z",
    notes: "Update.",
  };
  const macOnly = await createPlatformUpdaterManifest(options);
  assert.deepEqual(Object.keys(macOnly.platforms), ["darwin-aarch64"]);
  assert.equal(macOnly.kalcode.artifacts["darwin-aarch64"].format, "dmg");
  const windows = { ...fixture(), target: "windows-x86_64" };
  windows.signaturePath = `${windows.artifactPath}.windows-x86_64.sig`;
  writeFileSync(
    windows.signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:windows-x86_64", "channel:stable"]),
  );
  const both = await createPlatformUpdaterManifest({ ...options, artifacts: [windows, mac] });
  assert.deepEqual(Object.keys(both.platforms), ["windows-x86_64", "darwin-aarch64"]);
  mac.build.commit = "b".repeat(40);
  await assert.rejects(
    createPlatformUpdaterManifest({ ...options, artifacts: [windows, mac] }),
    /exact version and source commit/,
  );
});

test("v2 Mac feed refuses incomplete signing, physical QA and channel evidence", async () => {
  for (const corrupt of [
    (input) => {
      input.build.helpers.pop();
    },
    (input) => {
      input.build.helpers[0].signed = false;
    },
    (input) => {
      input.build.releaseDescriptorEligible = false;
    },
    (input) => {
      input.build.compiledChannelVerification.method = "unverified";
    },
    (input) => {
      input.verify.notaryAccepted = false;
    },
    (input) => {
      input.verify.gatekeeperAccepted = false;
    },
    (input) => {
      input.verify.commit = "b".repeat(40);
    },
    (input) => {
      input.qa.checks.kalvoice = false;
    },
    (input) => {
      input.qa.release.sha256 = "b".repeat(64);
    },
    (input) => {
      input.build.compiledChannelVerification.testHooks = true;
    },
    (input) => {
      input.build.compiledChannel = "development";
    },
  ]) {
    const mac = macFixture();
    corrupt(mac);
    await assert.rejects(
      createPlatformUpdaterManifest({
        artifacts: [mac],
        requestedChannel: "stable",
        publishedAt: "2026-09-25T12:00:00.000Z",
        notes: "Update.",
      }),
    );
  }
});

test("Mac Beta and Dev publication retain exact channel-bound final QA", async () => {
  for (const channel of ["beta", "dev"]) {
    const mac = macFixture();
    mac.build.requestedReleaseChannel = channel;
    mac.build.compiledChannel = channel === "dev" ? "development" : channel;
    mac.build.compiledChannelVerification.channel = mac.build.compiledChannel;
    mac.artifactKey = `releases/updater/${channel}/1.2.3/${artifactSha256}/${mac.build.file}`;
    writeFileSync(
      mac.signaturePath,
      signature("1.2.3", artifactBytes, releaseSigner, ["target:darwin-aarch64", `channel:${channel}`], mac.build.file),
    );
    mac.qa.channel = channel;
    mac.qa.updateTrial.method = "signed-local-candidate-v1";
    const manifest = await createPlatformUpdaterManifest({
      artifacts: [mac],
      requestedChannel: channel,
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Preview update.",
    });
    assert.equal(manifest.kalcode.channel, channel);
    mac.qa.channel = "stable";
    await assert.rejects(
      createPlatformUpdaterManifest({
        artifacts: [mac],
        requestedChannel: channel,
        publishedAt: "2026-09-25T12:00:00.000Z",
        notes: "Preview update.",
      }),
      /channel does not match/,
    );
  }
});

// ---- Fast-lane automated QA (schemaVersion 3, owner policy 2026-10-02) ----
function automatedQa(target = "windows-x86_64", { changesData = false, changesUpdater = false, guard } = {}) {
  const live = { version: "1.2.2", commit: baselineCommit, sha256: baselineSha256 };
  const candidate = { version: "1.2.3", commit, sha256: artifactSha256 };
  const roundTrip = changesUpdater && !changesData;
  return {
    schemaVersion: 3,
    status: "passed",
    target,
    channel: "stable",
    release: { ...candidate },
    safeguards: {
      testHooks: false,
      cacheSeeded: false,
      authenticationBypassed: false,
      tlsBypassed: false,
      fixtureOnly: false,
    },
    checks: {
      install: true,
      cleanInstall: true,
      launch: true,
      updateFromLive: true,
      dataKept: true,
      ...((guard ?? changesData) && { restoreGuard: true }),
    },
    updateTrial: {
      method: "automated-update-from-live-v1",
      live: { ...live },
      candidate: { ...candidate },
      changesData,
      changesUpdater,
      outcomes: [
        { step: "update", from: { ...live }, to: { ...candidate }, passed: true },
        ...(roundTrip
          ? [
              { step: "rollback", from: { ...candidate }, to: { ...live }, passed: true },
              { step: "reupdate", from: { ...live }, to: { ...candidate }, passed: true },
            ]
          : []),
      ],
    },
  };
}

const automatedExpected = (target = "windows-x86_64") => ({
  target,
  channel: "stable",
  release: { version: "1.2.3", commit, sha256: artifactSha256 },
});

test("v3 automated QA is accepted for update-from-live, data-changing and updater-changing builds", () => {
  assert.deepEqual(updaterQaProblems(automatedQa(), automatedExpected(), "final"), []);
  assert.deepEqual(updaterQaProblems(automatedQa(undefined, { changesData: true }), automatedExpected(), "final"), []);
  assert.deepEqual(
    updaterQaProblems(automatedQa(undefined, { changesUpdater: true }), automatedExpected(), "final"),
    [],
  );
  assert.deepEqual(
    updaterQaProblems(
      automatedQa(undefined, { changesData: true, changesUpdater: true }),
      automatedExpected(),
      "final",
    ),
    [],
  );
  const pending = { ...automatedQa(), status: "preliminary-passed", updateTrial: null };
  assert.deepEqual(updaterQaProblems(pending, automatedExpected(), "preliminary"), []);
  assert.match(updaterQaProblems(pending, automatedExpected(), "final").join("\n"), /completed/);
});

test("v3 automated QA refuses any safeguard, a missing check, or a missing restore guard on a data change", () => {
  for (const key of ["testHooks", "cacheSeeded", "authenticationBypassed", "tlsBypassed", "fixtureOnly"]) {
    const record = automatedQa();
    record.safeguards[key] = true;
    assert.match(updaterQaProblems(record, automatedExpected(), "final").join("\n"), /test hook, cache seed/);
  }
  for (const key of ["install", "cleanInstall", "launch", "updateFromLive", "dataKept"]) {
    const record = automatedQa();
    record.checks[key] = false;
    assert.match(updaterQaProblems(record, automatedExpected(), "final").join("\n"), /checks are incomplete/);
  }
  const unguarded = automatedQa(undefined, { changesData: true, guard: false });
  assert.match(updaterQaProblems(unguarded, automatedExpected(), "final").join("\n"), /restoreGuard/);
  const falseGuard = automatedQa(undefined, { changesData: true });
  falseGuard.checks.restoreGuard = false;
  assert.notDeepEqual(updaterQaProblems(falseGuard, automatedExpected(), "final"), []);
  const strayGuard = automatedQa(undefined, { guard: true });
  assert.match(updaterQaProblems(strayGuard, automatedExpected(), "final").join("\n"), /only to a data-changing/);
  const noRoundTrip = automatedQa(undefined, { changesUpdater: true });
  noRoundTrip.updateTrial.outcomes = noRoundTrip.updateTrial.outcomes.slice(0, 1);
  assert.match(updaterQaProblems(noRoundTrip, automatedExpected(), "final").join("\n"), /rollback, and re-update/);
  for (const mutate of [
    (record) => (record.release.sha256 = "9".repeat(64)),
    (record) => (record.updateTrial.method = "public-unlisted-immutable-version-v1"),
    (record) => (record.updateTrial.live.version = "1.2.3"),
    (record) => (record.updateTrial.outcomes[0].passed = false),
    (record) => (record.updateTrial.outcomes[0].from.commit = "e".repeat(40)),
    (record) => delete record.updateTrial.changesData,
    (record) => (record.checks.auth = true),
    (record) => (record.target = "darwin-aarch64"),
  ]) {
    const record = automatedQa();
    mutate(record);
    assert.notDeepEqual(updaterQaProblems(record, automatedExpected(), "final"), []);
  }
});

test("v3 change declarations must match the live-to-candidate source diff", () => {
  const data = automatedQa(undefined, { changesData: true });
  assert.deepEqual(qaChangeDeclarationProblems(data, ["crates/native-core/migrations/0021_threads_effort.sql"]), []);
  assert.match(
    qaChangeDeclarationProblems(automatedQa(), ["crates/native-core/migrations/0021_x.sql"]).join(),
    /changesData/,
  );
  assert.match(qaChangeDeclarationProblems(data, ["apps/desktop/src/App.tsx"]).join(), /changesData/);
  assert.match(qaChangeDeclarationProblems(automatedQa(), ["crates/updater/src/lib.rs"]).join(), /changesUpdater/);
  assert.deepEqual(
    qaChangeDeclarationProblems(automatedQa(undefined, { changesUpdater: true }), ["crates/updater/src/lib.rs"]),
    [],
  );
  assert.deepEqual(
    qaChangeDeclarationProblems(qaEvidence("windows-x86_64"), ["crates/native-core/migrations/x.sql"]),
    [],
  );
});

test("a v3 automated QA record publishes the same signed Windows descriptor as a v2 record", async () => {
  const input = fixture();
  input.signaturePath = `${input.artifactPath}.windows-x86_64.sig`;
  writeFileSync(
    input.signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:windows-x86_64", "channel:stable"]),
  );
  const common = { requestedChannel: "stable", publishedAt: "2026-09-25T12:00:00.000Z", notes: "Update." };
  const v2 = await createPlatformUpdaterManifest({ ...common, artifacts: [{ ...input, target: "windows-x86_64" }] });
  const v3 = await createPlatformUpdaterManifest({
    ...common,
    artifacts: [{ ...input, qa: automatedQa("windows-x86_64", { changesData: true }), target: "windows-x86_64" }],
  });
  assert.equal(JSON.stringify(v3), JSON.stringify(v2));
  const unsafe = automatedQa("windows-x86_64");
  unsafe.safeguards.testHooks = true;
  await assert.rejects(
    createPlatformUpdaterManifest({ ...common, artifacts: [{ ...input, qa: unsafe, target: "windows-x86_64" }] }),
    /test hook, cache seed/,
  );
});

test("publish.mjs publishes only builds of origin/main or an explicitly named pushed release branch", () => {
  const source = readFileSync(new URL("./publish.mjs", import.meta.url), "utf8");
  assert.match(source, /const buildRef = releaseBranch \? `origin\/\$\{releaseBranch\}` : "origin\/main";/);
  assert.match(source, /KALCODE_RELEASE_BRANCH must name a release\/<name> branch/);
  assert.match(source, /\["merge-base", "--is-ancestor", releaseBuild\.commit, buildRef\]/);
});
