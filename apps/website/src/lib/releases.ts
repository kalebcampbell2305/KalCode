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

/** The manifest shipped with this build. */
export const RELEASES: ReleaseManifest = assertManifest(manifestJson);

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
  /** "download" when a Windows build is published; otherwise "early-access". */
  kind: "download" | "early-access";
  label: string;
  href: string;
  /** Short status shown beside or under the button. */
  note: string;
}

/**
 * The site-wide primary call to action. With a published Windows build it offers that build on
 * the download page (where version, size and checksum are shown); without one it says so and
 * points at early access. `earlyAccessHref` lets a page that carries the form link to it in place.
 */
export function downloadCta(
  manifest: ReleaseManifest = RELEASES,
  earlyAccessHref = "/download#early-access",
): DownloadCta {
  const windows = buildFor(manifest, "windows");
  if (manifest.latest && windows) {
    return {
      kind: "download",
      label: "Download for Windows",
      href: "/download#windows",
      note: `Preview ${manifest.latest.version} · ${formatBytes(windows.size)} · ${windows.label}`,
    };
  }
  return {
    kind: "early-access",
    label: "Join early access",
    href: earlyAccessHref,
    note: "No public build yet",
  };
}

/**
 * The one-line build status used in the footer and on pages that describe the product:
 * "In private development" until a build is public, then "Preview 0.1.0 for Windows".
 */
export function buildStatus(manifest: ReleaseManifest = RELEASES): string {
  const latest = manifest.latest;
  if (!latest) return "In private development";
  const systems = latest.platforms.map((platform) => OS_NAMES[platform.os]);
  return `Preview ${latest.version} for ${systems.join(" and ")}`;
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
