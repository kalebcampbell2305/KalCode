// The desktop release manifest: apps/website/src/data/releases.json and R2 releases/latest.json.
// Shape: tooling/release/releases.schema.json and apps/website/src/data/releases.d.ts.
// The Worker parses the R2 copy with its own strict parser (apps/website/worker/downloads.ts);
// tests/unit/release-manifest.test.ts keeps the two in agreement.

export const SCHEMA_VERSION = 1;
export const WINDOWS_LABEL = "Windows 10 (1809) or later, 64-bit";
export const OS_LIST = ["windows", "macos", "linux"];

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const KINDS = ["nsis", "msi", "dmg", "appimage", "deb", "rpm"];
const ARCHES = ["x64", "arm64", "universal"];

/** Platforms with no build. Nothing here may be offered as a download. */
export const NOT_BUILT = [
  {
    os: "macos",
    label: "macOS",
    reason: "Not available yet. macOS builds need a macOS build machine and Apple code signing, which are not set up.",
  },
  {
    os: "linux",
    label: "Linux",
    reason: "Not available yet. Linux builds need a Linux build machine and have not been tested.",
  },
];

export const WINDOWS_UNPUBLISHED = {
  os: "windows",
  label: WINDOWS_LABEL,
  reason: "No public build has been published yet.",
};

/** The committed state until the first real publish: no release, nothing downloadable. */
export function emptyManifest() {
  return { schemaVersion: SCHEMA_VERSION, latest: null, unavailable: [WINDOWS_UNPUBLISHED, ...NOT_BUILT] };
}

/** Updates-page anchor for a version, matching the site's `id="release-0-1-0"` convention. */
export function notesAnchor(version) {
  return `release-${version.replaceAll(".", "-")}`;
}

/**
 * Builds the manifest for a published Windows release.
 * @param {{ version: string, commit: string, publishedAt: string, channel?: "preview" | "stable",
 *   windows: { file: string, size: number, sha256: string, signed: boolean } }} input
 */
export function buildManifest({ version, commit, publishedAt, channel = "preview", windows }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    latest: {
      version,
      channel,
      publishedAt,
      commit,
      notesUrl: `/updates#${notesAnchor(version)}`,
      platforms: [
        {
          os: "windows",
          arch: "x64",
          label: WINDOWS_LABEL,
          kind: "nsis",
          file: windows.file,
          url: "/download/windows-x64",
          pinnedUrl: `/download/${version}/${windows.file}`,
          size: windows.size,
          sha256: windows.sha256,
          signed: windows.signed,
        },
      ],
    },
    unavailable: NOT_BUILT,
  };
}

const isString = (value) => typeof value === "string" && value.length > 0;
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Returns a list of problems; an empty list means the manifest is valid. */
export function validateManifest(manifest) {
  const errors = [];
  if (!isRecord(manifest)) return ["manifest must be an object"];
  if (manifest.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  const keys = Object.keys(manifest).sort().join(",");
  if (keys !== "latest,schemaVersion,unavailable") errors.push(`unexpected top-level keys: ${keys}`);

  if (!Array.isArray(manifest.unavailable)) {
    errors.push("unavailable must be an array");
  } else {
    manifest.unavailable.forEach((entry, i) => {
      if (!isRecord(entry) || !OS_LIST.includes(entry.os) || !isString(entry.label) || !isString(entry.reason)) {
        errors.push(`unavailable[${i}] needs os (${OS_LIST.join("|")}), label and reason`);
      }
    });
  }

  const latest = manifest.latest;
  if (latest !== null) {
    if (!isRecord(latest)) {
      errors.push("latest must be null or an object");
    } else {
      if (!isString(latest.version) || !VERSION.test(latest.version)) errors.push("latest.version must be semver");
      if (!["preview", "stable"].includes(latest.channel)) errors.push("latest.channel must be preview or stable");
      if (!isString(latest.publishedAt) || Number.isNaN(Date.parse(latest.publishedAt))) {
        errors.push("latest.publishedAt must be an ISO date");
      }
      if (!COMMIT.test(latest.commit ?? "")) errors.push("latest.commit must be a full 40-character git hash");
      if (!isString(latest.notesUrl) || !latest.notesUrl.startsWith("/")) {
        errors.push("latest.notesUrl must be a site-relative URL");
      }
      if (!Array.isArray(latest.platforms) || latest.platforms.length === 0) {
        errors.push("latest.platforms must list at least one build");
      } else {
        latest.platforms.forEach((p, i) => {
          const at = `latest.platforms[${i}]`;
          if (!isRecord(p)) {
            errors.push(`${at} must be an object`);
            return;
          }
          if (!OS_LIST.includes(p.os)) errors.push(`${at}.os is invalid`);
          if (!ARCHES.includes(p.arch)) errors.push(`${at}.arch is invalid`);
          if (!KINDS.includes(p.kind)) errors.push(`${at}.kind is invalid`);
          if (!isString(p.label)) errors.push(`${at}.label is required`);
          if (!isString(p.file) || !FILE_NAME.test(p.file) || p.file.includes("..")) {
            errors.push(`${at}.file is not a safe file name`);
          }
          if (!isString(p.url) || !p.url.startsWith("/download/")) errors.push(`${at}.url must start with /download/`);
          if (p.pinnedUrl !== `/download/${latest.version}/${p.file}`) {
            errors.push(`${at}.pinnedUrl must be /download/<version>/<file>`);
          }
          if (!Number.isSafeInteger(p.size) || p.size <= 0) errors.push(`${at}.size must be a positive integer`);
          if (!SHA256.test(p.sha256 ?? "")) errors.push(`${at}.sha256 must be lowercase hex SHA-256`);
          if (typeof p.signed !== "boolean") errors.push(`${at}.signed must be a boolean`);
        });
      }
    }
  }

  // Every OS is either downloadable or explicitly marked unavailable, never both, never silent.
  for (const os of OS_LIST) {
    const inLatest = latest?.platforms?.some?.((p) => p?.os === os) ?? false;
    const inUnavailable = manifest.unavailable?.some?.((u) => u?.os === os) ?? false;
    if (!inLatest && !inUnavailable) errors.push(`${os} must appear in latest.platforms or unavailable`);
    if (inLatest && inUnavailable) errors.push(`${os} is both downloadable and unavailable`);
  }
  return errors;
}
