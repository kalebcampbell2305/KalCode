import { semverPrecedenceKey } from "./publication-safety.mjs";

const CONTENT = Object.freeze({
  executable: "application/vnd.microsoft.portable-executable",
  dmg: "application/x-apple-diskimage",
  json: "application/json; charset=utf-8",
  signature: "text/plain; charset=utf-8",
});

const TARGETS = Object.freeze({
  "windows-x86_64": { extension: ".exe", contentType: CONTENT.executable },
  "darwin-aarch64": { extension: ".dmg", contentType: CONTENT.dmg },
});

function validateArtifact(target, file, artifactSha256, signatureSha256) {
  const policy = TARGETS[target];
  if (!policy) throw new Error("release artifact target is invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file) || file.includes("..") || !file.endsWith(policy.extension)) {
    throw new Error("release artifact file is invalid for its target");
  }
  if (!/^[0-9a-f]{64}$/.test(artifactSha256)) throw new Error("artifactSha256 is invalid");
  if (signatureSha256 !== undefined && !/^[0-9a-f]{64}$/.test(signatureSha256)) {
    throw new Error("signatureSha256 is invalid");
  }
  return policy;
}

export function parsePublishMode(args) {
  const allowed = new Set(["--dry-run", "--local", "--bootstrap-authority"]);
  if (args.includes("--without-install-test")) {
    throw new Error(
      "--without-install-test was removed: public releases require a passing install, upgrade, and signature verification",
    );
  }
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) throw new Error(`unknown publish option: ${unknown[0]}`);
  if (new Set(args).size !== args.length) throw new Error("publish options may be specified only once");
  if (args.filter((arg) => allowed.has(arg)).length > 1) {
    throw new Error("publish modes are mutually exclusive");
  }
  if (args.includes("--dry-run")) return "dry-run";
  if (args.includes("--local")) return "local";
  if (args.includes("--bootstrap-authority")) return "bootstrap";
  return "remote";
}

function put(bucket, key, file, contentType, cacheControl, extra = []) {
  return [
    "r2",
    "object",
    "put",
    `${bucket}/${key}`,
    "--file",
    file,
    "--content-type",
    contentType,
    ...extra,
    "--cache-control",
    cacheControl,
  ];
}

export function updaterKeys(channel, version, file, digests, target = "windows-x86_64") {
  if (!/^(?:stable|beta|dev)$/.test(channel)) throw new Error("release channel is invalid");
  semverPrecedenceKey(version);
  validateArtifact(target, file, digests?.artifactSha256, digests?.signatureSha256);
  if (!/^[0-9a-f]{64}$/.test(digests?.signatureSha256 ?? "")) throw new Error("signatureSha256 is invalid");
  if (!/^[0-9a-f]{64}$/.test(digests?.updaterDescriptorSha256 ?? "")) {
    throw new Error("updaterDescriptorSha256 is invalid");
  }
  const artifactDirectory = `releases/updater/${channel}/${version}/${digests.artifactSha256}`;
  return {
    artifact: `${artifactDirectory}/${file}`,
    signature: `${artifactDirectory}/${digests.signatureSha256}/${file}.sig`,
    version: `releases/updater/${channel}/${version}/${digests.updaterDescriptorSha256}.json`,
    channel: `releases/updater/${channel}.json`,
  };
}

export function downloadKeys(version, file, artifactSha256, downloadDescriptorSha256, target = "windows-x86_64") {
  semverPrecedenceKey(version);
  validateArtifact(target, file, artifactSha256);
  if (!/^[0-9a-f]{64}$/.test(downloadDescriptorSha256)) {
    throw new Error("downloadDescriptorSha256 is invalid");
  }
  return {
    installer: `releases/${version}/${artifactSha256}/${file}`,
    version: `releases/${version}/${downloadDescriptorSha256}.json`,
    latest: "releases/latest.json",
  };
}

export function publishedUpdaterProblems(live, expectedVersion, expectedSha256) {
  if (!live || typeof live !== "object") return ["published updater descriptor is invalid"];
  if (live.version !== expectedVersion) return ["published updater descriptor has an unexpected version"];
  if (typeof expectedSha256 === "object" && expectedSha256 !== null) {
    if (canonicalJson(live) !== canonicalJson(expectedSha256)) {
      return [`${expectedVersion} already has different immutable updater metadata; bump the version first`];
    }
  } else if (live.kalcode?.sha256 !== expectedSha256) {
    return [`${expectedVersion} already has different immutable updater metadata; bump the version first`];
  }
  return [];
}

