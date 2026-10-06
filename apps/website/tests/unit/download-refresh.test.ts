import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { builtinEnvironments } from "vitest/runtime";
import DownloadPlatforms from "../../src/components/DownloadPlatforms.astro";
import type { ReleaseManifest, ReleasePlatform } from "../../src/data/releases";
import { LATEST_RELEASE_PATH, refreshLatestRelease } from "../../src/scripts/release-refresh";

const windows: ReleasePlatform = {
  os: "windows",
  arch: "x64",
  label: "Windows 10 (1809) or later, 64-bit",
  kind: "nsis",
  file: "KalCode_0.1.9_build1816_x64-setup.exe",
  url: "/download/windows-x64",
  pinnedUrl: "/download/0.1.9+1816/KalCode_0.1.9_build1816_x64-setup.exe",
  size: 8_900_000,
  sha256: "a".repeat(64),
  signed: true,
};
const macos: ReleasePlatform = {
  os: "macos",
  arch: "arm64",
  label: "macOS 14 or later, Apple silicon",
  kind: "dmg",
  file: "KalCode_0.1.9_build1816_arm64.dmg",
  url: "/download/macos-arm64",
  pinnedUrl: "/download/0.1.9+1816/KalCode_0.1.9_build1816_arm64.dmg",
  size: 12_800_000,
  sha256: "b".repeat(64),
  signed: true,
};

/** What the site was built with: build 1816, shown by its public version. */
const BUILT: ReleaseManifest = {
  schemaVersion: 1,
  latest: {
    version: "0.1.9",
    channel: "stable",
    publishedAt: "2026-10-04T10:00:00.000Z",
    commit: "1".repeat(40),
    notesUrl: "/updates#release-0-1-9",
    platforms: [windows, macos],
  },
  unavailable: [{ os: "linux", label: "Linux", reason: "Not available yet." }],
};

/** What /releases/latest.json serves after build 1873 was published, before the site redeploys. */
const LIVE: ReleaseManifest = {
  ...BUILT,
  latest: {
    ...(BUILT.latest as NonNullable<ReleaseManifest["latest"]>),
    version: "0.1.9+1873",
    publishedAt: "2026-10-06T00:09:08.595Z",
    commit: "2".repeat(40),
    platforms: [
      {
        ...windows,
        file: "KalCode_0.1.9_build1873_x64-setup.exe",
        pinnedUrl: "/download/0.1.9+1873/KalCode_0.1.9_build1873_x64-setup.exe",
        size: 8_969_496,
        sha256: "c".repeat(64),
      },
      {
        ...macos,
        file: "KalCode_0.1.9_build1873_arm64.dmg",
        pinnedUrl: "/download/0.1.9+1873/KalCode_0.1.9_build1873_arm64.dmg",
        size: 12_918_217,
        sha256: "d".repeat(64),
      },
    ],
  },
};

// The component renders under Node (Astro needs it); the refresh then runs against that markup in a
// jsdom document, as it does in the browser.
let html = "";
let teardown: (() => unknown) | undefined;
beforeAll(async () => {
  const container = await AstroContainer.create();
  html = await container.renderToString(DownloadPlatforms, { props: { manifest: BUILT } });
  ({ teardown } = await builtinEnvironments.jsdom.setup(globalThis, {}));
});
afterAll(async () => {
  await teardown?.(globalThis);
});

function renderPage(): void {
  document.body.innerHTML = `<p class="chip" data-page-status>Stable 0.1.9 · October 4, 2026</p>${html}`;
}

function fetchReturning(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body }) as Response);
}

const row = (os: string) => document.querySelector<HTMLElement>(`[data-os="${os}"]`) as HTMLElement;
const field = (os: string, selector: string) => row(os).querySelector<HTMLElement>(selector)?.textContent?.trim();

afterEach(() => document.body.replaceChildren());

describe("download page live release refresh", () => {
  it("rewrites each listed build from /releases/latest.json when a newer build is published", async () => {
    renderPage();
    expect(field("windows", "[data-sha256]")).toBe("a".repeat(64));
    const fetcher = fetchReturning(LIVE);

    expect(await refreshLatestRelease(document, fetcher)).toBe(true);

    expect(fetcher).toHaveBeenCalledWith(LATEST_RELEASE_PATH, expect.objectContaining({ cache: "no-store" }));
    expect(document.querySelector("[data-page-status]")?.textContent).toBe("Stable 0.1.9 · October 6, 2026");
    for (const [os, build, size, checksum] of [
      [
        "windows",
        LIVE.latest?.platforms[0],
        "9.0 MB",
        "Get-FileHash .\\KalCode_0.1.9_build1873_x64-setup.exe -Algorithm SHA256",
      ],
      ["macos", LIVE.latest?.platforms[1], "12.9 MB", 'shasum -a 256 "./KalCode_0.1.9_build1873_arm64.dmg"'],
    ] as const) {
      if (!build) throw new Error("fixture has no build");
      expect(field(os, "[data-release-chip]")).toBe("Stable 0.1.9");
      expect(field(os, "[data-release-version]")).toBe("0.1.9");
      const time = row(os).querySelector<HTMLTimeElement>("[data-release-published]");
      expect(time?.dateTime).toBe("2026-10-06T00:09:08.595Z");
      expect(time?.textContent).toBe("October 6, 2026");
      expect(field(os, "[data-release-file]")).toBe(build.file);
      expect(field(os, "[data-release-size]")).toBe(size);
      expect(field(os, "[data-sha256]")).toBe(build.sha256);
      expect(field(os, "[data-release-signature]")).toBe("Code-signed");
      expect(field(os, "[data-release-checksum]")).toBe(checksum);
      const link = row(os).querySelector<HTMLAnchorElement>("[data-release-download]");
      expect(link?.getAttribute("download")).toBe(build.file);
      expect(link?.getAttribute("href")).toBe(build.url);
    }
    expect(document.body.innerHTML).not.toContain("build1816");
  });

  it("keeps the built values when the manifest is unavailable or malformed", async () => {
    renderPage();
    const before = document.body.innerHTML;
    const tampered = structuredClone(LIVE);
    (tampered.latest as NonNullable<ReleaseManifest["latest"]>).platforms[0].sha256 = "not-a-hash";
    const offsite = structuredClone(LIVE);
    (offsite.latest as NonNullable<ReleaseManifest["latest"]>).platforms[0].url = "https://example.com/x.exe";

    expect(await refreshLatestRelease(document, fetchReturning(LIVE, false))).toBe(false);
    expect(await refreshLatestRelease(document, fetchReturning({ schemaVersion: 1, latest: null }))).toBe(false);
    expect(await refreshLatestRelease(document, fetchReturning(tampered))).toBe(false);
    expect(await refreshLatestRelease(document, fetchReturning(offsite))).toBe(false);
    expect(
      await refreshLatestRelease(
        document,
        vi.fn(async () => {
          throw new TypeError("offline");
        }),
      ),
    ).toBe(false);
    expect(document.body.innerHTML).toBe(before);
  });
});
