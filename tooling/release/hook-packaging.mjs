import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

export const HOOK_FILENAME = "kalcode-hook.exe";

export function hookBuildArgs() {
  return ["build", "--locked", "--release", "-p", "kalcode-hook-bridge", "--bin", "kalcode-hook"];
}

/** Cargo outputs that can otherwise let a signed helper from an earlier build survive unchanged. */
export function staleHookOutputs(targetDir) {
  const release = join(targetDir, "release");
  const paths = [];
  const deps = join(release, "deps");
  if (existsSync(deps)) {
    for (const name of readdirSync(deps)) {
      if (/^kalcode_hook-[0-9a-f]+(\.exe|\.pdb|\.d)?$/.test(name)) paths.push(join(deps, name));
    }
  }
  const fingerprints = join(release, ".fingerprint");
  if (existsSync(fingerprints)) {
    for (const name of readdirSync(fingerprints)) {
      if (!/^kalcode-hook-bridge-[0-9a-f]+$/.test(name)) continue;
      const dir = join(fingerprints, name);
      if (readdirSync(dir).some((file) => file.startsWith("bin-kalcode-hook"))) paths.push(dir);
    }
  }
  return paths;
}

/** Removes only the hook executable's prior link outputs so the release build must relink it. */
export function clearStaleHook(targetDir) {
  const removed = [...staleHookOutputs(targetDir), join(targetDir, "release", HOOK_FILENAME)].filter((path) =>
    existsSync(path),
  );
  for (const path of removed) rmSync(path, { recursive: true, force: true });
  return removed;
}

/** Adds the already-built hook helper as an application sibling in the Windows bundle. */
export function hookBundleOverlay({ hookPath, signingOverlay = {} }) {
  if (!isAbsolute(hookPath) || basename(hookPath) !== HOOK_FILENAME) {
    throw new Error("hook bundle source must be the absolute canonical release binary path");
  }
  const bundle = signingOverlay.bundle ?? {};
  const resources = bundle.resources ?? {};
  if (Object.values(resources).some((target) => target === HOOK_FILENAME && resources[hookPath] !== HOOK_FILENAME)) {
    throw new Error("hook bundle destination is already claimed by another resource");
  }
  return {
    ...signingOverlay,
    bundle: {
      ...bundle,
      resources: {
        ...resources,
        [hookPath]: HOOK_FILENAME,
      },
    },
  };
}

function sameIdentity(actual, expected) {
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length > 0 &&
    actual.length === expected.length &&
    actual.every((oid, index) => oid === expected[index])
  );
}

/** Converts measured Authenticode state into closed, redacted build evidence. */
export function hookSignatureEvidence({ signature, identityOids, publisherIdentityOids, signingRequired }) {
  if (signingRequired) {
    if (signature?.status !== "Valid" || signature?.timestamped !== true) {
      throw new Error("hook helper must have a valid timestamped Authenticode signature");
    }
    if (!sameIdentity(identityOids, publisherIdentityOids)) {
      throw new Error("hook helper signature does not match the approved publisher identity");
    }
    return {
      signed: true,
      signatureStatus: "Valid",
      timestamped: true,
      publisherIdentityBound: true,
    };
  }
  if (
    signature?.status !== "NotSigned" ||
    signature?.timestamped === true ||
    (Array.isArray(identityOids) && identityOids.length > 0)
  ) {
    throw new Error("unsigned local simulation requires an unsigned hook helper");
  }
  return {
    signed: false,
    signatureStatus: "NotSigned",
    timestamped: false,
    publisherIdentityBound: false,
  };
}

export function validateHookBuildEvidence(hook) {
  if (!hook || typeof hook !== "object") {
    throw new Error("public Windows releases require signed hook helper build evidence");
  }
  if (hook.file !== HOOK_FILENAME || hook.bundledBesideApplication !== true) {
    throw new Error("public Windows releases require the canonical hook helper beside the application");
  }
  if (typeof hook.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(hook.sha256)) {
    throw new Error("public Windows releases require the hook helper SHA-256");
  }
  if (
    hook.signed !== true ||
    hook.signatureStatus !== "Valid" ||
    hook.timestamped !== true ||
    hook.publisherIdentityBound !== true
  ) {
    throw new Error("public Windows releases require a signed hook helper with pinned publisher evidence");
  }
  return hook;
}

/** Pure verifier for one installed helper. */
export function hookInstalledProblems({ buildHook, exists, sha256, signature, sameSignerAsInstaller }) {
  const problems = [];
  try {
    validateHookBuildEvidence(buildHook);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return problems;
  }
  if (!exists) {
    problems.push("installed hook helper is missing");
    return problems;
  }
  if (sha256 !== buildHook.sha256) {
    problems.push("installed hook helper SHA-256 does not match the signed build input");
  }
  if (signature?.status !== "Valid" || signature?.timestamped !== true) {
    problems.push("installed hook helper signature is invalid, unsigned, or not timestamped");
  }
  if (sameSignerAsInstaller !== true) {
    problems.push("installed hook helper signer does not match the installer signer");
  }
  return problems;
}

export function hookPublicSigningProblems(hook) {
  try {
    validateHookBuildEvidence(hook);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function hookPublicVerificationProblems(buildHook, verifyHook, passes) {
  const problems = hookPublicSigningProblems(buildHook);
  if (problems.length > 0) return problems;
  if (
    !verifyHook ||
    verifyHook.file !== buildHook.file ||
    verifyHook.sha256 !== buildHook.sha256 ||
    verifyHook.signatureStatus !== "Valid" ||
    verifyHook.timestamped !== true ||
    verifyHook.publisherIdentityBound !== true ||
    verifyHook.allInstallPassesVerified !== true
  ) {
    problems.push(
      "verification must prove the exact installed hook helper hash, timestamped signature and publisher identity in every pass",
    );
  }
  const requiredPasses = ["no-shortcuts", "default", "upgrade"];
  if (!Array.isArray(passes)) {
    problems.push("verification must retain installed hook helper evidence for every installer pass");
    return problems;
  }
  for (const name of requiredPasses) {
    const matchingPasses = passes.filter((pass) => pass?.name === name);
    const installed = matchingPasses[0]?.installedHook;
    if (
      matchingPasses.length !== 1 ||
      !installed ||
      installed.file !== buildHook.file ||
      installed.sha256 !== buildHook.sha256 ||
      installed.signatureStatus !== "Valid" ||
      installed.timestamped !== true ||
      installed.signerMatchesInstaller !== true
    ) {
      problems.push(`verification pass ${name} does not prove the exact signed hook helper`);
    }
  }
  return problems;
}
