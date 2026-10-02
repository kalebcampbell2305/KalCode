import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  GUARDIAN_FILENAME,
  guardianBuildArgs,
  guardianBundleOverlay,
  guardianInstalledProblems,
  guardianSignatureEvidence,
  validateGuardianBuildEvidence,
} from "./guardian-packaging.mjs";

const sha256 = "ab".repeat(32);
const publisherIdentity = "1.3.6.1.4.1.311.97.2.9.9";
const buildSource = readFileSync(new URL("./build-windows.mjs", import.meta.url), "utf8");
const verifySource = readFileSync(new URL("./verify-windows.mjs", import.meta.url), "utf8");

test("guardian uses the exact production bin and is mapped beside the installed application", () => {
  assert.deepEqual(guardianBuildArgs(), [
    "build",
    "--locked",
    "--release",
    "-p",
    "kalcode-providers",
    "--bin",
    "kalcode-provider-guardian",
  ]);

  const guardianPath = resolve("target", "release", GUARDIAN_FILENAME);
  const signCommand = { cmd: resolve("node.exe"), args: [resolve("sign.mjs"), "%1"] };
  const overlay = guardianBundleOverlay({
    guardianPath,
    signingOverlay: { bundle: { windows: { digestAlgorithm: "sha256", signCommand } } },
  });
  assert.deepEqual(overlay.bundle.resources, { [guardianPath]: GUARDIAN_FILENAME });
  assert.deepEqual(overlay.bundle.windows.signCommand, signCommand);
  assert.equal(overlay.bundle.externalBin, undefined);
});

test("guardian signature evidence requires a timestamp and the pinned publisher identity", () => {
  assert.deepEqual(
    guardianSignatureEvidence({
      signature: { status: "Valid", timestamped: true },
      identityOids: [publisherIdentity],
      publisherIdentityOids: [publisherIdentity],
      signingRequired: true,
    }),
    {
      signed: true,
      signatureStatus: "Valid",
      timestamped: true,
      publisherIdentityBound: true,
    },
  );
  assert.throws(
    () =>
      guardianSignatureEvidence({
        signature: { status: "Valid", timestamped: false },
        identityOids: [publisherIdentity],
        publisherIdentityOids: [publisherIdentity],
        signingRequired: true,
      }),
    /timestamped/,
  );
  assert.throws(
    () =>
      guardianSignatureEvidence({
        signature: { status: "Valid", timestamped: true },
        identityOids: ["1.2.3"],
        publisherIdentityOids: [publisherIdentity],
        signingRequired: true,
      }),
    /publisher identity/,
  );
});

test("unsigned guardian simulation is explicit and cannot validate as publishable evidence", () => {
  assert.deepEqual(
    guardianSignatureEvidence({
      signature: { status: "NotSigned", timestamped: false },
      identityOids: [],
      publisherIdentityOids: [],
      signingRequired: false,
    }),
    {
      signed: false,
      signatureStatus: "NotSigned",
      timestamped: false,
      publisherIdentityBound: false,
    },
  );
  assert.throws(
    () =>
      validateGuardianBuildEvidence({
        file: GUARDIAN_FILENAME,
        sha256,
        signed: false,
        signatureStatus: "NotSigned",
        timestamped: false,
        publisherIdentityBound: false,
        bundledBesideApplication: true,
      }),
    /signed guardian/,
  );
});

test("installed guardian proof rejects missing, changed, unsigned and wrong-signer helpers", () => {
  const buildGuardian = {
    file: GUARDIAN_FILENAME,
    sha256,
    signed: true,
    signatureStatus: "Valid",
    timestamped: true,
    publisherIdentityBound: true,
    bundledBesideApplication: true,
  };
  assert.deepEqual(validateGuardianBuildEvidence(buildGuardian), buildGuardian);
  assert.deepEqual(
    guardianInstalledProblems({
      buildGuardian,
      exists: true,
      sha256,
      signature: { status: "Valid", timestamped: true },
      sameSignerAsInstaller: true,
    }),
    [],
  );

  assert.match(guardianInstalledProblems({ buildGuardian, exists: false })[0], /missing/);
  assert.ok(
    guardianInstalledProblems({
      buildGuardian,
      exists: true,
      sha256: "cd".repeat(32),
      signature: { status: "Valid", timestamped: true },
      sameSignerAsInstaller: true,
    }).some((problem) => /SHA-256/.test(problem)),
  );
  assert.ok(
    guardianInstalledProblems({
      buildGuardian,
      exists: true,
      sha256,
      signature: { status: "NotSigned", timestamped: false },
      sameSignerAsInstaller: true,
    }).some((problem) => /signature/.test(problem)),
  );
  assert.ok(
    guardianInstalledProblems({
      buildGuardian,
      exists: true,
      sha256,
      signature: { status: "Valid", timestamped: true },
      sameSignerAsInstaller: false,
    }).some((problem) => /signer/.test(problem)),
  );
});

