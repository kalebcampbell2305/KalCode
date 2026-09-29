import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseManifest } from "../../src/data/releases";
import { publishedManifest } from "./fixtures/releases";

const fixture = vi.hoisted(() => ({ manifest: {} as ReleaseManifest }));
vi.mock("../../src/lib/releases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/releases")>()),
  RELEASES: fixture.manifest,
}));

import Closing from "../../src/components/Closing.astro";
import KalVoiceDocs from "../../src/pages/docs/kalvoice.astro";
import Product from "../../src/pages/product.astro";
import Updates from "../../src/pages/updates.astro";

beforeEach(() => Object.assign(fixture.manifest, structuredClone(publishedManifest)));

async function renderUpdates() {
  const container = await AstroContainer.create();
  return container.renderToString(Updates, { request: new Request("https://kalcoded.com/updates") });
}

it("does not announce 0.1.6 while the generated manifest still selects Preview", async () => {
  const html = await renderUpdates();
  expect(html).not.toContain('id="release-0-1-6"');
  expect(html).not.toContain('href="#release-0-1-6"');
  expect(html).toContain('id="release-0-1-1"');
});

/** A Stable 0.1.6 selection with a signed Windows build and a signed, unsigned or absent Mac build. */
function selectStable(mac: "signed" | "unsigned" | "none") {
  if (!fixture.manifest.latest) throw new Error("fixture has no release");
  fixture.manifest.latest.version = "0.1.6";
  fixture.manifest.latest.channel = "stable";
  fixture.manifest.latest.publishedAt = "2026-10-02T01:23:45.000Z";
  const windows = fixture.manifest.latest.platforms[0];
  if (!windows) throw new Error("fixture has no Windows platform");
  windows.signed = true;
  if (mac === "none") return;
  fixture.manifest.latest.platforms.push({
    os: "macos",
    arch: "arm64",
    label: "macOS 14 or later, Apple silicon",
    kind: "dmg",
    file: "KalCode_0.1.6_arm64.dmg",
    url: "/download/macos-arm64",
    pinnedUrl: "/download/0.1.6/KalCode_0.1.6_arm64.dmg",
    size: 4_200_000,
    sha256: "d".repeat(64),
    signed: mac === "signed",
  });
  fixture.manifest.unavailable = fixture.manifest.unavailable.filter((entry) => entry.os !== "macos");
}

function selectSignedStable() {
  selectStable("signed");
}

it("renders the Stable notes anchor and uses the publication date from the manifest", async () => {
  selectSignedStable();
  const html = await renderUpdates();
  expect(html).toContain('id="release-0-1-6"');
  expect(html).toContain('href="#release-0-1-6"');
  expect(html).toContain('datetime="2026-10-02T01:23:45.000Z"');
  expect(html).toContain("October 2, 2026");
  expect(html).toContain('href="/download"');
  expect(html).not.toContain("KalVoice is not part of the current public Windows preview");
});

it.each([false, true])(
  "keeps the product KalVoice row aligned with signed Stable availability (%s)",
  async (stable) => {
    if (stable) selectSignedStable();
    const container = await AstroContainer.create();
    const html = await container.renderToString(Product, { request: new Request("https://kalcoded.com/product") });
    const row = html.match(/<tr[\s\S]*?<\/tr>/g)?.find((item) => item.includes("KalVoice dictation and commands"));
    expect(row).toBeDefined();
    if (stable) {
      expect(row).toContain("Available in Stable");
      expect(row).not.toContain("In development");
    } else {
      expect(row).toContain("In development");
      expect(row).not.toContain("Available in Stable");
    }
  },
);

it("does not announce signed Windows and Mac availability from an incomplete Stable manifest", async () => {
  if (!fixture.manifest.latest) throw new Error("fixture has no release");
  fixture.manifest.latest.version = "0.1.6";
  fixture.manifest.latest.channel = "stable";
  expect(await renderUpdates()).not.toContain('id="release-0-1-6"');
});

const STABLE_KALVOICE =
  "KalVoice ships in KalCode Stable 0.1.6. Speech recognition and command interpretation run on your computer; KalCode downloads and verifies their signed local components by itself when you first open it, with no separate Python or Ollama installation.";
const PREVIEW_KALVOICE = "KalVoice is in development and not available in a public build yet.";

/**
 * What /download serves decides the preview download button and the KalVoice docs sentence; the
 * 0.1.6 notes (and so the un-featured 0.1.1 entry) need the complete signed Windows and Mac release.
 * A Windows-only Stable or one with an unsigned Mac build still serves Stable from /download.
 */
const selections = [
  { name: "preview", mac: null, notes016: false, closing: "The preview is out for Windows.", stable: false },
  {
    name: "signed Windows and Mac Stable",
    mac: "signed",
    notes016: true,
    closing: "KalCode 0.1.6 is out for Windows and macOS.",
    stable: true,
  },
  {
    name: "Windows-only Stable",
    mac: "none",
    notes016: false,
    closing: "KalCode 0.1.6 is out for Windows.",
    stable: true,
  },
  {
    name: "Stable with an unsigned Mac build",
    mac: "unsigned",
    notes016: false,
    closing: "KalCode 0.1.6 is out for Windows and macOS.",
    stable: true,
  },
] as const;

describe.each(selections)("with a $name manifest", ({ mac, notes016, closing, stable }) => {
  beforeEach(() => {
    if (mac) selectStable(mac);
  });

  it("features 0.1.1 unless the 0.1.6 notes render, and offers its download only while /download serves the preview", async () => {
    const html = await renderUpdates();
    expect(html.includes('id="release-0-1-6"')).toBe(notes016);
    const preview = html.match(/<article[^>]*id="release-0-1-1"[\s\S]*?<\/article>/)?.[0];
    expect(preview).toBeDefined();
    expect(preview?.includes("update--featured")).toBe(!notes016);
    expect(preview?.includes("Download the Windows preview")).toBe(!stable);
  });

  it("names the channel and the systems /download serves in the closing section", async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(Closing);
    expect(html).toContain(closing);
    expect(html.includes("The preview is out")).toBe(!stable);
  });

  it("states KalVoice availability in the docs from what /download serves", async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(KalVoiceDocs, {
      request: new Request("https://kalcoded.com/docs/kalvoice"),
    });
    expect(html).not.toContain("not available in any build yet");
    expect(html).not.toContain("On-device speech recognition is included");
    expect(html.includes(STABLE_KALVOICE)).toBe(stable);
    expect(html.includes(PREVIEW_KALVOICE)).toBe(!stable);
  });
});
