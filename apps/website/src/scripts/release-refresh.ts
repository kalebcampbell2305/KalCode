/**
 * Keeps /download truthful between a release publish and the next site deploy.
 *
 * The page is rendered from the `releases.json` bundled at build time, but publishing a release
 * switches `/download/<os>-<arch>` and `/releases/latest.json` (same origin, served by the Worker)
 * before the site is rebuilt. This reads that live manifest once and, for each build the page
 * already lists, rewrites the version, date, file name, size, SHA-256, signature label, checksum
 * command and `download=` file name when they differ. The static values stay as the no-JS and
 * failed-fetch fallback; a malformed manifest changes nothing.
 *
 * `checksumCommand` and `signatureLabel` are also used by DownloadPlatforms.astro so the server
 * render and this refresh always produce the same text.
 */
import type { Release, ReleaseOs, ReleasePlatform } from "../data/releases";
import { formatBytes, formatReleaseDate, publicVersion } from "../lib/releases";

export const LATEST_RELEASE_PATH = "/releases/latest.json";

const SHA256 = /^[0-9a-f]{64}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const OS: readonly string[] = ["windows", "macos", "linux"];

export function signatureLabel(os: ReleaseOs, signed: boolean): string {
  if (signed) return "Code-signed";
  return os === "macos" ? "Not code-signed or notarized" : "Not code-signed";
}

export function checksumCommand(os: ReleaseOs, file: string): string {
  if (os === "windows") return `Get-FileHash .\\${file} -Algorithm SHA256`;
  if (os === "macos") return `shasum -a 256 "./${file}"`;
  return `sha256sum "./${file}"`;
}

function isPlatform(value: unknown): value is ReleasePlatform {
  if (typeof value !== "object" || value === null) return false;
  const platform = value as Partial<ReleasePlatform>;
  return (
    typeof platform.os === "string" &&
    OS.includes(platform.os) &&
    typeof platform.arch === "string" &&
    typeof platform.file === "string" &&
    FILE.test(platform.file) &&
    typeof platform.url === "string" &&
    platform.url.startsWith("/download/") &&
    typeof platform.size === "number" &&
    Number.isFinite(platform.size) &&
    platform.size > 0 &&
    typeof platform.sha256 === "string" &&
    SHA256.test(platform.sha256) &&
    typeof platform.signed === "boolean"
  );
}

/** The published release in a fetched manifest, or null when it is missing or malformed. */
export function liveRelease(value: unknown): Release | null {
  if (typeof value !== "object" || value === null) return null;
  const manifest = value as { schemaVersion?: unknown; latest?: Partial<Release> | null };
  const latest = manifest.latest;
  if (manifest.schemaVersion !== 1 || typeof latest !== "object" || latest === null) return null;
  if (
    typeof latest.version !== "string" ||
    (latest.channel !== "stable" && latest.channel !== "preview") ||
    typeof latest.publishedAt !== "string" ||
    Number.isNaN(Date.parse(latest.publishedAt)) ||
    !Array.isArray(latest.platforms) ||
    !latest.platforms.every(isPlatform)
  ) {
    return null;
  }
  return latest as Release;
}

function setText(root: ParentNode, selector: string, text: string): void {
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    if (element.textContent !== text) element.textContent = text;
  }
}

/** Rewrites the listed builds from a fetched manifest. Returns whether the manifest was usable. */
export function applyLatestRelease(root: ParentNode, manifest: unknown): boolean {
  const release = liveRelease(manifest);
  if (!release) return false;
  const version = publicVersion(release.version);
  const label = release.channel === "stable" ? "Stable" : "Preview";
  const date = formatReleaseDate(release.publishedAt);
  setText(root, "[data-page-status]", `${label} ${version} · ${date}`);
  for (const row of root.querySelectorAll<HTMLElement>('[data-platforms] [data-state="available"][data-os]')) {
    const build = release.platforms.find(
      (platform) => platform.os === row.dataset.os && platform.arch === row.dataset.arch,
    );
    if (!build) continue;
    setText(row, "[data-release-chip]", `${label} ${version}`);
    setText(row, "[data-release-version]", version);
    for (const time of row.querySelectorAll<HTMLTimeElement>("[data-release-published]")) {
      time.dateTime = release.publishedAt;
      time.textContent = date;
    }
    setText(row, "[data-release-file]", build.file);
    setText(row, "[data-release-size]", formatBytes(build.size));
    setText(row, "[data-sha256]", build.sha256);
    setText(row, "[data-release-signature]", signatureLabel(build.os, build.signed));
    setText(row, "[data-release-checksum]", checksumCommand(build.os, build.file));
    for (const link of row.querySelectorAll<HTMLAnchorElement>("[data-release-download]")) {
      link.setAttribute("href", build.url);
      link.setAttribute("download", build.file);
    }
  }
  return true;
}

/** Fetches the live manifest and applies it. Any failure leaves the rendered page as it is. */
export async function refreshLatestRelease(root: ParentNode, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher(LATEST_RELEASE_PATH, { cache: "no-store", headers: { accept: "application/json" } });
    if (!response.ok) return false;
    return applyLatestRelease(root, await response.json());
  } catch {
    return false;
  }
}
