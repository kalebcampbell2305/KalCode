/** Strict public subset emitted by tooling/release/updater-manifest.mjs. */
export type UpdaterChannel = "stable" | "beta" | "dev";

export interface UpdaterDescriptor {
  version: string;
  notes: string;
  pub_date: string;
  platforms: {
    "windows-x86_64": {
      signature: string;
      url: string;
    };
  };
  kalcode: {
    schemaVersion: 1;
    channel: UpdaterChannel;
    size: number;
    sha256: string;
    commit: string;
  };
}

export interface ValidatedUpdaterDescriptor {
  descriptor: UpdaterDescriptor;
  artifactKey: string;
  artifactFile: string;
  artifactUrl: string;
  size: number;
  sha256: string;
  /** Canonical Base64 wrapper around the Minisign document emitted by the release generator. */
  signature: string;
}

const CHANNELS: ReadonlySet<string> = new Set(["stable", "beta", "dev"]);
const MAX_UPDATE_BYTES = 512 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

function validMinisignSignature(signature: unknown, file: string, version: string): signature is string {
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
  return (
    fields.length === 3 &&
    timestamps.length === 1 &&
    /^timestamp:[1-9]\d{9,}$/.test(timestamps[0] ?? "") &&
    files.length === 1 &&
    files[0] === `file:${file}` &&
    versions.length === 1 &&
    versions[0] === `version:${version}`
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
  if (!CHANNELS.has(expectedChannel) || !VERSION.test(expectedVersion) || expectedVersion.length > 256) return null;
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

  if (!isRecord(platforms) || !hasExactKeys(platforms, ["windows-x86_64"])) return null;
  const windows = platforms["windows-x86_64"];
  if (!isRecord(windows) || !hasExactKeys(windows, ["signature", "url"])) return null;

  if (!isRecord(kalcode) || !hasExactKeys(kalcode, ["schemaVersion", "channel", "size", "sha256", "commit"])) {
    return null;
  }
  const { schemaVersion, channel, size, sha256, commit } = kalcode;
  if (
    schemaVersion !== 1 ||
    channel !== expectedChannel ||
    !CHANNELS.has(channel as string) ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_UPDATE_BYTES ||
    typeof sha256 !== "string" ||
    !SHA256.test(sha256) ||
    typeof commit !== "string" ||
    !COMMIT.test(commit)
  ) {
    return null;
  }

  const url = windows.url;
  if (typeof url !== "string") return null;
  const artifactPrefix = `https://kalcoded.com/releases/updater/${expectedChannel}/${expectedVersion}/${sha256}/`;
  if (!url.startsWith(artifactPrefix)) return null;
  const file = url.slice(artifactPrefix.length);
  if (!SAFE_FILE.test(file) || file.includes("..") || !file.endsWith(".exe") || url !== `${artifactPrefix}${file}`) {
    return null;
  }
  if (!validMinisignSignature(windows.signature, file, expectedVersion)) return null;

  const descriptor: UpdaterDescriptor = {
    version,
    notes,
    pub_date: publishedAt,
    platforms: {
      "windows-x86_64": {
        signature: windows.signature,
        url,
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
    artifactKey: `releases/updater/${expectedChannel}/${expectedVersion}/${sha256}/${file}`,
    artifactFile: file,
    artifactUrl: url,
    size,
    sha256,
    signature: windows.signature,
  };
}
