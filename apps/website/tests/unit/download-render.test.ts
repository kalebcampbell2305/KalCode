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

const STABLE_DUAL: ReleaseManifest = {
  schemaVersion: 1,
  latest: {
    ...(publishedManifest.latest as NonNullable<ReleaseManifest["latest"]>),
    channel: "stable",
    platforms: [
      {
        ...(publishedManifest.latest?.platforms[0] as NonNullable<ReleaseManifest["latest"]>["platforms"][number]),
        signed: true,
      },
      {
        os: "macos",
        arch: "arm64",
        label: "macOS 14 or later, Apple silicon",
        kind: "dmg",
        file: "KalCode_0.1.0_arm64.dmg",
        url: "/download/macos-arm64",
        pinnedUrl: "/download/0.1.0/KalCode_0.1.0_arm64.dmg",
        size: 4_200_000,
        sha256: "d".repeat(64),
        signed: true,
      },
    ],
  },
  unavailable: [{ os: "linux", label: "Linux", reason: "Not available yet." }],
};

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
    const notesUrl = publishedManifest.latest?.notesUrl.replace(/^\/changelog(?=#|$)/, "/updates");
    expect(links).toEqual([windows.url, notesUrl, "/terms#preview"]);
    expect(html).toContain(`download="${windows.file}"`);

    const body = text(html);
    expect(body).toContain("Download for Windows");
    expect(body).toContain(windows.sha256);
    expect(body).toContain("3.8 MB");
    expect(body).toContain("SmartScreen");
    expect(body).toContain("Not code-signed");
    expect(body).toContain(`Get-FileHash .\\${windows.file} -Algorithm SHA256`);
    expect(body).not.toContain("Run anyway");
    // macOS and Linux stay unavailable, with the manifest's reasons and no links.
    expect(body.match(/Not yet available/g)).toHaveLength(2);
    for (const entry of publishedManifest.unavailable) expect(body).toContain(entry.reason);
  });

  it("renders stable Windows and Mac downloads with their own checksum commands", async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(DownloadPlatforms, { props: { manifest: STABLE_DUAL } });
    const body = text(html);
    expect(body.match(/Stable 0\.1\.0/g)).toHaveLength(2);
    expect(body).not.toContain("Preview 0.1.0");
    expect(body).toContain("Get-FileHash .\\KalCode_0.1.0_x64-setup.exe -Algorithm SHA256");
    expect(html).toContain("shasum -a 256 &quot;./KalCode_0.1.0_arm64.dmg&quot;");
    expect(html).toContain('href="/download/windows-x64"');
    expect(html).toContain('href="/download/macos-arm64"');
    expect(body).toContain("copy KalCode.app to ~/Applications before launching it");
    expect(body).toContain("Create an Applications folder in your home folder if needed");
    expect(body).toContain("supports in-app updates and rollback");
    expect(body).toContain("shortcut points to the system /Applications folder");
    expect(body).toContain("requires an administrator to replace the app manually for later versions");
    expect(html.indexOf("On a standard Mac account")).toBeLessThan(html.indexOf('href="/download/macos-arm64"'));
    expect(html).toContain('id="windows"');
    expect(html).toContain('id="macos"');
    expect(html).toContain('id="linux"');
    expect(body).toContain("KalCode terms");
    expect(body).not.toContain("preview terms");
  });

  it("tells Windows users of 0.1.6 to download the next version, only in the Windows row of 0.1.6", async () => {
    const WINDOWS_NOTE =
      "In-app updates don't work in 0.1.6 on Windows. When 0.1.7 is available, download it here and run the installer — your data is kept.";
    const stable016: ReleaseManifest = structuredClone(STABLE_DUAL);
    if (!stable016.latest) throw new Error("fixture has no release");
    stable016.latest.version = "0.1.6";
    const container = await AstroContainer.create();
    const html = await container.renderToString(DownloadPlatforms, { props: { manifest: stable016 } });
    const row = (os: string) => html.match(new RegExp(`<li[^>]*id="${os}"[\\s\\S]*?</li>`))?.[0] ?? "";
    expect(text(row("windows")).replace(/&#39;|&apos;/g, "'")).toContain(WINDOWS_NOTE);
    expect(row("windows").indexOf("data-windows-update-note")).toBeLessThan(
      row("windows").indexOf("Download for Windows"),
    );
    expect(row("macos")).not.toContain("data-windows-update-note");
    expect(html.match(/data-windows-update-note/g)).toHaveLength(1);

    for (const manifest of [STABLE_DUAL, publishedManifest]) {
      const other = await container.renderToString(DownloadPlatforms, { props: { manifest } });
      expect(other).not.toContain("data-windows-update-note");
    }
  });

  it("describes an unsigned Mac preview without telling people to bypass Gatekeeper", async () => {
    const manifest: ReleaseManifest = {
      ...STABLE_DUAL,
      latest: {
        ...(STABLE_DUAL.latest as NonNullable<ReleaseManifest["latest"]>),
        channel: "preview",
        platforms: [
          {
            ...(STABLE_DUAL.latest?.platforms[1] as NonNullable<ReleaseManifest["latest"]>["platforms"][number]),
            signed: false,
          },
        ],
      },
      unavailable: [
        { os: "windows", label: "Windows", reason: "Not available yet." },
        { os: "linux", label: "Linux", reason: "Not available yet." },
      ],
    };
    const container = await AstroContainer.create();
    const html = await container.renderToString(DownloadPlatforms, { props: { manifest } });
    const body = text(html);
    expect(body).toContain("not code-signed or notarized");
    expect(body).toContain("does not ask you to bypass Gatekeeper");
    expect(body).not.toContain("SmartScreen");
    expect(body).not.toContain("Run anyway");
  });
});
