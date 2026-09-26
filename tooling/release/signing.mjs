import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";

import { guardianPublicSigningProblems, guardianPublicVerificationProblems } from "./guardian-packaging.mjs";

export const ARTIFACT_SIGNING = Object.freeze({
  endpoint: "https://eus.codesigning.azure.net/",
  accountName: "kalcodesigning",
  certificateProfileName: "kalcodewindows",
  publisherIdentityOid: "1.3.6.1.4.1.311.97.208143396.135769116.211620001.449325895",
  timestampUrl: "http://timestamp.acs.microsoft.com",
});

const SIGNABLE_EXTENSIONS = new Set([".exe", ".dll", ".msi", ".msix", ".appx"]);
const AZURE_CLI_DIR = "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin";
const ARTIFACT_SIGNING_EKU_PREFIX = "1.3.6.1.4.1.311.97.";
const ARTIFACT_SIGNING_GENERIC_PUBLIC_TRUST_EKU = "1.3.6.1.4.1.311.97.1.0";
const CANONICAL_OID = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/;
const UPDATER_EVIDENCE_KEYS = [
  "artifactFile",
  "cryptographicallyVerified",
  "publicKeyConfigured",
  "signatureFile",
  "signatureStatus",
  "versionBound",
];

export function expectedWindowsInstallerFile(version) {
  if (
    typeof version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)
  ) {
    throw new Error("release version must be canonical SemVer");
  }
  return `KalCode_${version}_x64-setup.exe`;
}

export function updaterSigningEvidenceIsExact(updater, installerFile) {
  return (
    updater !== null &&
    typeof updater === "object" &&
    !Array.isArray(updater) &&
    JSON.stringify(Object.keys(updater).sort()) === JSON.stringify(UPDATER_EVIDENCE_KEYS) &&
    updater.artifactFile === installerFile &&
    updater.signatureFile === `${installerFile}.sig` &&
    updater.signatureStatus === "Valid" &&
    updater.cryptographicallyVerified === true &&
    updater.versionBound === true &&
    updater.publicKeyConfigured === true
  );
}

export function artifactSigningMetadata() {
  return {
    Endpoint: ARTIFACT_SIGNING.endpoint,
    CodeSigningAccountName: ARTIFACT_SIGNING.accountName,
    CertificateProfileName: ARTIFACT_SIGNING.certificateProfileName,
  };
}

export function artifactSigningIdentityMatchesPinned(identityOids) {
  return (
    Array.isArray(identityOids) &&
    identityOids.length === 1 &&
    identityOids[0] === ARTIFACT_SIGNING.publisherIdentityOid
  );
}

export function buildSigningOverlay({ nodePath, signerPath }) {
  if (!isAbsolute(nodePath) || !isAbsolute(signerPath)) {
    throw new Error("release signing overlay paths must be absolute");
  }
  return {
    bundle: {
      windows: {
        digestAlgorithm: "sha256",
        signCommand: {
          cmd: nodePath,
          args: [signerPath, "%1"],
        },
      },
    },
  };
}

export function buildSignToolArgs({ dlibPath, metadataPath, targetPath }) {
  return [
    "sign",
    "/fd",
    "SHA256",
    "/tr",
    ARTIFACT_SIGNING.timestampUrl,
    "/td",
    "SHA256",
    "/dlib",
    dlibPath,
    "/dmdf",
    metadataPath,
    targetPath,
  ];
}

export function releaseProcessOptions(overrides = {}) {
  return {
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 300_000,
    windowsHide: true,
    ...overrides,
  };
}

export function normalizeAuthenticodeResult(result) {
  return {
    status: typeof result?.status === "string" ? result.status : "Unknown",
    timestamped: result?.timestamped === true,
  };
}

export function timestampedAuthenticodeIsValid(result) {
  const evidence = normalizeAuthenticodeResult(result);
  return evidence.status === "Valid" && evidence.timestamped === true;
}

export function signingEnvironment(baseEnvironment, { exists = existsSync } = {}) {
  const environment = {};
  let pathName = "Path";
  let currentPath = "";
  for (const [name, value] of Object.entries(baseEnvironment)) {
    if (name.toUpperCase() === "PATH") {
      if (!currentPath) {
        pathName = name;
        currentPath = value ?? "";
      }
    } else {
      environment[name] = value;
    }
  }
  const azureCli = join(AZURE_CLI_DIR, "az.cmd");
  environment[pathName] =
    exists(azureCli) && !currentPath.toLowerCase().split(";").includes(AZURE_CLI_DIR.toLowerCase())
      ? [currentPath, AZURE_CLI_DIR].filter(Boolean).join(";")
      : currentPath;
  return environment;
}