export function windowsUpdaterV2Problems(build, verify) {
  const problems = [];
  const target = "windows-x86_64";
  const signatureFile = `${build?.file}.windows-x86_64.sig`;
  const evidence = build?.updaterV2;
  const buildKeys =
    "artifactFile,channel,channelBound,cryptographicallyVerified,publicKeyConfigured,schemaVersion,signatureFile,signatureStatus,target,targetBound,versionBound";
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== buildKeys ||
    evidence.schemaVersion !== 2 ||
    evidence.artifactFile !== build.file ||
    evidence.signatureFile !== signatureFile ||
    evidence.signatureStatus !== "Valid" ||
    evidence.cryptographicallyVerified !== true ||
    evidence.versionBound !== true ||
    evidence.target !== target ||
    evidence.targetBound !== true ||
    evidence.channel !== build.requestedReleaseChannel ||
    !/^(?:stable|beta|dev)$/.test(evidence.channel ?? "") ||
    evidence.channelBound !== true ||
    evidence.publicKeyConfigured !== true
  ) {
    problems.push("Windows build packet has invalid or incomplete updater v2 evidence");
  }
  const verification = verify?.updaterV2;
  const verifyKeys =
    "channel,channelBound,exactBytes,schemaVersion,signatureFile,signatureStatus,target,targetBound,versionBound";
  if (
    verify?.status !== "passed" ||
    !verification ||
    typeof verification !== "object" ||
    Array.isArray(verification) ||
    Object.keys(verification).sort().join(",") !== verifyKeys ||
    verification.schemaVersion !== 2 ||
    verification.signatureFile !== signatureFile ||
    verification.signatureStatus !== "Valid" ||
    verification.exactBytes !== true ||
    verification.versionBound !== true ||
    verification.target !== target ||
    verification.targetBound !== true ||
    verification.channel !== build?.requestedReleaseChannel ||
    verification.channelBound !== true
  ) {
    problems.push("Windows verification packet has invalid or incomplete updater v2 evidence");
  }
  return problems;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function isMissingR2Object(stderr) {
  return /(?:specified key does not exist|NoSuchKey|\b10007\b)/i.test(String(stderr ?? ""));
}

