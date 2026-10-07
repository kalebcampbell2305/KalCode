import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseManifest } from "../../src/data/releases";
import committedJson from "../../src/data/releases.json";
import { publishedManifest, syntheticBuild } from "./fixtures/releases";

// KalCode 0.1.10 is an owner-declared public version (a label change: no new features). Its release is
// published as a 0.1.10+N build, named by its public version, with notes at /updates#release-0-1-10.
// 0.1.9 then stays in the archive, un-featured, with its builds. While the manifest selects 0.1.9 (or a
// 0.1.9+N build), nothing about 0.1.10 appears. The fixtures derive from the committed releases.json,
// whichever version it holds.

const fixture = vi.hoisted(() => ({ manifest: {} as ReleaseManifest }));
vi.mock("../../src/lib/releases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/releases")>()),
  RELEASES: fixture.manifest,
}));

import DownloadPlatforms from "../../src/components/DownloadPlatforms.astro";
import { NOTES_0110 } from "../../src/lib/release-notes";
import { assertManifest, displayManifest } from "../../src/lib/releases";
import Updates from "../../src/pages/updates.astro";

const COMMITTED = committedJson as ReleaseManifest;

const WINDOWS_NOTE =
  "Windows: 0.1.6 can't update itself. If you have 0.1.6, download this installer and run it once — your data is kept. On macOS, 0.1.6 updates in the app.";

function signedStableBuild(publicVersion: string, build: number): ReleaseManifest {
  return assertManifest(syntheticBuild(COMMITTED, publicVersion, build));
}

function select(manifest: ReleaseManifest) {
  for (const key of Object.keys(fixture.manifest)) delete (fixture.manifest as Record<string, unknown>)[key];
  Object.assign(fixture.manifest, displayManifest(manifest));
}

async function renderUpdates() {
  const container = await AstroContainer.create();
  return container.renderToString(Updates, { request: new Request("https://kalcoded.com/updates") });
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

const entry = (html: string, id: string) =>
  html.match(new RegExp(`<article[^>]*id="${id}"[\\s\\S]*?</article>`))?.[0] ?? "";

beforeEach(() => select(structuredClone(publishedManifest) as ReleaseManifest));

describe("the Updates page for 0.1.10", () => {
  it("features 0.1.10 above the un-featured 0.1.9, 0.1.8, 0.1.7 and 0.1.6 entries from a signed Stable 0.1.10 build", async () => {
    select(signedStableBuild("0.1.10", 2200));
    const html = await renderUpdates();
    const copy = text(html);
    const ids = ["release-0-1-10", "release-0-1-9", "release-0-1-8", "release-0-1-7", "release-0-1-6"];
    for (const id of ids) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`href="#${id}"`);
    }
    for (let i = 1; i < ids.length; i += 1) {
      expect(html.indexOf(`id="${ids[i - 1]}"`)).toBeLessThan(html.indexOf(`id="${ids[i]}"`));
      expect(html.indexOf(`href="#${ids[i - 1]}"`)).toBeLessThan(html.indexOf(`href="#${ids[i]}"`));
    }
    expect(html.match(/<article/g)).toHaveLength(9);
    expect(html.match(/update--featured/g)).toHaveLength(1);
    expect(html).toMatch(/<article class="update update--featured" id="release-0-1-10"/);
    expect(html).toMatch(/<article class="update" id="release-0-1-9"/);

    // The release is named by its public version and the manifest's publication date.
    const current = entry(html, "release-0-1-10");
    expect(text(current)).toContain("KalCode 0.1.10 is here.");
    expect(copy).not.toContain("0.1.10+2200");
    expect(current).toContain('<time datetime="2026-10-08T01:23:45.000Z"');
    expect(text(current)).toContain("From 0.1.9: nothing to do. Close KalCode and it installs 0.1.10 by itself.");
    expect(text(current)).toContain(
      "From 0.1.8 or 0.1.7: update in the app with Restart to update or Settings > Updates.",
    );
    expect(current).toMatch(
      /Download the 0\.1\.10 installer from the <a class="text-link" href="\/download"[^>]*>download page<\/a> and run it once/,
    );
    expect(text(current)).toContain("macOS: update from 0.1.6 in the app.");
    expect(current).not.toMatch(/\$\d/);
    // Only builds /download serves (or older) are listed, straight from docs/releases/0.1.10+<build>.md.
    const listed = [...current.matchAll(/id="build-(\d+)"/g)].map((match) => Number(match[1]));
    expect(listed).toEqual(NOTES_0110.filter((notes) => notes.build <= 2200).map((notes) => notes.build));

    // 0.1.9 keeps its own date and its builds, newest first, with none marked Latest.
    const archived = entry(html, "release-0-1-9");
    expect(archived).toContain('<time datetime="2026-10-07T12:11:47.550Z"');
    expect(text(archived)).toContain("Build 2184");
    for (const build of [2184, 1816, 1738, 1658, 1565]) expect(archived).toContain(`id="build-${build}"`);
    expect(archived.indexOf('id="build-2184"')).toBeLessThan(archived.indexOf('id="build-1816"'));
    expect(archived.indexOf('id="build-1738"')).toBeLessThan(archived.indexOf('id="build-1565"'));
    expect(archived).not.toContain("build--latest");
    expect(archived).not.toContain("build__latest");
    expect(text(archived)).toContain("KalCode 0.1.9 puts every agent, account and terminal in one command deck.");
  });

  it("announces no 0.1.10 while the manifest selects 0.1.9 or a 0.1.9 build", async () => {
    // Fixed 0.1.9 manifests: COMMITTED becomes 0.1.10+N once the assemble step writes the 0.1.10 releases.json.
    for (const manifest of [
      signedStableBuild("0.1.9", 2184),
      (() => {
        const plain = signedStableBuild("0.1.9", 2184);
        if (plain.latest) plain.latest.version = "0.1.9";
        return plain;
      })(),
    ]) {
      select(manifest);
      const html = await renderUpdates();
      // The footer's buildStatus() reads the module's own RELEASES (the committed releases.json), not the mock.
      const main = html.match(/<main[\s\S]*<\/main>/)?.[0] ?? "";
      expect(main).not.toBe("");
      expect(html).not.toContain("release-0-1-10");
      expect(main).not.toContain("0.1.10");
      expect(html).toMatch(/<article class="update update--featured" id="release-0-1-9"/);
      expect(html.match(/update--featured/g)).toHaveLength(1);
      expect(html.match(/<article/g)).toHaveLength(8);
    }
  });
});

describe("the download page for 0.1.10", () => {
  it("still tells Windows users of 0.1.6 to run the installer once, only in the Windows row", async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(DownloadPlatforms, {
      props: { manifest: displayManifest(signedStableBuild("0.1.10", 2200)) },
    });
    const row = (os: string) => html.match(new RegExp(`<li[^>]*id="${os}"[\\s\\S]*?</li>`))?.[0] ?? "";
    expect(text(row("windows"))).toContain(WINDOWS_NOTE);
    expect(row("macos")).not.toContain("data-windows-update-note");
    expect(html.match(/data-windows-update-note/g)).toHaveLength(1);
    expect(html).toContain('href="/updates#release-0-1-10"');
    expect(html).toContain("KalCode_0.1.10_build2200_x64-setup.exe");
    expect(text(html)).not.toContain("0.1.10+2200");
  });
});