test("release build signs and verifies the guardian before Tauri bundles it", () => {
  const buildGuardian = buildSource.indexOf('run("cargo", guardianBuildArgs()');
  const signGuardian = buildSource.indexOf("signTarget({ targetPath: builtGuardian");
  const verifyGuardian = buildSource.indexOf("guardianSignatureEvidence({", signGuardian);
  const bundle = buildSource.indexOf('run("pnpm", tauriArgs');
  assert.ok(
    buildGuardian >= 0 && signGuardian > buildGuardian && verifyGuardian > signGuardian && bundle > verifyGuardian,
  );
  assert.match(buildSource, /guardianBundleOverlay/);
  assert.match(buildSource, /guardian:\s*\{/);
  assert.match(buildSource, /sha256: guardianSha256/);
});

test("installer verification measures every installed guardian instead of trusting build metadata", () => {
  assert.match(verifySource, /guardianInstalledProblems/);
  assert.match(verifySource, /await sha256File\(guardian\)/);
  assert.match(verifySource, /authenticodeStatus\(guardian, powershellJson\)/);
  assert.match(verifySource, /sameAuthenticodeSigner\(installer, guardian, powershellJson\)/);
  assert.match(verifySource, /allInstallPassesVerified/);
});

test("clearStaleGuardian removes only the guardian bin's link outputs so cargo relinks it", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { clearStaleGuardian, staleGuardianOutputs } = await import("./guardian-packaging.mjs");
  const target = mkdtempSync(join(tmpdir(), "kalcode-guardian-stale-"));
  try {
    const release = join(target, "release");
    mkdirSync(join(release, "deps"), { recursive: true });
    const binFp = join(release, ".fingerprint", "kalcode-providers-0a1b");
    const libFp = join(release, ".fingerprint", "kalcode-providers-2c3d");
    mkdirSync(binFp, { recursive: true });
    mkdirSync(libFp, { recursive: true });
    writeFileSync(join(binFp, "bin-kalcode-provider-guardian"), "x");
    writeFileSync(join(libFp, "lib-kalcode_providers"), "x");
    for (const f of [
      "kalcode_provider_guardian-0a1b.exe",
      "kalcode_provider_guardian-0a1b.pdb",
      "kalcode_provider_guardian-0a1b.d",
      "libkalcode_providers-2c3d.rlib",
    ]) {
      writeFileSync(join(release, "deps", f), "x");
    }
    writeFileSync(join(release, GUARDIAN_FILENAME), "old");
    assert.equal(staleGuardianOutputs(target).length, 4);
    const removed = clearStaleGuardian(target);
    assert.equal(removed.length, 5);
    assert.equal(existsSync(join(release, GUARDIAN_FILENAME)), false);
    assert.equal(existsSync(binFp), false);
    assert.equal(existsSync(libFp), true, "the providers library fingerprint stays, so dependents are not recompiled");
    assert.equal(existsSync(join(release, "deps", "libkalcode_providers-2c3d.rlib")), true);
    assert.deepEqual(clearStaleGuardian(target), [], "idempotent");
    assert.deepEqual(clearStaleGuardian(join(target, "missing")), []);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("build-windows clears the guardian's stale link outputs before building it", () => {
  assert.match(buildSource, /clearStaleGuardian\(TARGET_DIR\);\s*\n\s*run\("cargo", guardianBuildArgs\(\)/);
});
