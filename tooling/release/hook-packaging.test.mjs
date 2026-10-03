import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  clearStaleHook,
  HOOK_FILENAME,
  hookBuildArgs,
  hookBundleOverlay,
  hookInstalledProblems,
  hookPublicVerificationProblems,
  hookSignatureEvidence,
  staleHookOutputs,
  validateHookBuildEvidence,
} from "./hook-packaging.mjs";

const sha256 = "ab".repeat(32);
const publisherIdentity = "1.3.6.1.4.1.311.97.2.9.9";
const buildSource = readFileSync(new URL("./build-windows.mjs", import.meta.url), "utf8");
const verifySource = readFileSync(new URL("./verify-windows.mjs", import.meta.url), "utf8");
const signingSource = readFileSync(new URL("./signing.mjs", import.meta.url), "utf8");

function buildEvidence() {
  return {
    file: HOOK_FILENAME,
    sha256,
    signed: true,
    signatureStatus: "Valid",
    timestamped: true,
    publisherIdentityBound: true,
    bundledBesideApplication: true,
  };
}

function installedEvidence() {
  return {
    file: HOOK_FILENAME,
    sha256,
    signatureStatus: "Valid",
    timestamped: true,
    signerMatchesInstaller: true,
  };
}

test("hook helper uses the production bin and is mapped beside the installed application", () => {
  assert.deepEqual(hookBuildArgs(), [
    "build",
    "--locked",
    "--release",
    "-p",
    "kalcode-hook-bridge",
    "--bin",
    "kalcode-hook",
  ]);

  const hookPath = resolve("target", "release", HOOK_FILENAME);
  const guardianPath = resolve("target", "release", "kalcode-provider-guardian.exe");
  const signCommand = { cmd: resolve("node.exe"), args: [resolve("sign.mjs"), "%1"] };
  const overlay = hookBundleOverlay({
    hookPath,
    signingOverlay: {
      bundle: {
        resources: { [guardianPath]: "kalcode-provider-guardian.exe" },
        windows: { digestAlgorithm: "sha256", signCommand },
      },
    },
  });
  assert.deepEqual(overlay.bundle.resources, {
    [guardianPath]: "kalcode-provider-guardian.exe",
    [hookPath]: HOOK_FILENAME,
  });
  assert.deepEqual(overlay.bundle.windows.signCommand, signCommand);
});

