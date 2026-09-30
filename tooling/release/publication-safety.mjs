import { Buffer } from "node:buffer";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CHANNEL_PATTERN = /^(?:stable|beta|dev)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SAFE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_VERSION_LENGTH = 256;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

function parseSemver(version) {
  if (typeof version !== "string" || version.length === 0 || version.length > MAX_VERSION_LENGTH) {
    throw new Error("release version is not a bounded canonical SemVer");
  }
  // An optional internal build number (`X.Y.Z+N`) follows the public version.
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([1-9]\d*))?$/.exec(
      version,
    );
  if (!match) throw new Error("release version is not a canonical SemVer");
  const prerelease = match[4]?.split(".") ?? [];
  for (const identifier of prerelease) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
      throw new Error("release version has a non-canonical numeric prerelease identifier");
    }
  }
  return { major: match[1], minor: match[2], patch: match[3], prerelease, build: match[5] ?? null };
}

function canonicalTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    value.length > 32 ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} is not a canonical timestamp`);
  }
  return value;
}

/**
 * Creates or validates the durable, non-secret identity for one remote publication attempt.
 * Keeping the first timestamp stable makes every descriptor key reproducible after a partial
 * upload, so retries can verify and reuse the exact immutable objects instead of orphaning a new
 * descriptor set for the same build.
 */
export function resolvePublicationState(existing, build, now) {
  parseSemver(build?.version);
  if (!COMMIT_PATTERN.test(build?.commit ?? "")) throw new Error("publication build commit is invalid");
  if (!CHANNEL_PATTERN.test(build?.requestedReleaseChannel ?? "")) {
    throw new Error("publication build channel is invalid");
  }
  if (
    !SAFE_FILE_PATTERN.test(build?.file ?? "") ||
    build.file.includes("..") ||
    !Number.isSafeInteger(build?.size) ||
    build.size <= 0 ||
    !SHA256_PATTERN.test(build?.sha256 ?? "")
  ) {
    throw new Error("publication build artifact identity is invalid");
  }
  const builtAt = canonicalTimestamp(build.builtAt, "publication build time");
  const current = canonicalTimestamp(now, "publication current time");
  const candidate = {
    schemaVersion: 1,
    version: build.version,
    commit: build.commit,
    channel: build.requestedReleaseChannel,
    file: build.file,
    size: build.size,
    sha256: build.sha256,
    publishedAt: current,
  };
  if (existing === null || existing === undefined) {
    if (current < builtAt) throw new Error("publication timestamp predates the exact build");
    return candidate;
  }
  if (typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error("publication state is invalid");
  }
  const expectedKeys = Object.keys(candidate).sort();
  if (JSON.stringify(Object.keys(existing).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("publication state has unexpected fields");
  }
  for (const [key, value] of Object.entries(candidate)) {
    if (key !== "publishedAt" && existing[key] !== value) {
      throw new Error("publication state does not match the exact build");
    }
  }
  const publishedAt = canonicalTimestamp(existing.publishedAt, "publication timestamp");
  if (publishedAt < builtAt) throw new Error("publication timestamp predates the exact build");
  if (publishedAt > current) throw new Error("publication timestamp is in the future");
  return { ...candidate, publishedAt };
}

const PLATFORM_TARGETS = new Set(["windows-x86_64", "darwin-aarch64"]);

/**
 * Binds a resumable publication timestamp to a complete, ordered platform set. This state is
 * local redacted evidence only; the immutable descriptor hashes remain the D1 authority.
 */
export function resolvePlatformPublicationState(existing, release, now) {
  parseSemver(release?.version);
  if (!COMMIT_PATTERN.test(release?.commit ?? "")) throw new Error("publication release commit is invalid");
  if (!CHANNEL_PATTERN.test(release?.requestedReleaseChannel ?? "")) {
    throw new Error("publication release channel is invalid");
  }
  if (!Array.isArray(release?.artifacts) || release.artifacts.length < 1 || release.artifacts.length > 2) {
    throw new Error("publication release needs one or two platform artifacts");
  }
  const targets = release.artifacts.map((artifact) => artifact?.target);
  if (new Set(targets).size !== targets.length || targets.some((target) => !PLATFORM_TARGETS.has(target))) {
    throw new Error("publication release platform targets are invalid");
  }
  const artifacts = [...release.artifacts]
    .map((artifact) => {
      if (
        !SAFE_FILE_PATTERN.test(artifact?.file ?? "") ||
        artifact.file.includes("..") ||
        !Number.isSafeInteger(artifact?.size) ||
        artifact.size <= 0 ||
        !SHA256_PATTERN.test(artifact?.sha256 ?? "") ||
        !SHA256_PATTERN.test(artifact?.signatureSha256 ?? "")
      ) {
        throw new Error("publication release artifact identity is invalid");
      }
      const builtAt = canonicalTimestamp(artifact.builtAt, "publication artifact build time");
      return {
        target: artifact.target,
        file: artifact.file,
        size: artifact.size,
        sha256: artifact.sha256,
        signatureSha256: artifact.signatureSha256,
        builtAt,
      };
    })
    .sort((left, right) => left.target.localeCompare(right.target));
  const current = canonicalTimestamp(now, "publication current time");
  if (artifacts.some((artifact) => current < artifact.builtAt)) {
    throw new Error("publication timestamp predates an exact platform build");
  }
  const candidate = {
    schemaVersion: 3,
    version: release.version,
    commit: release.commit,
    channel: release.requestedReleaseChannel,
    artifacts,
    publishedAt: current,
  };
  if (existing === null || existing === undefined) return candidate;
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error("publication state is invalid");
  }
  if (JSON.stringify(Object.keys(existing).sort()) !== JSON.stringify(Object.keys(candidate).sort())) {
    throw new Error("publication state has unexpected fields");
  }
  const comparableExisting = { ...existing };
  delete comparableExisting.publishedAt;
  const comparableCandidate = { ...candidate };
  delete comparableCandidate.publishedAt;
  if (canonicalJson(comparableExisting) !== canonicalJson(comparableCandidate)) {
    throw new Error("publication state does not match the exact platform set");
  }
  const publishedAt = canonicalTimestamp(existing.publishedAt, "publication timestamp");
  if (artifacts.some((artifact) => publishedAt < artifact.builtAt)) {
    throw new Error("publication timestamp predates an exact platform build");
  }
  if (publishedAt > current) throw new Error("publication timestamp is in the future");
  return { ...candidate, publishedAt };
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

export function publicationJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Creates a release identity/descriptor once, or proves the existing bytes are identical. */
export function writeFrozenPublicationJson(path, value) {
  const bytes = publicationJsonBytes(value);
  if (existsSync(path)) {
    if (!Buffer.from(readFileSync(path)).equals(bytes)) {
      throw new Error("immutable publication file already exists with different bytes; bump the version");
    }
    return "reused";
  }
  mkdirSync(dirname(path), { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return "created";
}

// Unary length prefixes preserve integer ordering for arbitrary-width canonical numeric fields.
// No finite decimal padding or JavaScript Number conversion is involved.
function numericKey(value) {
  return `${"1".repeat(value.length)}0${value}`;
}

// A build number sorts after the same version without one, and numerically between builds. `+`
// sorts before every character that can continue a key, so `X.Y.Z-a+N` stays below `X.Y.Z-a.b`.
// Keys of versions without a build are unchanged, so already-stored D1 keys stay valid.
export function semverPrecedenceKey(version) {
  const parsed = parseSemver(version);
  const base = [parsed.major, parsed.minor, parsed.patch].map(numericKey).join("!");
  const build = parsed.build === null ? "" : `+${numericKey(parsed.build)}`;
  if (parsed.prerelease.length === 0) return `${base}~1${build}`;
  const prerelease = parsed.prerelease
    .map((identifier) => (/^\d+$/.test(identifier) ? `0${numericKey(identifier)}` : `1${identifier}`))
    .join("!");
  return `${base}~0${prerelease}!${build}`;
}

function validatePointerCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") throw new Error("release pointer candidate is required");
  if (!CHANNEL_PATTERN.test(candidate.channel)) throw new Error("release channel is invalid");
  const precedenceKey = semverPrecedenceKey(candidate.version);
  if (!SHA256_PATTERN.test(candidate.updaterDescriptorSha256)) {
    throw new Error("updater descriptor SHA-256 is invalid");
  }
  if (!SHA256_PATTERN.test(candidate.downloadDescriptorSha256)) {
    throw new Error("download descriptor SHA-256 is invalid");
  }
  const expectedUpdater = `releases/updater/${candidate.channel}/${candidate.version}/${candidate.updaterDescriptorSha256}.json`;
  const expectedDownload = `releases/${candidate.version}/${candidate.downloadDescriptorSha256}.json`;
  if (candidate.updaterDescriptorKey !== expectedUpdater) throw new Error("updater descriptor key is not canonical");
  if (candidate.downloadDescriptorKey !== expectedDownload) throw new Error("download descriptor key is not canonical");
  if (
    typeof candidate.publishedAt !== "string" ||
    candidate.publishedAt.length > 32 ||
    Number.isNaN(Date.parse(candidate.publishedAt)) ||
    new Date(candidate.publishedAt).toISOString() !== candidate.publishedAt
  ) {
    throw new Error("release publication timestamp is invalid");
  }
  return { ...candidate, precedenceKey };
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildPointerReadStatement(channel) {
  if (!CHANNEL_PATTERN.test(channel)) throw new Error("release channel is invalid");
  return `SELECT versions.channel, versions.version, versions.precedence_key, versions.updater_descriptor_key, versions.download_descriptor_key, versions.updater_descriptor_sha256, versions.download_descriptor_sha256, versions.published_at FROM release_publication_pointers AS pointers JOIN release_publication_versions AS versions ON versions.channel = pointers.channel AND versions.version = pointers.version AND versions.precedence_key = pointers.precedence_key WHERE pointers.channel = ${sqlLiteral(channel)};`;
}

export function buildVersionReadStatement(channel, version) {
  if (!CHANNEL_PATTERN.test(channel)) throw new Error("release channel is invalid");
  parseSemver(version);
  return `SELECT channel, version, precedence_key, updater_descriptor_key, download_descriptor_key, updater_descriptor_sha256, download_descriptor_sha256, published_at FROM release_publication_versions WHERE channel = ${sqlLiteral(channel)} AND version = ${sqlLiteral(version)};`;
}

export function buildVersionClaimStatement(candidate) {
  const value = validatePointerCandidate(candidate);
  const columns = [
    "channel",
    "version",
    "precedence_key",
    "updater_descriptor_key",
    "download_descriptor_key",
    "updater_descriptor_sha256",
    "download_descriptor_sha256",
    "published_at",
  ];
  const values = [
    sqlLiteral(value.channel),
    sqlLiteral(value.version),
    sqlLiteral(value.precedenceKey),
    sqlLiteral(value.updaterDescriptorKey),
    sqlLiteral(value.downloadDescriptorKey),
    sqlLiteral(value.updaterDescriptorSha256),
    sqlLiteral(value.downloadDescriptorSha256),
    sqlLiteral(value.publishedAt),
  ];
  return `INSERT INTO release_publication_versions (${columns.join(", ")}) SELECT ${values.join(", ")} WHERE NOT EXISTS (SELECT 1 FROM release_publication_pointers WHERE channel = ${sqlLiteral(value.channel)} AND (release_publication_pointers.precedence_key > ${sqlLiteral(value.precedenceKey)} OR (release_publication_pointers.precedence_key = ${sqlLiteral(value.precedenceKey)} AND release_publication_pointers.version <> ${sqlLiteral(value.version)}))) ON CONFLICT(channel, version) DO NOTHING RETURNING channel, version, precedence_key, updater_descriptor_key, download_descriptor_key, updater_descriptor_sha256, download_descriptor_sha256, published_at;`;
}

/**
 * Claims an immutable version for updater QA only while the channel pointer still equals the
 * read-only snapshot. It inserts no pointer row and has no UPDATE authority.
 */
export function buildQaVersionClaimStatement(candidate, expectedCurrent) {
  const value = validatePointerCandidate(candidate);
  let pointerGuard;
  if (expectedCurrent === null) {
    pointerGuard = `NOT EXISTS (SELECT 1 FROM release_publication_pointers WHERE channel = ${sqlLiteral(value.channel)})`;
  } else {
    if (!expectedCurrent || typeof expectedCurrent !== "object" || Array.isArray(expectedCurrent)) {
      throw new Error("expected release pointer is invalid");
    }
    const expected = validatePointerCandidate({
      channel: expectedCurrent.channel,
      version: expectedCurrent.version,
      updaterDescriptorKey: expectedCurrent.updater_descriptor_key,
      downloadDescriptorKey: expectedCurrent.download_descriptor_key,
      updaterDescriptorSha256: expectedCurrent.updater_descriptor_sha256,
      downloadDescriptorSha256: expectedCurrent.download_descriptor_sha256,
      publishedAt: expectedCurrent.published_at,
    });
    if (expected.channel !== value.channel) throw new Error("expected release pointer channel is invalid");
    const expectedPrecedence = expected.precedenceKey;
    if (expectedCurrent.precedence_key !== expectedPrecedence) {
      throw new Error("expected release pointer precedence is invalid");
    }
    pointerGuard = `EXISTS (SELECT 1 FROM release_publication_pointers AS pointers JOIN release_publication_versions AS versions ON versions.channel = pointers.channel AND versions.version = pointers.version AND versions.precedence_key = pointers.precedence_key WHERE pointers.channel = ${sqlLiteral(value.channel)} AND pointers.version = ${sqlLiteral(expected.version)} AND pointers.precedence_key = ${sqlLiteral(expectedPrecedence)} AND versions.updater_descriptor_key = ${sqlLiteral(expected.updaterDescriptorKey)} AND versions.download_descriptor_key = ${sqlLiteral(expected.downloadDescriptorKey)} AND versions.updater_descriptor_sha256 = ${sqlLiteral(expected.updaterDescriptorSha256)} AND versions.download_descriptor_sha256 = ${sqlLiteral(expected.downloadDescriptorSha256)} AND versions.published_at = ${sqlLiteral(expected.publishedAt)})`;
  }
  const columns = [
    "channel",
    "version",
    "precedence_key",
    "updater_descriptor_key",
    "download_descriptor_key",
    "updater_descriptor_sha256",
    "download_descriptor_sha256",
    "published_at",
  ];
  const values = [
    sqlLiteral(value.channel),
    sqlLiteral(value.version),
    sqlLiteral(value.precedenceKey),
    sqlLiteral(value.updaterDescriptorKey),
    sqlLiteral(value.downloadDescriptorKey),
    sqlLiteral(value.updaterDescriptorSha256),
    sqlLiteral(value.downloadDescriptorSha256),
    sqlLiteral(value.publishedAt),
  ];
  return `INSERT INTO release_publication_versions (${columns.join(", ")}) SELECT ${values.join(", ")} WHERE ${pointerGuard} ON CONFLICT(channel, version) DO NOTHING RETURNING channel, version, precedence_key, updater_descriptor_key, download_descriptor_key, updater_descriptor_sha256, download_descriptor_sha256, published_at;`;
}

export function buildPointerAdvanceStatement(candidate, expectedCurrent = undefined) {
  const value = validatePointerCandidate(candidate);
  if (expectedCurrent === undefined) {
    return `INSERT INTO release_publication_pointers (channel, version, precedence_key, updated_at) SELECT ${sqlLiteral(value.channel)}, ${sqlLiteral(value.version)}, ${sqlLiteral(value.precedenceKey)}, unixepoch() WHERE NOT EXISTS (SELECT 1 FROM release_publication_pointers WHERE channel = ${sqlLiteral(value.channel)} AND (release_publication_pointers.precedence_key > ${sqlLiteral(value.precedenceKey)} OR (release_publication_pointers.precedence_key = ${sqlLiteral(value.precedenceKey)} AND release_publication_pointers.version <> ${sqlLiteral(value.version)}))) ON CONFLICT(channel) DO UPDATE SET version = excluded.version, precedence_key = excluded.precedence_key, updated_at = excluded.updated_at WHERE release_publication_pointers.precedence_key < excluded.precedence_key OR release_publication_pointers.version = excluded.version RETURNING channel, version, precedence_key;`;
  }
  let priorGuard;
  let conflictGuard;
  if (expectedCurrent === null) {
    priorGuard = `NOT EXISTS (SELECT 1 FROM release_publication_pointers WHERE channel = ${sqlLiteral(value.channel)})`;
    conflictGuard = "0";
  } else {
    if (!expectedCurrent || typeof expectedCurrent !== "object" || Array.isArray(expectedCurrent)) {
      throw new Error("expected release pointer is invalid");
    }
    if (expectedCurrent.channel !== value.channel) throw new Error("expected release pointer channel is invalid");
    const expectedPrecedence = semverPrecedenceKey(expectedCurrent.version);
    if (expectedCurrent.precedence_key !== expectedPrecedence) {
      throw new Error("expected release pointer precedence is invalid");
    }
    const order = compareVersions(expectedCurrent.version, value.version);
    if (order > 0) throw new Error("expected release pointer is newer than the candidate");
    priorGuard = `EXISTS (SELECT 1 FROM release_publication_pointers WHERE channel = ${sqlLiteral(value.channel)} AND version = ${sqlLiteral(expectedCurrent.version)} AND precedence_key = ${sqlLiteral(expectedPrecedence)})`;
    conflictGuard = `release_publication_pointers.version = ${sqlLiteral(expectedCurrent.version)} AND release_publication_pointers.precedence_key = ${sqlLiteral(expectedPrecedence)}`;
  }
  return `INSERT INTO release_publication_pointers (channel, version, precedence_key, updated_at) SELECT ${sqlLiteral(value.channel)}, ${sqlLiteral(value.version)}, ${sqlLiteral(value.precedenceKey)}, unixepoch() WHERE ${priorGuard} ON CONFLICT(channel) DO UPDATE SET version = excluded.version, precedence_key = excluded.precedence_key, updated_at = excluded.updated_at WHERE ${conflictGuard} RETURNING channel, version, precedence_key;`;
}

/**
 * Selects the first pointer only when the channel is still empty and the exact immutable version
 * row already exists. This is the one-time bridge used before D1-backed public routes are cut over;
 * it can never update or replace an existing channel pointer.
 */
export function buildInitialPointerStatement(candidate) {
  const value = validatePointerCandidate(candidate);
  return `INSERT INTO release_publication_pointers (channel, version, precedence_key, updated_at) SELECT versions.channel, versions.version, versions.precedence_key, unixepoch() FROM release_publication_versions AS versions WHERE versions.channel = ${sqlLiteral(value.channel)} AND versions.version = ${sqlLiteral(value.version)} AND versions.precedence_key = ${sqlLiteral(value.precedenceKey)} AND versions.updater_descriptor_key = ${sqlLiteral(value.updaterDescriptorKey)} AND versions.download_descriptor_key = ${sqlLiteral(value.downloadDescriptorKey)} AND versions.updater_descriptor_sha256 = ${sqlLiteral(value.updaterDescriptorSha256)} AND versions.download_descriptor_sha256 = ${sqlLiteral(value.downloadDescriptorSha256)} AND versions.published_at = ${sqlLiteral(value.publishedAt)} AND NOT EXISTS (SELECT 1 FROM release_publication_pointers WHERE channel = ${sqlLiteral(value.channel)}) RETURNING channel, version, precedence_key;`;
}

export function parseD1Rows(output) {
  let batches;
  try {
    batches = JSON.parse(output);
  } catch {
    throw new Error("D1 pointer operation returned invalid JSON");
  }
  if (
    !Array.isArray(batches) ||
    batches.length !== 1 ||
    batches[0]?.success !== true ||
    !Array.isArray(batches[0].results)
  ) {
    throw new Error("D1 pointer operation failed");
  }
  return batches[0].results;
}

function compareVersions(left, right) {
  const leftKey = semverPrecedenceKey(left);
  const rightKey = semverPrecedenceKey(right);
  return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
}

export function publicationRowProblems(row, candidate) {
  const value = validatePointerCandidate(candidate);
  if (row === null || row === undefined) return [];
  if (typeof row !== "object" || Array.isArray(row)) return ["D1 release pointer row is invalid"];
  let order;
  try {
    order = compareVersions(row.version, value.version);
  } catch {
    return ["D1 release pointer row has an invalid version"];
  }
  if (order > 0) return [`D1 release pointer already names newer version ${row.version}`];
  if (order < 0) return [];
  const exact = {
    channel: value.channel,
    version: value.version,
    precedence_key: value.precedenceKey,
    updater_descriptor_key: value.updaterDescriptorKey,
    download_descriptor_key: value.downloadDescriptorKey,
    updater_descriptor_sha256: value.updaterDescriptorSha256,
    download_descriptor_sha256: value.downloadDescriptorSha256,
    published_at: value.publishedAt,
  };
  return Object.entries(exact).every(([key, expected]) => row[key] === expected)
    ? []
    : [`D1 release pointer already claims ${row.version} with different immutable descriptors`];
}

/** The QA staging lane needs an exact immutable version row, never an older-compatible pointer. */
export function exactPublicationRowProblems(row, candidate) {
  const value = validatePointerCandidate(candidate);
  if (row === null || row === undefined) return ["D1 immutable release version row is missing"];
  if (row?.channel !== value.channel || row?.version !== value.version) {
    return ["D1 immutable release version row names a different release"];
  }
  return publicationRowProblems(row, value);
}

/**
 * Selects the only two safe bootstrap states before any publication write:
 * an empty channel may be initialized, while an existing channel may only resume the byte- and
 * field-exact frozen candidate that previously crossed the pointer linearization point.
 */
export function decideBootstrapPointerAction(rows, candidate) {
  validatePointerCandidate(candidate);
  if (!Array.isArray(rows)) throw new Error("release authority bootstrap pointer result is invalid");
  if (rows.length > 1) throw new Error("release authority bootstrap pointer returned multiple rows");
  if (rows.length === 0) return "initialize";
  const problems = exactPublicationRowProblems(rows[0], candidate);
  if (problems.length > 0) {
    throw new Error(`release authority bootstrap cannot resume: ${problems.join("; ")}`);
  }
  return "resume";
}

/**
 * Completes the pointer-to-manifest bootstrap boundary. A resumed attempt never receives pointer
 * mutation authority, and both paths re-read the exact joined pointer row before writing the local
 * manifest. This deliberately leaves an exact pointer recoverable when the manifest write fails.
 */
export function completeBootstrapAuthority({ action, candidate, initializePointer, readPointer, writeManifest }) {
  if (action !== "initialize" && action !== "resume") {
    throw new Error("release authority bootstrap action is invalid");
  }
  for (const [name, operation] of Object.entries({ readPointer, writeManifest })) {
    if (typeof operation !== "function") throw new Error(`release authority bootstrap ${name} operation is invalid`);
  }
  if (action === "initialize" && typeof initializePointer !== "function") {
    throw new Error("release authority bootstrap initializePointer operation is invalid");
  }
  if (action === "resume" && initializePointer !== undefined) {
    throw new Error("release authority bootstrap resume received pointer mutation authority");
  }
  validatePointerCandidate(candidate);
  if (action === "initialize") {
    const inserted = initializePointer();
    if (
      !Array.isArray(inserted) ||
      inserted.length !== 1 ||
      inserted[0]?.channel !== candidate.channel ||
      inserted[0]?.version !== candidate.version
    ) {
      let reason = "authoritative D1 release pointer compare-and-set was rejected";
      try {
        decideBootstrapPointerAction(readPointer(), candidate);
      } catch (error) {
        reason = error instanceof Error ? error.message : reason;
      }
      throw new Error(reason);
    }
  }
  const authoritative = readPointer();
  if (decideBootstrapPointerAction(authoritative, candidate) !== "resume") {
    throw new Error("authoritative D1 release pointer did not read back exactly");
  }
  writeManifest();
  return authoritative[0];
}

export function pointerAdvanceProblems({
  version,
  downloadSha256,
  updaterSha256,
  expectedLatest,
  expectedUpdater,
  currentLatest,
  currentUpdater,
}) {
  const problems = [];
  const missingPlatforms = (current, proposed) => {
    const proposedSet = new Set(proposed);
    return [...new Set(current)].filter((platform) => !proposedSet.has(platform)).sort();
  };
  const latestVersion = currentLatest?.latest?.version;
  if (typeof latestVersion === "string") {
    try {
      const order = compareVersions(latestVersion, version);
      if (order > 0) problems.push(`website release pointer already names newer version ${latestVersion}`);
      if (order < 0 && expectedLatest) {
        const currentPlatforms = Array.isArray(currentLatest?.latest?.platforms)
          ? currentLatest.latest.platforms
              .filter((platform) => platform && typeof platform === "object")
              .map((platform) => `${platform.os}/${platform.arch}`)
          : [];
        const proposedPlatforms = Array.isArray(expectedLatest?.latest?.platforms)
          ? expectedLatest.latest.platforms
              .filter((platform) => platform && typeof platform === "object")
              .map((platform) => `${platform.os}/${platform.arch}`)
          : [];
        const removed = missingPlatforms(currentPlatforms, proposedPlatforms);
        if (removed.length > 0) {
          problems.push(`newer release would withdraw published download platform(s): ${removed.join(", ")}`);
        }
      }
      if (order === 0) {
        const exact = expectedLatest
          ? canonicalJson(currentLatest) === canonicalJson(expectedLatest)
          : currentLatest?.latest?.platforms?.find?.((platform) => platform?.os === "windows")?.sha256 ===
            downloadSha256;
        if (latestVersion !== version || !exact) {
          problems.push(`${version} is already published with a different installer or platform release`);
        }
      }
    } catch {
      problems.push("website release pointer has an invalid version");
    }
  }
  const updaterVersion = currentUpdater?.version;
  if (typeof updaterVersion === "string") {
    try {
      const order = compareVersions(updaterVersion, version);
      if (order > 0) problems.push(`updater channel pointer already names newer version ${updaterVersion}`);
      if (order < 0 && expectedUpdater) {
        const currentPlatforms =
          currentUpdater?.platforms && typeof currentUpdater.platforms === "object"
            ? Object.keys(currentUpdater.platforms)
            : [];
        const proposedPlatforms =
          expectedUpdater?.platforms && typeof expectedUpdater.platforms === "object"
            ? Object.keys(expectedUpdater.platforms)
            : [];
        const removed = missingPlatforms(currentPlatforms, proposedPlatforms);
        if (removed.length > 0) {
          problems.push(`newer release would withdraw published updater platform(s): ${removed.join(", ")}`);
        }
      }
      const exact = expectedUpdater
        ? canonicalJson(currentUpdater) === canonicalJson(expectedUpdater)
        : currentUpdater?.kalcode?.sha256 === updaterSha256;
      if (order === 0 && (updaterVersion !== version || !exact)) {
        problems.push(`${version} is already published with different updater bytes`);
      }
    } catch {
      problems.push("updater channel pointer has an invalid version");
    }
  }
  return problems;
}

export async function boundedJsonFetch(
  url,
  { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("HTTP probe timeout is invalid");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
    throw new Error("HTTP probe body limit is invalid");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`HTTP probe timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      }),
      aborted,
    ]);
    if (!response.ok) {
      await response.body?.cancel();
      return {
        ok: false,
        status: response.status,
        value: null,
        releaseAuthority: response.headers?.get?.("x-kalcode-release-authority") ?? null,
      };
    }
    const declared = response.headers?.get?.("content-length");
    if (declared !== null && declared !== undefined) {
      if (!/^\d+$/.test(declared) || Number(declared) > maxBytes) {
        await response.body?.cancel();
        throw new Error(`HTTP probe body exceeds ${maxBytes} bytes`);
      }
    }
    if (!response.body?.getReader) throw new Error("HTTP probe response has no readable body");
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          throw new Error(`HTTP probe body exceeds ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A timed-out read can remain pending in a noncompliant test/fetch implementation.
      }
    }
    return {
      ok: true,
      status: response.status,
      value: JSON.parse(Buffer.concat(chunks, length).toString("utf8")),
      releaseAuthority: response.headers?.get?.("x-kalcode-release-authority") ?? null,
    };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
