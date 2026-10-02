import type { ReleaseManifest } from "../../../src/data/releases";

/** A manifest as the release tooling writes it after publishing an unsigned Windows preview. */
export const publishedManifest: ReleaseManifest = {
  schemaVersion: 1,
  latest: {
    version: "0.1.0",
    channel: "preview",
    publishedAt: "2026-09-24T12:00:00.000Z",
    commit: "0123456789abcdef0123456789abcdef01234567",
    notesUrl: "/updates#release-0-1-0",
    platforms: [
      {
        os: "windows",
        arch: "x64",
        label: "Windows 10 (1809) or later, 64-bit",
        kind: "nsis",
        file: "KalCode_0.1.0_x64-setup.exe",
        url: "/download/windows-x64",
        pinnedUrl: "/download/0.1.0/KalCode_0.1.0_x64-setup.exe",
        size: 3_836_045,
        sha256: "c".repeat(64),
        signed: false,
      },
    ],
  },
  unavailable: [
    {
      os: "macos",
      label: "macOS",
      reason:
        "Not available yet. macOS builds need a macOS build machine and Apple code signing, which are not set up.",
    },
    {
      os: "linux",
      label: "Linux",
      reason: "Not available yet. Linux builds need a Linux build machine and have not been tested.",
    },
  ],
};

/**
 * A synthetic signed Stable `X.Y.Z+N` build manifest with exactly the shape of `base` (pass the committed
 * releases.json): only the version-bound fields change, as publish.mjs writes them for a build: version,
 * plus-free `KalCode_X.Y.Z_buildN_*` file names pinned under `/download/X.Y.Z+N/`, the public version's
 * Updates entry and a publication time.
 */
export function syntheticBuild(base: ReleaseManifest, publicVersion: string, build: number): ReleaseManifest {
  const manifest = structuredClone(base);
  if (!manifest.latest) throw new Error("base manifest has no release");
  const version = `${publicVersion}+${build}`;
  manifest.latest.version = version;
  manifest.latest.publishedAt = "2026-10-08T01:23:45.000Z";
  manifest.latest.notesUrl = `/updates#release-${publicVersion.replaceAll(".", "-")}`;
  for (const platform of manifest.latest.platforms) {
    platform.file = platform.file.replace(/^KalCode_[^_]+(?:_build\d+)?_/, `KalCode_${publicVersion}_build${build}_`);
    platform.pinnedUrl = `/download/${version}/${platform.file}`;
  }
  return manifest;
}
