import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseManifest } from "../../src/data/releases";
import { publishedManifest } from "./fixtures/releases";

// KalCode 0.1.8 is an owner-declared public version. Its release is published as a 0.1.8+N build;
// the site names it by the public version (displayManifest), and its notes live at /updates#release-0-1-8.

const fixture = vi.hoisted(() => ({ manifest: {} as ReleaseManifest }));
vi.mock("../../src/lib/releases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/releases")>()),
  RELEASES: fixture.manifest,
}));

import DownloadPlatforms from "../../src/components/DownloadPlatforms.astro";
import { displayManifest } from "../../src/lib/releases";
import Updates from "../../src/pages/updates.astro";

const WINDOWS_NOTE =
  "Windows: 0.1.6 can't update itself. If you have 0.1.6, download this installer and run it once — your data is kept. On macOS, 0.1.6 updates in the app.";

/** A complete signed Stable build for Windows and Apple silicon, as publish.mjs generates it. */
function signedStable(version: string): ReleaseManifest {
  const manifest = structuredClone(publishedManifest) as ReleaseManifest;
  if (!manifest.latest) throw new Error("fixture has no release");
  const fileVersion = version.replace("+", "_build");
  manifest.latest.version = version;
  manifest.latest.channel = "stable";
  manifest.latest.publishedAt = "2026-10-08T01:23:45.000Z";
  manifest.latest.notesUrl = `/updates#release-${version.replace(/\+\d+$/, "").replaceAll(".", "-")}`;
  const windows = manifest.latest.platforms[0];
  if (!windows) throw new Error("fixture has no Windows platform");
  windows.signed = true;
  windows.file = `KalCode_${fileVersion}_x64-setup.exe`;
  windows.pinnedUrl = `/download/${version}/${windows.file}`;
  manifest.latest.platforms.push({
    os: "macos",
    arch: "arm64",
    label: "macOS 14 or later, Apple silicon",
    kind: "dmg",
    file: `KalCode_${fileVersion}_arm64.dmg`,
    url: "/download/macos-arm64",
    pinnedUrl: `/download/${version}/KalCode_${fileVersion}_arm64.dmg`,
    size: 4_200_000,
    sha256: "d".repeat(64),
    signed: true,
  });
  manifest.unavailable = manifest.unavailable.filter((entry) => entry.os !== "macos");
  return manifest;
}

function select(manifest: ReleaseManifest) {
  for (const key of Object.keys(fixture.manifest)) delete (fixture.manifest as Record<string, unknown>)[key];
  Object.assign(fixture.manifest, displayManifest(manifest));
}

async function render(component: Parameters<AstroContainer["renderToString"]>[0], path: string) {
  const container = await AstroContainer.create();
  return container.renderToString(component, { request: new Request(`https://kalcoded.com${path}`) });
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

beforeEach(() => select(structuredClone(publishedManifest) as ReleaseManifest));

describe("the Updates page for 0.1.8", () => {
  it("features 0.1.8 above the un-featured 0.1.7 and 0.1.6 entries from a signed Stable 0.1.8 build", async () => {
    select(signedStable("0.1.8+900"));
    const html = await render(Updates, "/updates");
    const copy = text(html);
    for (const id of ["release-0-1-8", "release-0-1-7", "release-0-1-6"]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`href="#${id}"`);
    }
    expect(html.indexOf('id="release-0-1-8"')).toBeLessThan(html.indexOf('id="release-0-1-7"'));
    expect(html.indexOf('id="release-0-1-7"')).toBeLessThan(html.indexOf('id="release-0-1-6"'));
    expect(html.match(/update--featured/g)).toHaveLength(1);
    expect(html).toMatch(/<article class="update update--featured" id="release-0-1-8"/);
    // The site names the build by its public version only.
    expect(copy).toContain("KalCode 0.1.8");
    expect(copy).not.toContain("0.1.8+900");
    expect(copy).toContain("October 8, 2026");
    // 0.1.7 and 0.1.6 keep their own publication dates.
    expect(html).toContain('<time datetime="2026-09-30T18:25:35.409Z"');
    expect(html).toContain('<time datetime="2026-09-30T02:34:07.332Z"');
    expect(copy).toContain("From 0.1.7: update in the app with Restart to update or Settings > Updates.");
    expect(copy).toContain(
      "Windows: 0.1.6 can't update itself. Download the 0.1.8 installer from the download page and run it once — your data is kept.",
    );
    expect(copy).toContain("A new Operations page: Runs, Queue, Services, Environments and Activity.");
    expect(copy).toContain("Amber now means a thread or terminal is waiting for you.");
    expect(copy).toContain(
      "When memory is low, KalVoice stops the recording and tells you, instead of closing KalCode.",
    );
  });

  it("announces no 0.1.8 while the manifest selects 0.1.7 or a 0.1.7 build", async () => {
    for (const version of ["0.1.7", "0.1.7+900"]) {
      select(signedStable(version));
      const html = await render(Updates, "/updates");
      expect(html).not.toContain("release-0-1-8");
      expect(html).not.toContain("KalCode 0.1.8");
      expect(html).toMatch(/<article class="update update--featured" id="release-0-1-7"/);
    }
  });
});

describe("the download page for 0.1.8", () => {
  it("still tells Windows users of 0.1.6 to run the installer once, only in the Windows row", async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(DownloadPlatforms, {
      props: { manifest: displayManifest(signedStable("0.1.8+900")) },
    });
    const row = (os: string) => html.match(new RegExp(`<li[^>]*id="${os}"[\\s\\S]*?</li>`))?.[0] ?? "";
    expect(text(row("windows"))).toContain(WINDOWS_NOTE);
    expect(row("macos")).not.toContain("data-windows-update-note");
    expect(html.match(/data-windows-update-note/g)).toHaveLength(1);
    expect(html).toContain('href="/updates#release-0-1-8"');
  });
});
