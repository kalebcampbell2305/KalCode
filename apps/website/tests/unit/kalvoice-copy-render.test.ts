import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseManifest } from "../../src/data/releases";
import { publishedManifest } from "./fixtures/releases";

const fixture = vi.hoisted(() => ({ manifest: {} as ReleaseManifest }));
vi.mock("../../src/lib/releases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/releases")>()),
  RELEASES: fixture.manifest,
}));

import KalVoiceDemo from "../../src/components/stage/KalVoiceDemo.astro";
import LocalFirstDocs from "../../src/pages/docs/local-first.astro";
import ProvidersDocs from "../../src/pages/docs/providers.astro";
import Home from "../../src/pages/index.astro";
import KalVoicePage from "../../src/pages/kalvoice.astro";
import Privacy from "../../src/pages/privacy.astro";
import Security from "../../src/pages/security.astro";

beforeEach(() => Object.assign(fixture.manifest, structuredClone(publishedManifest)));

/** A signed Stable 0.1.5 selection for Windows and Apple silicon, as the publisher generates it. */
function selectSignedStable() {
  const latest = fixture.manifest.latest;
  const windows = latest?.platforms[0];
  if (!latest || !windows) throw new Error("fixture has no Windows release");
  latest.version = "0.1.5";
  latest.channel = "stable";
  windows.signed = true;
  latest.platforms.push({
    os: "macos",
    arch: "arm64",
    label: "macOS 14 or later, Apple silicon",
    kind: "dmg",
    file: "KalCode_0.1.5_arm64.dmg",
    url: "/download/macos-arm64",
    pinnedUrl: "/download/0.1.5/KalCode_0.1.5_arm64.dmg",
    size: 13_840_849,
    sha256: "d".repeat(64),
    signed: true,
  });
  fixture.manifest.unavailable = fixture.manifest.unavailable.filter((entry) => entry.os !== "macos");
}

type Component = Parameters<AstroContainer["renderToString"]>[0];

async function render(component: Component, path: string) {
  const container = await AstroContainer.create();
  return container.renderToString(component, { request: new Request(`https://kalcoded.com${path}`) });
}

/** Visible text only, so attribute values and markup never satisfy a copy assertion. */
function text(html: string) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

// KalVoice interprets commands with its on-device interpreter only (docs/KALVOICE.md, "KalVoice
// intelligence"): missing local reasoning fails closed and never falls back to a connected provider.
const PROVIDER_ROUTING = [
  /requests that need reasoning run on the provider you choose/i,
  /Commands that need a model use the provider you choose/i,
  /Reasoning uses an account you connected/i,
  /needs reasoning, the request goes to the AI provider/i,
];

describe.each([
  { name: "KalVoice page", component: KalVoicePage as Component, path: "/kalvoice" },
  { name: "provider docs", component: ProvidersDocs as Component, path: "/docs/providers" },
  { name: "privacy page", component: Privacy as Component, path: "/privacy" },
])("the $name", ({ component, path }) => {
  it("never says KalVoice sends requests to a connected provider for interpretation", async () => {
    const copy = text(await render(component, path));
    for (const claim of PROVIDER_ROUTING) expect(copy).not.toMatch(claim);
    expect(copy).toMatch(/on your (computer|device)/i);
  });
});

it("states that KalVoice interpretation does not reach connected providers on the privacy page", async () => {
  const copy = text(await render(Privacy, "/privacy"));
  expect(copy).toContain("KalVoice interprets commands on your device");
  expect(copy).toContain(
    "It never uses the AI providers you connected, or KalCode's servers, to understand what you said.",
  );
});

/** KalVoice copy that is true only until a signed Stable build is served from /download. */
const DEVELOPMENT_LABELS: { name: string; component: Component; path: string; label: RegExp }[] = [
  { name: "home KalVoice section", component: Home as Component, path: "/", label: /KalVoice · in development/ },
  // The hero status chip; the sample app window's rail keeps its own scripted "In development" group.
  {
    name: "KalVoice page",
    component: KalVoicePage as Component,
    path: "/kalvoice",
    label: /In development KalVoice: Speak your prompts/,
  },
  { name: "security page", component: Security as Component, path: "/security", label: /KalVoice, in development,/ },
  { name: "privacy page", component: Privacy as Component, path: "/privacy", label: /KalVoice \(in development\)/ },
  {
    name: "local-first docs",
    component: LocalFirstDocs as Component,
    path: "/docs/local-first",
    label: /KalVoice dictation, in development,/,
  },
  {
    name: "KalVoice demo",
    component: KalVoiceDemo as Component,
    path: "/kalvoice",
    label: /KalVoice is in development/,
  },
];

describe.each(DEVELOPMENT_LABELS)("the $name", ({ component, path, label }) => {
  it("labels KalVoice as in development while /download serves the preview", async () => {
    expect(text(await render(component, path))).toMatch(label);
  });

  it("drops the in-development label once /download serves signed Stable", async () => {
    selectSignedStable();
    expect(text(await render(component, path))).not.toMatch(label);
  });
});

it("describes KalVoice as available in Stable on the KalVoice page and in its metadata", async () => {
  selectSignedStable();
  const html = await render(KalVoicePage, "/kalvoice");
  expect(text(html)).toContain("Available in KalCode Stable 0.1.5");
  const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1];
  expect(description).toBeDefined();
  expect(description).not.toMatch(/In development/);
});

it("keeps the in-development metadata for the KalVoice page while /download serves the preview", async () => {
  const html = await render(KalVoicePage, "/kalvoice");
  expect(html.match(/<meta name="description" content="([^"]*)"/)?.[1]).toMatch(/In development\.$/);
});
