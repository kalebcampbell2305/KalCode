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
import KalVoiceDocs from "../../src/pages/docs/kalvoice.astro";
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
  /KalVoice[^.]*\b(reasoning|interpret\w*|model)\b[^.]*\bprovider you (chose|choose|connected)/i,
  /\b(reasoning|a model)\b[^.]*\b(provider you (chose|choose|connected)|account you connected)/i,
  /needs reasoning, the request goes to the AI provider/i,
  // No shipped KalVoice command sends a task or prompt to a provider.
  /a command sends/i,
];

describe.each([
  { name: "KalVoice page", component: KalVoicePage as Component, path: "/kalvoice" },
  { name: "provider docs", component: ProvidersDocs as Component, path: "/docs/providers" },
  { name: "privacy page", component: Privacy as Component, path: "/privacy" },
  { name: "local-first docs", component: LocalFirstDocs as Component, path: "/docs/local-first" },
])("the $name", ({ component, path }) => {
  it.each([false, true])(
    "never says KalVoice sends requests to a connected provider for interpretation (Stable %s)",
    async (stable) => {
      if (stable) selectSignedStable();
      const copy = text(await render(component, path));
      for (const claim of PROVIDER_ROUTING) expect(copy).not.toMatch(claim);
      expect(copy).toMatch(/(interpret\w*|understood)[^.]*on your (computer|device)/i);
    },
  );
});

it("states on the local-first docs that KalVoice interpretation stays on the computer", async () => {
  const copy = text(await render(LocalFirstDocs, "/docs/local-first"));
  expect(copy).toContain("KalVoice interprets commands on your computer and never sends them to a provider");
});

it("states that KalVoice interpretation does not reach connected providers on the privacy page", async () => {
  const copy = text(await render(Privacy, "/privacy"));
  expect(copy).toContain("KalVoice interprets commands on your device");
  expect(copy).toContain(
    "It never uses the AI providers you connected, or KalCode's servers, to understand what you said.",
  );
});

/** KalVoice copy that is true only until a signed Stable build is served from /download. */
const DEVELOPMENT_LABELS: { name: string; component: Component; path: string; label: RegExp; stable: RegExp }[] = [
  {
    name: "home KalVoice section",
    component: Home as Component,
    path: "/",
    label: /KalVoice · in development/,
    stable: /KalVoice Speak it\. See it done\./,
  },
  // The hero status chip; the sample app window's rail keeps its own scripted "In development" group.
  {
    name: "KalVoice page",
    component: KalVoicePage as Component,
    path: "/kalvoice",
    label: /In development KalVoice: Speak your prompts/,
    stable: /Available in KalCode Stable 0\.1\.5 KalVoice: Speak your prompts/,
  },
  {
    name: "security page",
    component: Security as Component,
    path: "/security",
    label: /KalVoice, in development,/,
    stable: /KalVoice transcribes dictation with a speech model/,
  },
  {
    name: "privacy page",
    component: Privacy as Component,
    path: "/privacy",
    label: /KalVoice \(in development\)/,
    stable: /In the KalCode app, KalVoice transcribes dictation on your device/,
  },
  {
    name: "local-first docs",
    component: LocalFirstDocs as Component,
    path: "/docs/local-first",
    label: /KalVoice dictation, in development,/,
    stable: /KalVoice dictation uses a speech-recognition model/,
  },
  {
    name: "KalVoice demo",
    component: KalVoiceDemo as Component,
    path: "/kalvoice",
    label: /KalVoice is in development/,
    stable: /Scripted demo · no microphone is used here/,
  },
];

describe.each(DEVELOPMENT_LABELS)("the $name", ({ component, path, label, stable }) => {
  it("labels KalVoice as in development while /download serves the preview", async () => {
    expect(text(await render(component, path))).toMatch(label);
  });

  it("drops the in-development label once /download serves signed Stable", async () => {
    selectSignedStable();
    const copy = text(await render(component, path));
    expect(copy).not.toMatch(label);
    expect(copy).toMatch(stable);
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

// The desktop app offers F1-F24 (except KalCode's reserved F5, F7 and F12), Pause, Scroll Lock and
// Insert as the push-to-talk key, and refuses Caps Lock and Fn (crates/kalvoice/src/shortcuts.rs,
// apps/desktop/src/kalvoice/shortcutModel.ts). The key is registered only while KalCode is the
// foreground app (apps/desktop/src-tauri/src/kalvoice_talk_key.rs).
describe.each([
  { name: "KalVoice page", component: KalVoicePage as Component, path: "/kalvoice" },
  { name: "KalVoice docs", component: KalVoiceDocs as Component, path: "/docs/kalvoice" },
])("the push-to-talk key on the $name", ({ component, path }) => {
  it.each([false, true])("offers only the keys the app accepts (Stable %s)", async (stable) => {
    if (stable) selectSignedStable();
    const copy = text(await render(component, path));
    expect(copy).toContain("F8 is the default.");
    expect(copy).toContain("another function key, Pause, Scroll Lock or Insert");
    expect(copy).not.toMatch(/Caps Lock/i);
    expect(copy).not.toMatch(/\bFn\b/);
  });

  it.each([false, true])("says the key works while KalCode is the active window (Stable %s)", async (stable) => {
    if (stable) selectSignedStable();
    const copy = text(await render(component, path));
    expect(copy).toContain("The key works while KalCode is the active window, so other apps keep it otherwise.");
  });
});
