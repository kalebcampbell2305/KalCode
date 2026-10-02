/**
 * The desktop release manifest (`src/data/releases.json`, written by the release tooling; types in
 * `src/data/releases.d.ts`) and the download calls to action derived from it. Every download
 * button on the site reads it here, so a button can only point at a build that is published, and
 * the site says "No public build yet" whenever `latest` is null.
 *
 * Kept free of Astro and Worker imports so pages, scripts and unit tests can all use it.
 */

import type { ReleaseManifest, ReleaseOs, ReleasePlatform, UnavailablePlatform } from "../data/releases";
import manifestJson from "../data/releases.json";

export type { ReleaseManifest, ReleaseOs, ReleasePlatform, UnavailablePlatform };

export const OS_ORDER: readonly ReleaseOs[] = ["windows", "macos", "linux"];

export const OS_NAMES: Readonly<Record<ReleaseOs, string>> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Checks what the pages depend on and throws otherwise, so a malformed manifest fails the build
 * instead of rendering a dead or unverifiable download link. (The tooling validates the full
 * schema; this is the website's own guard.)
 */
export function assertManifest(value: unknown): ReleaseManifest {
  if (typeof value !== "object" || value === null) throw new Error("releases.json: expected an object");
  const manifest = value as Partial<ReleaseManifest>;
  if (manifest.schemaVersion !== 1) throw new Error("releases.json: schemaVersion must be 1");
  if (!Array.isArray(manifest.unavailable)) throw new Error("releases.json: unavailable must be an array");
  const platforms = manifest.latest === null ? [] : manifest.latest?.platforms;
  if (!Array.isArray(platforms)) throw new Error("releases.json: latest must be null or a release with platforms");
  for (const platform of platforms) {
    if (!platform.url.startsWith("/download/")) {
      throw new Error(`releases.json: ${platform.os} url must be a /download/ path served by the Worker`);
    }
    if (!SHA256.test(platform.sha256))
      throw new Error(`releases.json: ${platform.os} sha256 must be 64 hex characters`);
    if (!(platform.size > 0)) throw new Error(`releases.json: ${platform.os} size must be positive`);
  }
  for (const os of OS_ORDER) {
    const downloadable = platforms.some((platform) => platform.os === os);
    const unavailable = manifest.unavailable.some((entry) => entry.os === os);
    if (downloadable === unavailable) {
      throw new Error(`releases.json: ${os} must appear in exactly one of latest.platforms or unavailable`);
    }
  }
  return manifest as ReleaseManifest;
}

/**
 * The public version of a release. Production builds are published as "X.Y.Z+N" (public version
 * plus an internal build number); the site always names them by the public version "X.Y.Z".
 */
export function publicVersion(version: string): string {
  return version.replace(/\+\d+$/, "");
}

/** The manifest as the site presents it: `latest.version` is the public version. */
export function displayManifest(manifest: ReleaseManifest): ReleaseManifest {
  if (!manifest.latest) return manifest;
  return { ...manifest, latest: { ...manifest.latest, version: publicVersion(manifest.latest.version) } };
}

/** The manifest shipped with this build, named by its public version. */
export const RELEASES: ReleaseManifest = displayManifest(assertManifest(manifestJson));

/** A complete signed Stable selection, used by public availability copy. */
export function signedStableRelease(manifest: ReleaseManifest): ReleaseManifest["latest"] {
  const latest = manifest.latest;
  return latest?.channel === "stable" &&
    latest.platforms.some((platform) => platform.os === "windows" && platform.arch === "x64" && platform.signed) &&
    latest.platforms.some((platform) => platform.os === "macos" && platform.arch === "arm64" && platform.signed)
    ? latest
    : null;
}

/**
 * The Stable release /download serves (Stable channel with at least one signed build), even when
 * it is not the complete Windows and Mac selection `signedStableRelease` requires.
 */
export function servedStableRelease(manifest: ReleaseManifest): ReleaseManifest["latest"] {
  const latest = manifest.latest;
  return latest?.channel === "stable" && latest.platforms.some((platform) => platform.signed) ? latest : null;
}

/**
 * The version that release-scoped copy names ("Gemini CLI is unavailable in 0.1.6", "threads in
 * 0.1.6 run in Plan, Approve or Auto"): the served Stable release, else 0.1.6, the release that copy
 * was written for. Both facts are unchanged in 0.1.7, 0.1.8 and 0.1.9.
 */
export function releaseCopyVersion(manifest: ReleaseManifest): string {
  return servedStableRelease(manifest)?.version ?? "0.1.6";
}

/** Copy written for 0.1.6 (site.ts constants and descriptions), naming the served Stable release. */
export function releaseCopy(text: string, manifest: ReleaseManifest): string {
  return text.replaceAll("0.1.6", releaseCopyVersion(manifest));
}

/** "Stable" or "Preview", from the published release's channel. */
export function channelLabel(manifest: ReleaseManifest): "Stable" | "Preview" {
  return manifest.latest?.channel === "stable" ? "Stable" : "Preview";
}

/** "Windows and macOS": the systems the published release has builds for, in manifest order. */
export function releaseSystems(manifest: ReleaseManifest): string {
  return (manifest.latest?.platforms ?? []).map((platform) => OS_NAMES[platform.os]).join(" and ");
}

/** The build for an OS, or null when that OS has no public build. */
export function buildFor(manifest: ReleaseManifest, os: ReleaseOs): ReleasePlatform | null {
  return manifest.latest?.platforms.find((platform) => platform.os === os) ?? null;
}

export type PlatformRow =
  | { os: ReleaseOs; name: string; state: "available"; build: ReleasePlatform }
  | { os: ReleaseOs; name: string; state: "unavailable"; label: string; reason: string };

/** One row per OS, always in the same order: a downloadable build or the manifest's reason. */
export function platformRows(manifest: ReleaseManifest): PlatformRow[] {
  return OS_ORDER.map((os): PlatformRow => {
    const build = buildFor(manifest, os);
    if (build) return { os, name: OS_NAMES[os], state: "available", build };
    const entry = manifest.unavailable.find((candidate) => candidate.os === os);
    return {
      os,
      name: OS_NAMES[os],
      state: "unavailable",
      label: entry?.label ?? OS_NAMES[os],
      reason: entry?.reason ?? "Not available yet.",
    };
  });
}

export interface DownloadCta {
  /** "download" when a Windows build is published; otherwise "pending" (no public build). */
  kind: "download" | "pending";
  /** Always "Download KalCode": the state is carried by the link and the note, never a bait label. */
  label: string;
  /** The installer itself when published; the honest download page otherwise. */
  href: string;
  /** The OS the direct link serves, so scripts can route other systems to the download page. */
  os: ReleaseOs | null;
  /** Short status shown under the button. */
  note: string;
}

/**
 * The site-wide primary call to action. With a published Windows build it is the real download
 * (the installer URL the Worker serves), with version and size in the note; without one it goes
 * to the download page, which says there is no public build yet, and the note says so too.
 */
export function downloadCta(manifest: ReleaseManifest = RELEASES): DownloadCta {
  const windows = buildFor(manifest, "windows");
  if (manifest.latest && windows) {
    return {
      kind: "download",
      label: "Download KalCode",
      href: windows.url,
      os: "windows",
      note: `Windows · ${channelLabel(manifest)} ${manifest.latest.version} · ${formatBytes(windows.size)}`,
    };
  }
  return {
    kind: "pending",
    label: "Download KalCode",
    href: "/download",
    os: null,
    note: "No public build yet",
  };
}

/**
 * The one-line build status used in the footer and on pages that describe the product:
 * "In private development" until a build is public, then "Preview 0.1.0 for Windows" or
 * "Stable 0.1.6 for Windows and macOS".
 */
export function buildStatus(manifest: ReleaseManifest = RELEASES): string {
  const latest = manifest.latest;
  if (!latest) return "In private development";
  return `${channelLabel(manifest)} ${latest.version} for ${releaseSystems(manifest)}`;
}

/** "84.2 MB" — decimal units, one decimal place from 1 MB up. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

/** "September 24, 2026" from an ISO timestamp (UTC, so the build is deterministic). */
export function formatReleaseDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