test("hook signature evidence requires a timestamp and the pinned publisher identity", () => {
  assert.deepEqual(
    hookSignatureEvidence({
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
      hookSignatureEvidence({
        signature: { status: "Valid", timestamped: false },
        identityOids: [publisherIdentity],
        publisherIdentityOids: [publisherIdentity],
        signingRequired: true,
      }),
    /timestamped/,
  );
  assert.throws(
    () =>
      hookSignatureEvidence({
        signature: { status: "Valid", timestamped: true },
        identityOids: ["1.2.3"],
        publisherIdentityOids: [publisherIdentity],
        signingRequired: true,
      }),
    /publisher identity/,
  );
});

test("unsigned hook simulation cannot validate as publishable evidence", () => {
  assert.deepEqual(
    hookSignatureEvidence({
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
      validateHookBuildEvidence({
        file: HOOK_FILENAME,
        sha256,
        signed: false,
        signatureStatus: "NotSigned",
        timestamped: false,
        publisherIdentityBound: false,
        bundledBesideApplication: true,
      }),
    /signed hook helper/,
  );
});

test("installed hook proof rejects missing, changed, unsigned and wrong-signer helpers", () => {
  const buildHook = buildEvidence();
  assert.deepEqual(validateHookBuildEvidence(buildHook), buildHook);
  assert.deepEqual(
    hookInstalledProblems({
      buildHook,
      exists: true,
      sha256,
      signature: { status: "Valid", timestamped: true },
      sameSignerAsInstaller: true,
    }),
    [],
  );
  assert.match(hookInstalledProblems({ buildHook, exists: false })[0], /missing/);
  assert.ok(
    hookInstalledProblems({
      buildHook,
      exists: true,
      sha256: "cd".repeat(32),
      signature: { status: "Valid", timestamped: true },
      sameSignerAsInstaller: true,
    }).some((problem) => /SHA-256/.test(problem)),
  );
  assert.ok(
    hookInstalledProblems({
      buildHook,
      exists: true,
      sha256,
      signature: { status: "NotSigned", timestamped: false },
      sameSignerAsInstaller: true,
    }).some((problem) => /signature/.test(problem)),
  );
  assert.ok(
    hookInstalledProblems({
      buildHook,
      exists: true,
      sha256,
      signature: { status: "Valid", timestamped: true },
      sameSignerAsInstaller: false,
    }).some((problem) => /signer/.test(problem)),
  );
});

test("publication rejects a missing or substituted hook in any install pass", () => {
  const buildHook = buildEvidence();
  const passes = ["no-shortcuts", "default", "upgrade"].map((name) => ({
    name,
    installedHook: installedEvidence(),
  }));
  const verifyHook = {
    file: HOOK_FILENAME,
    sha256,
    signatureStatus: "Valid",
    timestamped: true,
    publisherIdentityBound: true,
    allInstallPassesVerified: true,
  };
  assert.deepEqual(hookPublicVerificationProblems(buildHook, verifyHook, passes), []);
  assert.match(hookPublicVerificationProblems(buildHook, undefined, passes).join("\n"), /hook helper/);
  assert.match(
    hookPublicVerificationProblems(
      buildHook,
      verifyHook,
      passes.map((pass, index) =>
        index === 2 ? { ...pass, installedHook: { ...pass.installedHook, sha256: "cd".repeat(32) } } : pass,
      ),
    ).join("\n"),
    /upgrade.*hook/,
  );
});

test("clearStaleHook removes only the hook bin link outputs so Cargo relinks it", () => {
  const target = mkdtempSync(join(tmpdir(), "kalcode-hook-stale-"));
  try {
    const release = join(target, "release");
    mkdirSync(join(release, "deps"), { recursive: true });
    const binFp = join(release, ".fingerprint", "kalcode-hook-bridge-0a1b");
    const libFp = join(release, ".fingerprint", "kalcode-hook-bridge-2c3d");
    mkdirSync(binFp, { recursive: true });
    mkdirSync(libFp, { recursive: true });
    writeFileSync(join(binFp, "bin-kalcode-hook"), "x");
    writeFileSync(join(libFp, "lib-kalcode_hook_bridge"), "x");
    for (const file of [
      "kalcode_hook-0a1b.exe",
      "kalcode_hook-0a1b.pdb",
      "kalcode_hook-0a1b.d",
      "libkalcode_hook_bridge-2c3d.rlib",
    ]) {
      writeFileSync(join(release, "deps", file), "x");
    }
    writeFileSync(join(release, HOOK_FILENAME), "old");
    assert.equal(staleHookOutputs(target).length, 4);
    assert.equal(clearStaleHook(target).length, 5);
    assert.equal(existsSync(join(release, HOOK_FILENAME)), false);
    assert.equal(existsSync(binFp), false);
    assert.equal(existsSync(libFp), true, "the hook library fingerprint remains available to the desktop build");
    assert.equal(existsSync(join(release, "deps", "libkalcode_hook_bridge-2c3d.rlib")), true);
    assert.deepEqual(clearStaleHook(target), []);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("Windows build signs and verifies the hook before bundling it", () => {
  const buildHook = buildSource.indexOf('run("cargo", hookBuildArgs()');
  const signHook = buildSource.indexOf("signTarget({ targetPath: builtHook");
  const verifyHook = buildSource.indexOf("hookSignatureEvidence({", signHook);
  const bundle = buildSource.indexOf('run("pnpm", tauriArgs');
  assert.ok(buildHook >= 0 && signHook > buildHook && verifyHook > signHook && bundle > verifyHook);
  assert.match(buildSource, /hookBundleOverlay/);
  assert.match(buildSource, /hook:\s*\{/);
  assert.match(buildSource, /sha256: hookSha256/);
});

test("Windows verification measures the installed hook in install and upgrade passes", () => {
  assert.match(verifySource, /hookInstalledProblems/);
  assert.match(verifySource, /await sha256File\(hook\)/);
  assert.match(verifySource, /authenticodeStatus\(hook, powershellJson\)/);
  assert.match(verifySource, /sameAuthenticodeSigner\(installer, hook, powershellJson\)/);
  assert.match(verifySource, /installedHook/);
  assert.match(verifySource, /allInstallPassesVerified/);
});

test("public signing and publication verification require hook evidence", () => {
  assert.match(signingSource, /hookPublicSigningProblems\(build\.hook\)/);
  assert.match(signingSource, /hookPublicVerificationProblems\(build\.hook, verify\.hook, verify\.passes\)/);
});
