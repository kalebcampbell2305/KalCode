import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

export const GUARDIAN_FILENAME = "kalcode-provider-guardian.exe";

export function guardianBuildArgs() {
  return ["build", "--locked", "--release", "-p", "kalcode-providers", "--bin", "kalcode-provider-guardian"];
}

/**
 * Cargo's link outputs for the guardian bin under <targetDir>/release: the deps executable (cargo hard-links or copies it to
 * release/<GUARDIAN_FILENAME> with its old timestamp) and the bin's fingerprint directory. Removing them makes the next
 * `cargo build` relink the guardian from the current tree, so a binary left by an earlier (possibly failed or signed) run
 * is never reused, without recompiling the kalcode-providers library or its dependents.
 */
export function staleGuardianOutputs(targetDir) {
  const release = join(targetDir, "release");
  const paths = [];
  const deps = join(release, "deps");
  if (existsSync(deps)) {
    for (const name of readdirSync(deps)) {
      if (/^kalcode_provider_guardian-[0-9a-f]+(\.exe|\.pdb|\.d)?$/.test(name)) paths.push(join(deps, name));
    }
  }
  const fingerprints = join(release, ".fingerprint");
  if (existsSync(fingerprints)) {
    for (const name of readdirSync(fingerprints)) {
      if (!/^kalcode-providers-[0-9a-f]+$/.test(name)) continue;
      const dir = join(fingerprints, name);
      if (readdirSync(dir).some((file) => file.startsWith("bin-kalcode-provider-guardian"))) paths.push(dir);
    }
  }
  return paths;
}

/** Removes {@link staleGuardianOutputs} and the uplifted release binary; returns what was removed. */
export function clearStaleGuardian(targetDir) {
  const removed = [...staleGuardianOutputs(targetDir), join(targetDir, "release", GUARDIAN_FILENAME)].filter((path) =>
    existsSync(path),
  );
  for (const path of removed) rmSync(path, { recursive: true, force: true });
  return removed;
}

/** Adds the already-built guardian as a Windows resource at the resource root (the exe sibling). */
export function guardianBundleOverlay({ guardianPath, signingOverlay = {} }) {
  if (!isAbsolute(guardianPath) || basename(guardianPath) !== GUARDIAN_FILENAME) {
    throw new Error("guardian bundle source must be the absolute canonical release binary path");
  }
  const bundle = signingOverlay.bundle ?? {};
  const resources = bundle.resources ?? {};
  if (
    Object.values(resources).some(
      (target) => target === GUARDIAN_FILENAME && resources[guardianPath] !== GUARDIAN_FILENAME,
    )
  ) {
    throw new Error("guardian bundle destination is already claimed by another resource");
  }
  return {
    ...signingOverlay,
    bundle: {
      ...bundle,
      resources: {
        ...resources,
        [guardianPath]: GUARDIAN_FILENAME,
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

/** Converts measured Authenticode state into redacted build evidence, failing closed. */
export function guardianSignatureEvidence({ signature, identityOids, publisherIdentityOids, signingRequired }) {
  if (signingRequired) {
    if (signature?.status !== "Valid" || signature?.timestamped !== true) {
      throw new Error("guardian must have a valid timestamped Authenticode signature");
    }
    if (!sameIdentity(identityOids, publisherIdentityOids)) {
      throw new Error("guardian signature does not match the approved publisher identity");
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
    throw new Error("unsigned local simulation requires an unsigned guardian binary");
  }
  return {
    signed: false,
    signatureStatus: "NotSigned",
    timestamped: false,
    publisherIdentityBound: false,
  };
}

export function validateGuardianBuildEvidence(guardian) {
  if (!guardian || typeof guardian !== "object") {
    throw new Error("public Windows releases require signed guardian build evidence");
  }
  if (guardian.file !== GUARDIAN_FILENAME || guardian.bundledBesideApplication !== true) {
    throw new Error("public Windows releases require the canonical guardian beside the application");
  }
  if (typeof guardian.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(guardian.sha256)) {
    throw new Error("public Windows releases require the guardian SHA-256");
  }
  if (
    guardian.signed !== true ||
    guardian.signatureStatus !== "Valid" ||
    guardian.timestamped !== true ||
    guardian.publisherIdentityBound !== true
  ) {
    throw new Error("public Windows releases require a signed guardian with pinned publisher evidence");
  }
  return guardian;
}

/** Pure verifier used after each isolated install. */
export function guardianInstalledProblems({ buildGuardian, exists, sha256, signature, sameSignerAsInstaller }) {
  const problems = [];
  try {
    validateGuardianBuildEvidence(buildGuardian);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return problems;
  }
  if (!exists) {
    problems.push("installed guardian helper is missing");
    return problems;
  }
  if (sha256 !== buildGuardian.sha256) {
    problems.push("installed guardian SHA-256 does not match the signed build input");
  }
  if (signature?.status !== "Valid" || signature?.timestamped !== true) {
    problems.push("installed guardian signature is invalid, unsigned, or not timestamped");
  }
  if (sameSignerAsInstaller !== true) {
    problems.push("installed guardian signer does not match the installer signer");
  }
  return problems;
}

export function guardianPublicSigningProblems(guardian) {
  try {
    validateGuardianBuildEvidence(guardian);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function guardianPublicVerificationProblems(buildGuardian, verifyGuardian, passes) {
  const problems = guardianPublicSigningProblems(buildGuardian);
  if (problems.length > 0) return problems;
  if (
    !verifyGuardian ||
    verifyGuardian.file !== buildGuardian.file ||
    verifyGuardian.sha256 !== buildGuardian.sha256 ||
    verifyGuardian.signatureStatus !== "Valid" ||
    verifyGuardian.timestamped !== true ||
    verifyGuardian.publisherIdentityBound !== true ||
    verifyGuardian.allInstallPassesVerified !== true
  ) {
    problems.push(
      "verification must prove the exact installed guardian hash, timestamped signature and publisher identity in every pass",
    );
  }
  const requiredPasses = ["no-shortcuts", "default", "upgrade"];
  if (!Array.isArray(passes)) {
    problems.push("verification must retain installed guardian evidence for every installer pass");
    return problems;
  }
  for (const name of requiredPasses) {
    const matchingPasses = passes.filter((pass) => pass?.name === name);
    const installed = matchingPasses[0]?.installedGuardian;
    if (
      matchingPasses.length !== 1 ||
      !installed ||
      installed.file !== buildGuardian.file ||
      installed.sha256 !== buildGuardian.sha256 ||
      installed.signatureStatus !== "Valid" ||
      installed.timestamped !== true ||
      installed.signerMatchesInstaller !== true
    ) {
      problems.push(`verification pass ${name} does not prove the exact signed guardian`);
    }
  }
  return problems;
}
