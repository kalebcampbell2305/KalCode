/** Strict public subset emitted by tooling/release/updater-manifest.mjs. */
export type UpdaterChannel = "stable" | "beta" | "dev";
export type UpdaterTarget = "windows-x86_64" | "darwin-aarch64";
export type UpdaterArtifactFormat = "nsis" | "dmg";

interface UpdaterPlatform {
  signature: string;
  url: string;
}

export interface UpdaterDescriptorV1 {
  version: string;
  notes: string;
  pub_date: string;
  platforms: {
    "windows-x86_64": UpdaterPlatform;
  };
  kalcode: {
    schemaVersion: 1;
    channel: UpdaterChannel;
    size: number;
    sha256: string;
    commit: string;
  };
}

export interface UpdaterArtifactMetadata {
  target: UpdaterTarget;
  format: UpdaterArtifactFormat;
  size: number;
  sha256: string;
}

export interface UpdaterDescriptorV2 {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Partial<Record<UpdaterTarget, UpdaterPlatform>>;
  kalcode: {
    schemaVersion: 2;
    channel: UpdaterChannel;
    commit: string;
    artifacts: Partial<Record<UpdaterTarget, UpdaterArtifactMetadata>>;
  };
}

export type UpdaterDescriptor = UpdaterDescriptorV1 | UpdaterDescriptorV2;

export interface ValidatedUpdaterArtifact extends UpdaterArtifactMetadata {
  artifactKey: string;
  artifactFile: string;
  artifactUrl: string;
  signatureFile: string;
  /** Canonical Base64 wrapper around the Minisign document emitted by the release generator. */
  signature: string;
}

export interface ValidatedUpdaterDescriptor {
  descriptor: UpdaterDescriptor;
  artifacts: Partial<Record<UpdaterTarget, ValidatedUpdaterArtifact>>;
  /** Schema-v1 compatibility aliases. Schema v2 never chooses an arbitrary platform. */
  artifactKey?: string;
  artifactFile?: string;
  artifactUrl?: string;
  size?: number;
  sha256?: string;
  signature?: string;
}