export function authenticodeStatus(targetPath, powershellJson) {
  const quoted = `'${String(targetPath).replaceAll("'", "''")}'`;
  const result = powershellJson(
    `$signature = Get-AuthenticodeSignature -LiteralPath ${quoted}; ` +
      "[pscustomobject]@{ status = [string]$signature.Status; timestamped = ($null -ne $signature.TimeStamperCertificate) } | ConvertTo-Json -Compress",
  );
  return normalizeAuthenticodeResult(result);
}

export function normalizeArtifactSigningIdentityOids(result, { requirePublicTrustMarker = true } = {}) {
  const raw = Array.isArray(result?.oids) ? result.oids : typeof result?.oids === "string" ? [result.oids] : [];
  const all = [...new Set(raw)];
  if (all.some((oid) => typeof oid !== "string" || !CANONICAL_OID.test(oid))) {
    throw new Error("Artifact Signing certificate contains a malformed EKU OID");
  }
  if (requirePublicTrustMarker && !all.includes(ARTIFACT_SIGNING_GENERIC_PUBLIC_TRUST_EKU)) {
    throw new Error("Artifact Signing Public Trust marker EKU is missing");
  }
  const subscriber = all.filter(
    (oid) => oid.startsWith(ARTIFACT_SIGNING_EKU_PREFIX) && oid !== ARTIFACT_SIGNING_GENERIC_PUBLIC_TRUST_EKU,
  );
  if (subscriber.length === 0) throw new Error("Artifact Signing subscriber identity EKU is missing");
  if (subscriber.length !== 1)
    throw new Error("Artifact Signing certificate must contain exactly one subscriber identity EKU");
  return subscriber;
}

export function parsePublisherIdentityEnvironment(value) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /\s/.test(value)) {
    throw new Error("publisher identity environment is not canonical");
  }
  const values = value.split(",");
  if (new Set(values).size !== values.length) throw new Error("publisher identity environment is not canonical");
  const normalized = normalizeArtifactSigningIdentityOids({ oids: values }, { requirePublicTrustMarker: false });
  if (normalized.join(",") !== value) throw new Error("publisher identity environment is not canonical");
  return normalized;
}

export function authenticodeIdentityOids(targetPath, powershellJson) {
  const quoted = `'${String(targetPath).replaceAll("'", "''")}'`;
  const result = powershellJson(
    `$signature = Get-AuthenticodeSignature -LiteralPath ${quoted}; ` +
      "$oids = @(); " +
      "if ($null -ne $signature.SignerCertificate) { " +
      "foreach ($extension in @($signature.SignerCertificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })) { " +
      "$eku = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($extension, $extension.Critical); " +
      "foreach ($oid in $eku.EnhancedKeyUsages) { $oids += [string]$oid.Value } } }; " +
      "[pscustomobject]@{ oids = @($oids) } | ConvertTo-Json -Compress",
  );
  return normalizeArtifactSigningIdentityOids(result);
}

export function sameAuthenticodeSigner(firstPath, secondPath, powershellJson) {
  const first = authenticodeIdentityOids(firstPath, powershellJson);
  const second = authenticodeIdentityOids(secondPath, powershellJson);
  return first.length === second.length && first.every((oid, index) => oid === second[index]);
}

