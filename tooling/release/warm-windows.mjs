#!/usr/bin/env node
// Compile-only warm-up of the Windows release build for the checkout this file lives in. It mirrors build-windows.mjs's
// Cargo/Tauri invocations and compile-time environment (stable channel, updater public key, Authenticode identity OIDs,
// release version overlay) so the next signed `release:build` in the same checkout only recompiles what changed.
// It signs nothing, stages nothing and writes nothing outside target/. Ported from the release kit's proven
// rebuild-helpers.mjs `warm` (0.1.8+944 / 0.1.8+1037 / 0.1.9+1038 builds).
//
//   node tooling/release/warm-windows.mjs            (run from a clean release worktree)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearStaleGuardian,
  GUARDIAN_FILENAME,
  guardianBuildArgs,
  guardianBundleOverlay,
} from "./guardian-packaging.mjs";
import { clearStaleHook, HOOK_FILENAME, hookBuildArgs, hookBundleOverlay } from "./hook-packaging.mjs";
import {
  assertCleanTree,
  headCommit,
  ROOT,
  releaseVersion,
  releaseVersionOverlay,
  run,
  TARGET_DIR,
  writeJson,
} from "./lib.mjs";
import { buildEnvironment } from "./release-channel.mjs";
import { ARTIFACT_SIGNING, buildSigningOverlay, signingEnvironment } from "./signing.mjs";
import { readUpdaterPublicKey, UPDATER_SIGNER_MANIFEST } from "./updater-signing.mjs";

if (process.platform !== "win32") {
  console.error("warm-windows.mjs warms the Windows release build; run it on the Windows release machine.");
  process.exit(1);
}

assertCleanTree("A warm build");
const base = buildEnvironment(process.env, "stable");
delete base.KALCODE_ARTIFACT_SIGNING_METADATA;
const seconds = {};
let t = Date.now();
const lap = (name) => {
  seconds[name] = Math.round((Date.now() - t) / 1000);
  t = Date.now();
};

// The release build relinks the guardian anyway; never leave a link output a later build could mistake for its own.
clearStaleGuardian(TARGET_DIR);
clearStaleHook(TARGET_DIR);
run("cargo", guardianBuildArgs(), { env: { ...base, CARGO_TARGET_DIR: TARGET_DIR } });
lap("guardian");
run("cargo", hookBuildArgs(), { env: { ...base, CARGO_TARGET_DIR: TARGET_DIR } });
lap("hook");

const desktopEnv = {
  ...signingEnvironment(base),
  KALCODE_UPDATER_PUBLIC_KEY: readUpdaterPublicKey(),
  KALCODE_AUTHENTICODE_IDENTITY_OIDS: ARTIFACT_SIGNING.publisherIdentityOid,
  CARGO_TARGET_DIR: TARGET_DIR,
};
const workspace = mkdtempSync(join(tmpdir(), "kalcode-release-warm-"));
try {
  const overlayPath = join(workspace, "tauri.bundle.json");
  writeJson(overlayPath, {
    ...hookBundleOverlay({
      hookPath: join(TARGET_DIR, "release", HOOK_FILENAME),
      signingOverlay: guardianBundleOverlay({
        guardianPath: join(TARGET_DIR, "release", GUARDIAN_FILENAME),
        signingOverlay: buildSigningOverlay({
          nodePath: process.execPath,
          signerPath: join(ROOT, "tooling", "release", "sign-windows.mjs"),
        }),
      }),
    }),
    version: releaseVersionOverlay(releaseVersion()).version,
  });
  run(
    "pnpm",
    [
      "--filter",
      "@kalcode/desktop",
      "tauri",
      "build",
      "--bundles",
      "nsis",
      "--features",
      "kalvoice-whisper",
      "--no-sign",
      "--config",
      overlayPath,
    ],
    { env: desktopEnv },
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
lap("desktopAndNsis");

run("cargo", ["build", "--quiet", "--locked", "--release", "--manifest-path", UPDATER_SIGNER_MANIFEST], {
  env: { ...process.env, CARGO_TARGET_DIR: TARGET_DIR },
});
lap("updaterSigner");
// A warm guardian must not survive into the signed build (build-windows.mjs relinks and signs its own).
clearStaleGuardian(TARGET_DIR);
clearStaleHook(TARGET_DIR);
assertCleanTree("After the warm build, the working tree");
console.log(JSON.stringify({ warmed: true, commit: headCommit(), seconds }));
