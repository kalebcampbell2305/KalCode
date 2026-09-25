import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import DownloadPlatforms from "../../src/components/DownloadPlatforms.astro";
import type { ReleaseManifest } from "../../src/data/releases";
import { publishedManifest } from "./fixtures/releases";

const EMPTY: ReleaseManifest = {
  ...publishedManifest,
  latest: null,
  unavailable: [
    { os: "windows", label: "Windows 10 (1809) or later, 64-bit", reason: "No public build has been published yet." },
    ...publishedManifest.unavailable,
  ],
};

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("download page platforms", () => {
  it("with no public build: every OS is unavailable, with its reason, and there are no links", async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(DownloadPlatforms, { props: { manifest: EMPTY } });
    expect(html).not.toMatch(/<a\s/);
    expect(html).not.toContain("download=");
    const body = text(html);
    expect(body.match(/Not yet available/g)).toHaveLength(3);
    for (const entry of EMPTY.unavailable) expect(body).toContain(entry.reason);
  });

  it("with an unsigned Windows preview: a download, the checksum and the SmartScreen note", async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(DownloadPlatforms, { props: { manifest: publishedManifest } });
    const windows = publishedManifest.latest?.platforms[0];
    if (!windows) throw new Error("fixture has no Windows build");

    const links = [...html.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((match) => match[1]);
    expect(links).toEqual([windows.url, publishedManifest.latest?.notesUrl, "/terms#preview"]);
    expect(html).toContain(`download="${windows.file}"`);

    const body = text(html);
    expect(body).toContain("Download for Windows");
    expect(body).toContain(windows.sha256);
    expect(body).toContain("3.8 MB");
    expect(body).toContain("SmartScreen");
    expect(body).toContain("Not code-signed");
    // macOS and Linux stay unavailable, with the manifest's reasons and no links.
    expect(body.match(/Not yet available/g)).toHaveLength(2);
    for (const entry of publishedManifest.unavailable) expect(body).toContain(entry.reason);
  });
});