function validatedToolPath(path, label, exists, stat) {
  if (!path || !isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  if (!exists(path)) throw new Error(`${label} was not found at the configured path`);
  if (!stat(path).isFile()) throw new Error(`${label} path must identify a regular file`);
  return path;
}

export function findArtifactSigningTools({
  env = process.env,
  programFilesX86 = process.env["ProgramFiles(x86)"],
  localAppData = process.env.LOCALAPPDATA,
  exists = existsSync,
  stat = statSync,
  listDirectories = (path) =>
    readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
} = {}) {
  const configuredSignTool = env.KALCODE_SIGNTOOL_PATH;
  const configuredDlib = env.KALCODE_ARTIFACT_SIGNING_DLIB_PATH;
  if (configuredSignTool || configuredDlib) {
    if (!configuredSignTool || !configuredDlib) {
      throw new Error("KALCODE_SIGNTOOL_PATH and KALCODE_ARTIFACT_SIGNING_DLIB_PATH must be configured together");
    }
    return {
      signToolPath: validatedToolPath(configuredSignTool, "SignTool", exists, stat),
      dlibPath: validatedToolPath(configuredDlib, "Artifact Signing dlib", exists, stat),
    };
  }

  if (programFilesX86) {
    const root = join(programFilesX86, "Microsoft", "ArtifactSigningClientTools", "bin");
    const pairs = [
      [join(root, "signtool.exe"), join(root, "Azure.CodeSigning.Dlib.dll")],
      [join(root, "x64", "signtool.exe"), join(root, "x64", "Azure.CodeSigning.Dlib.dll")],
      [join(root, "signtool.exe"), join(root, "x64", "Azure.CodeSigning.Dlib.dll")],
    ];
    for (const [signToolPath, dlibPath] of pairs) {
      if (exists(signToolPath) && stat(signToolPath).isFile() && exists(dlibPath) && stat(dlibPath).isFile()) {
        return { signToolPath, dlibPath };
      }
    }

    const perUserDlib = localAppData
      ? join(localAppData, "Microsoft", "MicrosoftArtifactSigningClientTools", "Azure.CodeSigning.Dlib.dll")
      : null;
    const sdkRoot = join(programFilesX86, "Windows Kits", "10", "bin");
    if (perUserDlib && exists(perUserDlib) && stat(perUserDlib).isFile() && exists(sdkRoot)) {
      const versions = listDirectories(sdkRoot).sort((left, right) =>
        right.localeCompare(left, undefined, { numeric: true }),
      );
      for (const version of versions) {
        const signToolPath = join(sdkRoot, version, "x64", "signtool.exe");
        if (exists(signToolPath) && stat(signToolPath).isFile()) return { signToolPath, dlibPath: perUserDlib };
      }
    }
  }

  throw new Error(
    "Artifact Signing Client Tools were not found. Install Microsoft.Azure.ArtifactSigningClientTools with WinGet, or configure both KALCODE_SIGNTOOL_PATH and KALCODE_ARTIFACT_SIGNING_DLIB_PATH.",
  );
}

export function validateSigningTarget(targetPath, { exists = existsSync, stat = statSync } = {}) {
  if (!isAbsolute(targetPath)) throw new Error("signing target must be an absolute path");
  if (!SIGNABLE_EXTENSIONS.has(extname(targetPath).toLowerCase())) {
    throw new Error("signing target has an unsupported file type");
  }
  if (!exists(targetPath)) throw new Error("signing target does not exist");
  if (!stat(targetPath).isFile()) throw new Error("signing target must be a regular file");
  return targetPath;
}

export function signTarget({
  targetPath,
  metadataPath,
  env = process.env,
  exists = existsSync,
  stat = statSync,
  spawn = spawnSync,
}) {
  const target = validateSigningTarget(targetPath, { exists, stat });
  if (!isAbsolute(metadataPath) || !exists(metadataPath) || !stat(metadataPath).isFile()) {
    throw new Error("Artifact Signing metadata file is missing or invalid");
  }
  const effectiveEnvironment = signingEnvironment(env, { exists });
  const { signToolPath, dlibPath } = findArtifactSigningTools({ env: effectiveEnvironment, exists, stat });
  const result = spawn(
    signToolPath,
    buildSignToolArgs({ dlibPath, metadataPath, targetPath: target }),
    releaseProcessOptions({
      encoding: "utf8",
      env: effectiveEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (result.error) throw new Error("Artifact Signing could not start SignTool");
  if (result.status !== 0) {
    throw new Error(`Artifact Signing SignTool exited with ${String(result.status)}`);
  }
}

export function parseSigningMode(argv, requestedReleaseChannel) {
  const occurrences = argv.filter((arg) => arg === "--unsigned-local").length;
  if (occurrences > 1) throw new Error("--unsigned-local may be specified only once");
  if (occurrences === 0) return { sign: true, localSimulation: false };
  if (requestedReleaseChannel !== "dev") {
    throw new Error("--unsigned-local is only valid with --channel dev");
  }
  return { sign: false, localSimulation: true };
}

/** Public publish must prove both artifacts were signed and RFC3161-timestamped. */
export function publicSigningProblems(build) {
  const problems = [];
  try {
    if (build.file !== expectedWindowsInstallerFile(build.version)) {
      problems.push("public Windows release installer name must exactly match its version");
    }
  } catch {
    problems.push("public Windows release version is invalid");
  }
  if (build.requestedReleaseChannel !== "stable" || build.compiledChannel !== "stable") {
    problems.push("the public download and stable feed require a stable-channel build");
  }
  if (build.signed !== true || build.signatureStatus !== "Valid") {
    problems.push("public Windows releases require a valid signed installer");
  }
  if (build.signing?.provider !== "azure-artifact-signing") {
    problems.push("public Windows releases require the approved Azure Artifact Signing provider");
  }
  if (build.signing?.applicationVerifiedDuringBundle !== true) {
    problems.push(
      "public Windows releases require the application executable to pass the signing command verification",
    );
  }
  if (build.signing?.publisherIdentityBound !== true) {
    problems.push("public Windows releases require the durable Artifact Signing publisher identity binding");
  }
  if (build.signing?.timestamped !== true || build.signing?.appTimestamped !== true) {
    problems.push("public Windows release signatures must include a trusted timestamp");
  }
  if (!updaterSigningEvidenceIsExact(build.updater, build.file)) {
    problems.push("public Windows releases require an exact version-bound updater signature and embedded public key");
  }
  if (build.releaseDescriptorEligible !== true) {
    problems.push(
      `build is not eligible for a public release descriptor (${build.releaseDescriptorBlockedReason ?? "unknown reason"})`,
    );
  } else if (build.releaseDescriptorBlockedReason !== null) {
    problems.push("release descriptor eligibility is internally inconsistent with its blocked reason");
  }
  const compiledProbe = build.compiledChannelVerification;
  if (
    compiledProbe?.status !== "verified" ||
    compiledProbe?.method !== "build_info_probe_v1" ||
    compiledProbe?.schemaVersion !== 1 ||
    compiledProbe?.testHooks !== false
  ) {
    problems.push("public Windows releases require the exact production binary probe with test hooks disabled");
  }
  problems.push(...guardianPublicSigningProblems(build.guardian));
  return problems;
}

export function publicVerificationProblems(build, verify) {
  if (!verify || typeof verify !== "object") return ["a public release requires a verification report"];
  const problems = [];
  if (
    verify.status !== "passed" ||
    verify.version !== build.version ||
    verify.file !== build.file ||
    verify.commit !== build.commit ||
    verify.sha256 !== build.sha256
  ) {
    problems.push("verification must have passed for the exact build commit and installer SHA-256");
  }
  if (verify.signatureStatus !== "Valid" || verify.timestamped !== true) {
    problems.push("verification must re-prove the installer signature and trusted timestamp");
  }
  if (verify.publisherIdentityBound !== true) {
    problems.push("verification must re-prove the durable Artifact Signing publisher identity");
  }
  if (
    verify.updater?.signatureStatus !== "Valid" ||
    verify.updater?.exactBytes !== true ||
    verify.updater?.versionBound !== true
  ) {
    problems.push("verification must re-prove the updater signature for the exact installer bytes and version");
  }
  problems.push(...guardianPublicVerificationProblems(build.guardian, verify.guardian, verify.passes));
  if (verify.launchedApp !== false) {
    problems.push("installer verification must never launch the application");
  }
  if (
    !Array.isArray(verify.preflight?.existingInstall) ||
    verify.preflight.existingInstall.length !== 0 ||
    !Array.isArray(verify.preflight?.runningKalcode) ||
    verify.preflight.runningKalcode.length !== 0
  ) {
    problems.push("installer verification must start from a clean machine with no running KalCode process");
  }
  if (
    !Array.isArray(verify.checks) ||
    verify.checks.length === 0 ||
    verify.checks.some((check) => check?.ok !== true)
  ) {
    problems.push("installer verification must retain successful evidence for all recorded checks");
  }
  const requiredPasses = ["no-shortcuts", "default", "upgrade"];
  if (
    !Array.isArray(verify.passes) ||
    requiredPasses.some((name) => !verify.passes.some((pass) => pass?.name === name))
  ) {
    problems.push("verification must include both installer test passes and the update-mode rehearsal");
  } else if (
    verify.passes.some(
      (pass) => pass?.installedAppSignature?.status !== "Valid" || pass?.installedAppSignature?.timestamped !== true,
    )
  ) {
    problems.push("every installed application signature must be valid and timestamped");
  }
  if (
    Array.isArray(verify.passes) &&
    requiredPasses.every((name) => verify.passes.some((pass) => pass?.name === name)) &&
    verify.passes.some((pass) => pass?.installedAppSignerMatchesInstaller !== true)
  ) {
    problems.push("every installed application must use the same signing identity as the installer");
  }
  if (
    Array.isArray(verify.passes) &&
    requiredPasses.every((name) => verify.passes.some((pass) => pass?.name === name)) &&
    verify.passes.some(
      (pass) =>
        pass?.afterUninstall?.uninstallEntry !== false ||
        pass?.afterUninstall?.installFolder !== false ||
        pass?.afterUninstall?.desktopShortcut !== false ||
        pass?.afterUninstall?.startMenuShortcut !== false,
    )
  ) {
    problems.push("every installer verification pass must prove complete uninstall cleanup");
  }
  const upgrade = Array.isArray(verify.passes) ? verify.passes.find((pass) => pass?.name === "upgrade") : null;
  if (upgrade && upgrade.updateModeRehearsal !== true) {
    problems.push("verification must prove the update-mode installer rehearsal completed");
  }
  return problems;
}