const CHANNELS: ReadonlySet<string> = new Set(["stable", "beta", "dev"]);
const MAX_UPDATE_BYTES = 512 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[1-9]\d*)?$/;
/** Stable never carries a prerelease; it may carry an internal build number (`0.1.7+779`). */
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[1-9]\d*)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TARGETS = ["windows-x86_64", "darwin-aarch64"] as const satisfies readonly UpdaterTarget[];
const TARGET_FORMAT: Readonly<Record<UpdaterTarget, UpdaterArtifactFormat>> = {
  "windows-x86_64": "nsis",
  "darwin-aarch64": "dmg",
};
const TARGET_EXTENSION: Readonly<Record<UpdaterTarget, string>> = {
  "windows-x86_64": ".exe",
  "darwin-aarch64": ".dmg",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalBase64(value: string): string | null {
  if (value.length === 0 || value.trim() !== value || /\s/.test(value)) return null;
  try {
    const decoded = atob(value);
    return btoa(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function validMinisignSignature(
  signature: unknown,
  file: string,
  version: string,
  target?: UpdaterTarget,
  channel?: UpdaterChannel,
): signature is string {
  if (typeof signature !== "string" || signature.trim() !== signature) return false;
  if (new TextEncoder().encode(signature).byteLength > MAX_SIGNATURE_BYTES) return false;
  const document = canonicalBase64(signature);
  if (document === null) return false;
  const lines = document.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (
    lines.length !== 4 ||
    !lines[0]?.startsWith("untrusted comment: ") ||
    !lines[2]?.startsWith("trusted comment: ")
  ) {
    return false;
  }

  const record = canonicalBase64(lines[1] ?? "");
  const globalSignature = canonicalBase64(lines[3] ?? "");
  if (
    record === null ||
    record.length !== 74 ||
    record.charCodeAt(0) !== "E".charCodeAt(0) ||
    record.charCodeAt(1) !== "D".charCodeAt(0) ||
    globalSignature === null ||
    globalSignature.length !== 64
  ) {
    return false;
  }

  const trustedComment = (lines[2] ?? "").slice("trusted comment: ".length);
  const fields = trustedComment.split("\t");
  const timestamps = fields.filter((field) => field.startsWith("timestamp:"));
  const files = fields.filter((field) => field.startsWith("file:"));
  const versions = fields.filter((field) => field.startsWith("version:"));
  const common =
    timestamps.length === 1 &&
    /^timestamp:[1-9]\d{9,}$/.test(timestamps[0] ?? "") &&
    files.length === 1 &&
    files[0] === `file:${file}` &&
    versions.length === 1 &&
    versions[0] === `version:${version}`;
  if (!common) return false;
  if (target === undefined && channel === undefined) return fields.length === 3;
  if (target === undefined || channel === undefined) return false;
  return (
    fields.length === 5 &&
    fields[0] === timestamps[0] &&
    fields[1] === `file:${file}` &&
    fields[2] === `version:${version}` &&
    fields[3] === `target:${target}` &&
    fields[4] === `channel:${channel}`
  );
}

function canonicalPublishedAt(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_DATE.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

/**
 * Validates the exact public updater descriptor emitted by the release generator.
 *
 * This validates shape and release bindings only. Artifact SHA/Authenticode/Minisign verification
 * remains mandatory in the native updater; the Worker must also bind served bytes to this result.
 */
export function parseUpdaterDescriptor(
  value: unknown,
  expectedChannel: UpdaterChannel,
  expectedVersion: string,
): ValidatedUpdaterDescriptor | null {
  if (
    !CHANNELS.has(expectedChannel) ||
    !VERSION.test(expectedVersion) ||
    expectedVersion.length > 256 ||
    (expectedChannel === "stable" && !STABLE_VERSION.test(expectedVersion))
  ) {
    return null;
  }
  if (!isRecord(value) || !hasExactKeys(value, ["version", "notes", "pub_date", "platforms", "kalcode"])) {
    return null;
  }

  const { version, notes, pub_date: publishedAt, platforms, kalcode } = value;
  if (version !== expectedVersion || typeof version !== "string" || !VERSION.test(version) || version.length > 256) {
    return null;
  }
  if (typeof notes !== "string" || notes.trim().length === 0 || notes.trim() !== notes || notes.length > 10_000) {
    return null;
  }
  if (!canonicalPublishedAt(publishedAt)) return null;

  if (!isRecord(platforms) || !isRecord(kalcode)) return null;
  const schemaVersion = kalcode.schemaVersion;
  if (schemaVersion === 1) {
    if (!hasExactKeys(platforms, ["windows-x86_64"])) return null;
    const windows = platforms["windows-x86_64"];
    if (!isRecord(windows) || !hasExactKeys(windows, ["signature", "url"])) return null;
    if (!hasExactKeys(kalcode, ["schemaVersion", "channel", "size", "sha256", "commit"])) return null;
    const { channel, size, sha256, commit } = kalcode;
    if (
      channel !== expectedChannel ||
      !CHANNELS.has(channel as string) ||
      !validArtifactSize(size) ||
      typeof sha256 !== "string" ||
      !SHA256.test(sha256) ||
      typeof commit !== "string" ||
      !COMMIT.test(commit)
    ) {
      return null;
    }
    const artifact = parseArtifact(
      windows,
      { target: "windows-x86_64", format: "nsis", size, sha256 },
      expectedChannel,
      expectedVersion,
      false,
    );
    if (!artifact) return null;
    const descriptor: UpdaterDescriptorV1 = {
      version,
      notes,
      pub_date: publishedAt,
      platforms: {
        "windows-x86_64": {
          signature: artifact.signature,
          url: artifact.artifactUrl,
        },
      },
      kalcode: {
        schemaVersion: 1,
        channel: expectedChannel,
        size,
        sha256,
        commit,
      },
    };
    return {
      descriptor,
      artifacts: { "windows-x86_64": artifact },
      artifactKey: artifact.artifactKey,
      artifactFile: artifact.artifactFile,
      artifactUrl: artifact.artifactUrl,
      size: artifact.size,
      sha256: artifact.sha256,
      signature: artifact.signature,
    };
  }

  if (schemaVersion !== 2 || !hasExactKeys(kalcode, ["schemaVersion", "channel", "commit", "artifacts"])) {
    return null;
  }
  const { channel, commit, artifacts: rawArtifacts } = kalcode;
  if (
    channel !== expectedChannel ||
    !CHANNELS.has(channel as string) ||
    typeof commit !== "string" ||
    !COMMIT.test(commit) ||
    !isRecord(rawArtifacts)
  ) {
    return null;
  }
  const platformKeys = Object.keys(platforms).sort();
  const artifactKeys = Object.keys(rawArtifacts).sort();
  if (
    platformKeys.length < 1 ||
    platformKeys.length > TARGETS.length ||
    platformKeys.some((target) => !TARGETS.includes(target as UpdaterTarget)) ||
    platformKeys.length !== artifactKeys.length ||
    !platformKeys.every((target, index) => target === artifactKeys[index])
  ) {
    return null;
  }

  const normalizedPlatforms: Partial<Record<UpdaterTarget, UpdaterPlatform>> = {};
  const normalizedMetadata: Partial<Record<UpdaterTarget, UpdaterArtifactMetadata>> = {};
  const artifacts: Partial<Record<UpdaterTarget, ValidatedUpdaterArtifact>> = {};
  for (const rawTarget of platformKeys) {
    const target = rawTarget as UpdaterTarget;
    const platform = platforms[target];
    const metadata = rawArtifacts[target];
    if (
      !isRecord(platform) ||
      !hasExactKeys(platform, ["signature", "url"]) ||
      !isRecord(metadata) ||
      !hasExactKeys(metadata, ["target", "format", "size", "sha256"]) ||
      metadata.target !== target ||
      metadata.format !== TARGET_FORMAT[target] ||
      !validArtifactSize(metadata.size) ||
      typeof metadata.sha256 !== "string" ||
      !SHA256.test(metadata.sha256)
    ) {
      return null;
    }
    const artifactMetadata: UpdaterArtifactMetadata = {
      target,
      format: TARGET_FORMAT[target],
      size: metadata.size,
      sha256: metadata.sha256,
    };
    const artifact = parseArtifact(platform, artifactMetadata, expectedChannel, expectedVersion, true);
    if (!artifact) return null;
    normalizedPlatforms[target] = { signature: artifact.signature, url: artifact.artifactUrl };
    normalizedMetadata[target] = artifactMetadata;
    artifacts[target] = artifact;
  }

  const descriptor: UpdaterDescriptorV2 = {
    version,
    notes,
    pub_date: publishedAt,
    platforms: normalizedPlatforms,
    kalcode: {
      schemaVersion: 2,
      channel: expectedChannel,
      commit,
      artifacts: normalizedMetadata,
    },
  };
  return { descriptor, artifacts };
}

function validArtifactSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_UPDATE_BYTES;
}

function parseArtifact(
  platform: Record<string, unknown>,
  metadata: UpdaterArtifactMetadata,
  channel: UpdaterChannel,
  version: string,
  targetBound: boolean,
): ValidatedUpdaterArtifact | null {
  const url = platform.url;
  if (typeof url !== "string") return null;
  const artifactPrefix = `https://kalcoded.com/releases/updater/${channel}/${version}/${metadata.sha256}/`;
  if (!url.startsWith(artifactPrefix)) return null;
  const file = url.slice(artifactPrefix.length);
  if (
    !SAFE_FILE.test(file) ||
    file.includes("..") ||
    !file.endsWith(TARGET_EXTENSION[metadata.target]) ||
    url !== `${artifactPrefix}${file}` ||
    !validMinisignSignature(
      platform.signature,
      file,
      version,
      targetBound ? metadata.target : undefined,
      targetBound ? channel : undefined,
    )
  ) {
    return null;
  }
  const artifactKey = `releases/updater/${channel}/${version}/${metadata.sha256}/${file}`;
  return {
    ...metadata,
    artifactKey,
    artifactFile: file,
    artifactUrl: url,
    signatureFile: `${file}.sig`,
    signature: platform.signature,
  };
}