export function buildPublishPlan({
  bucket,
  version,
  channel,
  installerFile,
  installerPath,
  signaturePath,
  downloadManifestPath,
  updaterManifestPath,
  artifactSha256,
  signatureSha256,
  updaterDescriptorSha256,
  downloadDescriptorSha256,
  includeInstaller = true,
  includeDownloadDescriptor = true,
  includeUpdater,
  includeImmutableUpdater = includeUpdater,
  includeLocalPointer = false,
  artifacts,
}) {
  if (artifacts !== undefined) {
    if (!Array.isArray(artifacts) || artifacts.length < 1 || artifacts.length > Object.keys(TARGETS).length) {
      throw new Error("release artifacts must contain one or two supported platform packets");
    }
    if (new Set(artifacts.map((artifact) => artifact.target)).size !== artifacts.length) {
      throw new Error("release artifact targets must be unique");
    }
    semverPrecedenceKey(version);
    if (!/^(?:stable|beta|dev)$/.test(channel)) throw new Error("release channel is invalid");
    if (!/^[0-9a-f]{64}$/.test(updaterDescriptorSha256)) {
      throw new Error("updaterDescriptorSha256 is invalid");
    }
    if (!/^[0-9a-f]{64}$/.test(downloadDescriptorSha256)) {
      throw new Error("downloadDescriptorSha256 is invalid");
    }
    const immutable = "public, max-age=31536000, immutable";
    const pointer = "public, max-age=60, must-revalidate";
    const plan = [];
    const ordered = [...artifacts].sort((left, right) => left.target.localeCompare(right.target));
    for (const artifact of ordered) {
      const policy = validateArtifact(
        artifact.target,
        artifact.file,
        artifact.artifactSha256,
        artifact.signatureSha256,
      );
      const downloads = downloadKeys(
        version,
        artifact.file,
        artifact.artifactSha256,
        downloadDescriptorSha256,
        artifact.target,
      );
      const downloadArtifactKey = includeLocalPointer ? `releases/${version}/${artifact.file}` : downloads.installer;
      if (artifact.includeDownloadArtifact !== false) {
        plan.push({
          name: `${artifact.target} versioned artifact`,
          kind: "download-artifact",
          target: artifact.target,
          key: downloadArtifactKey,
          argv: put(bucket, downloadArtifactKey, artifact.artifactPath, policy.contentType, immutable, [
            "--content-disposition",
            `attachment; filename="${artifact.file}"`,
          ]),
        });
      }
    }
    if (includeDownloadDescriptor) {
      const key = `releases/${version}/${downloadDescriptorSha256}.json`;
      plan.push({
        name: "immutable download descriptor",
        kind: "download-descriptor",
        key,
        argv: put(bucket, key, downloadManifestPath, CONTENT.json, immutable),
      });
    }
    if (includeUpdater) {
      for (const artifact of ordered) {
        const keys = updaterKeys(
          channel,
          version,
          artifact.file,
          {
            artifactSha256: artifact.artifactSha256,
            signatureSha256: artifact.signatureSha256,
            updaterDescriptorSha256,
          },
          artifact.target,
        );
        const policy = TARGETS[artifact.target];
        if (artifact.includeUpdaterArtifact !== false) {
          plan.push({
            name: `${artifact.target} immutable updater artifact`,
            kind: "updater-artifact",
            target: artifact.target,
            key: keys.artifact,
            argv: put(bucket, keys.artifact, artifact.artifactPath, policy.contentType, immutable),
          });
        }
        if (artifact.includeUpdaterSignature !== false) {
          plan.push({
            name: `${artifact.target} immutable updater signature`,
            kind: "updater-signature",
            target: artifact.target,
            key: keys.signature,
            argv: put(bucket, keys.signature, artifact.signaturePath, CONTENT.signature, immutable),
          });
        }
      }
      if (includeImmutableUpdater) {
        const key = `releases/updater/${channel}/${version}/${updaterDescriptorSha256}.json`;
        plan.push({
          name: "immutable updater version descriptor",
          kind: "updater-descriptor",
          key,
          argv: put(bucket, key, updaterManifestPath, CONTENT.json, immutable),
        });
      }
    }
    if (includeLocalPointer) {
      plan.push({
        name: "website latest pointer",
        kind: "local-pointer",
        key: "releases/latest.json",
        argv: put(bucket, "releases/latest.json", downloadManifestPath, CONTENT.json, pointer),
      });
    }
    return plan;
  }
  const downloads = downloadKeys(version, installerFile, artifactSha256, downloadDescriptorSha256);
  const installerKey = includeLocalPointer ? `releases/${version}/${installerFile}` : downloads.installer;
  const immutable = "public, max-age=31536000, immutable";
  const pointer = "public, max-age=60, must-revalidate";
  const plan = [];
  if (includeInstaller) {
    plan.push({
      name: "versioned installer",
      key: installerKey,
      argv: put(bucket, installerKey, installerPath, CONTENT.executable, immutable, [
        "--content-disposition",
        `attachment; filename="${installerFile}"`,
      ]),
    });
  }
  if (includeDownloadDescriptor) {
    plan.push({
      name: "immutable download descriptor",
      key: downloads.version,
      argv: put(bucket, downloads.version, downloadManifestPath, CONTENT.json, immutable),
    });
  }
  if (includeUpdater) {
    const keys = updaterKeys(channel, version, installerFile, {
      artifactSha256,
      signatureSha256,
      updaterDescriptorSha256,
    });
    if (includeImmutableUpdater) {
      plan.push(
        {
          name: "immutable updater artifact",
          key: keys.artifact,
          argv: put(bucket, keys.artifact, installerPath, CONTENT.executable, immutable),
        },
        {
          name: "immutable updater signature",
          key: keys.signature,
          argv: put(bucket, keys.signature, signaturePath, CONTENT.signature, immutable),
        },
        {
          name: "immutable updater version descriptor",
          key: keys.version,
          argv: put(bucket, keys.version, updaterManifestPath, CONTENT.json, immutable),
        },
      );
    }
  }
  if (includeLocalPointer) {
    plan.push({
      name: "website latest pointer",
      key: downloads.latest,
      argv: put(bucket, downloads.latest, downloadManifestPath, CONTENT.json, pointer),
    });
  }
  return plan;
}

/**
 * Plans the unlisted updater-QA objects. It deliberately has no switch for a mutable feed or D1
 * pointer: every returned key is digest-qualified and safe to expose only by its immutable URL.
 */
export function buildUpdaterQaStagePlan(input) {
  if (input?.channel !== "stable") throw new Error("updater QA staging is Stable-only");
  const plan = buildPublishPlan({
    ...input,
    includeDownloadDescriptor: true,
    includeUpdater: true,
    includeImmutableUpdater: true,
    includeLocalPointer: false,
  });
  for (const entry of plan) {
    if (
      entry.kind === "local-pointer" ||
      entry.key === "releases/latest.json" ||
      entry.key === "releases/updater/stable.json" ||
      !entry.argv.includes("public, max-age=31536000, immutable")
    ) {
      throw new Error("updater QA stage plan contains a mutable publication object");
    }
  }
  return plan;
}
