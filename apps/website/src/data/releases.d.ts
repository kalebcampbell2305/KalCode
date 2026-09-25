/**
 * Types for `releases.json`, the desktop release manifest the website reads at build time.
 *
 * The manifest is written by `pnpm release:publish` (tooling/release/publish.mjs) and validated
 * against tooling/release/releases.schema.json. The same document is uploaded to R2 as
 * `releases/latest.json` and served at `/releases/latest.json`.
 *
 * `latest` is `null` until a release has actually been published: render that as "no public
 * build yet", never as a download button. A platform is downloadable only if it appears in
 * `latest.platforms`; everything in `unavailable` must be shown as not yet available.
 *
 * Usage in a page:
 *   import manifestJson from "../data/releases.json";
 *   import type { ReleaseManifest } from "../data/releases";
 *   const manifest = manifestJson as ReleaseManifest;
 */

export type ReleaseChannel = "preview" | "stable";
export type ReleaseOs = "windows" | "macos" | "linux";
export type ReleaseArch = "x64" | "arm64" | "universal";
/** `nsis` is the per-user Windows `-setup.exe` installer. */
export type InstallerKind = "nsis" | "msi" | "dmg" | "appimage" | "deb" | "rpm";

export interface ReleasePlatform {
  os: ReleaseOs;
  arch: ReleaseArch;
  /** Human-readable system requirement, e.g. "Windows 10 (1809) or later, 64-bit". */
  label: string;
  kind: InstallerKind;
  /** Installer file name, e.g. "KalCode_0.1.0_x64-setup.exe". */
  file: string;
  /** Site-relative download URL, e.g. "/download/windows-x64". Always served by the Worker. */
  url: string;
  /** Pinned, immutable URL for this exact file, e.g. "/download/0.1.0/KalCode_0.1.0_x64-setup.exe". */
  pinnedUrl: string;
  /** Size in bytes. */
  size: number;
  /** Lowercase hex SHA-256 of the file. */
  sha256: string;
  /** Whether the installer carries an Authenticode (or platform) code signature. */
  signed: boolean;
}

export interface Release {
  /** Semantic version from apps/desktop/src-tauri/tauri.conf.json. */
  version: string;
  channel: ReleaseChannel;
  /** ISO 8601 timestamp of the publish. */
  publishedAt: string;
  /** Full git commit the installer was built from. */
  commit: string;
  /** Site-relative link to the release notes, e.g. "/updates#release-0-1-0". */
  notesUrl: string;
  platforms: ReleasePlatform[];
}

export interface UnavailablePlatform {
  os: ReleaseOs;
  label: string;
  /** Plain-language reason there is no build, suitable for display. */
  reason: string;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  latest: Release | null;
  unavailable: UnavailablePlatform[];
}
