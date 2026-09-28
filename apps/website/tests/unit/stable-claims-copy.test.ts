import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseManifest } from "../../src/data/releases";
import { publishedManifest } from "./fixtures/releases";

const fixture = vi.hoisted(() => ({ manifest: {} as ReleaseManifest }));
vi.mock("../../src/lib/releases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/releases")>()),
  RELEASES: fixture.manifest,
}));

import DemoCenter from "../../src/components/stage/DemoCenter.astro";
import KalVoiceStage from "../../src/components/stage/KalVoiceStage.astro";
import BrowserPreview from "../../src/components/stage/parts/BrowserPreview.astro";
import TryKalCode from "../../src/components/stage/TryKalCode.astro";
import { PAGES, planSummary } from "../../src/lib/site";
import KalVoiceDocs from "../../src/pages/docs/kalvoice.astro";
import LocalFirstDocs from "../../src/pages/docs/local-first.astro";
import ProvidersDocs from "../../src/pages/docs/providers.astro";
import Home from "../../src/pages/index.astro";
import KalVoicePage from "../../src/pages/kalvoice.astro";
import Pricing from "../../src/pages/pricing.astro";
import Product from "../../src/pages/product.astro";
import Updates from "../../src/pages/updates.astro";

beforeEach(() => Object.assign(fixture.manifest, structuredClone(publishedManifest)));

type Component = Parameters<AstroContainer["renderToString"]>[0];

async function render(component: Component, path: string, props: Record<string, unknown> = {}) {
  const container = await AstroContainer.create();
  return container.renderToString(component, { props, request: new Request(`https://kalcoded.com${path}`) });
}

function decode(value: string) {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** Visible text only, so attribute values and markup never satisfy a copy assertion. */
function text(html: string) {
  return decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
}

function metaDescription(html: string) {
  const match = html.match(/<meta name="description" content="([^"]*)"/);
  return match ? decode(match[1]) : "";
}

// Stable 0.1.5 (B4 8d6c133, crates/native-core/src/flags.rs) gates every FeatureId except
// PaneSystem and hides the Agents, Missions, Automations and Command Center surfaces. KalVoice's
// CreateThreads / CreateProviderPanes intents need ProviderPanes and are refused on Stable
// (apps/desktop/src-tauri/src/kalvoice_executor.rs:218-223). None of these may read as shipped.
const GATED_CLAIMS = [
  /Open four Codex (threads|terminals)/i,
  /Have Claude implement this, Codex review it/i,
  /Persistent agents/i,
  /Pair and team workflows/i,
  /team workflows/i,
  /Advanced missions with verification/i,
  /Scheduled \+ event/i,
  /hand whole objectives/i,
  /Plans differ in KalVoice Requests and workspace features/i,
  // Provider panes are allowed only as "not in Stable yet".
  /provider panes(?! (are )?not in Stable)/i,
  /side by side/i,
  /\bCommand center\b/,
];

// Shipped on Stable but previously called planned or in development: the Codex and Gemini CLI
// adapters, split panes and the Browser pane (PaneSystem is Available), the permission engine
// and Approvals panel, and KalVoice commands.
const UNDERSTATEMENTS = [
  /Split panes are planned/i,
  /Terminals are tabs today/i,
  /Split panes, file tree, Git and diff views, browser preview/i,
  /browser is planned/i,
  /This surface is planned/i,
  /Engine and approval card in development/i,
  /KalVoice commands and multi-agent runs are in development/i,
];

const PAGES_UNDER_TEST = [
  { name: "home page", component: Home as Component, path: "/" },
  { name: "product page", component: Product as Component, path: "/product" },
  { name: "pricing page", component: Pricing as Component, path: "/pricing" },
  { name: "KalVoice page", component: KalVoicePage as Component, path: "/kalvoice" },
  { name: "KalVoice docs", component: KalVoiceDocs as Component, path: "/docs/kalvoice" },
  { name: "provider docs", component: ProvidersDocs as Component, path: "/docs/providers" },
  { name: "local-first docs", component: LocalFirstDocs as Component, path: "/docs/local-first" },
  { name: "updates page", component: Updates as Component, path: "/updates" },
];

describe.each(PAGES_UNDER_TEST)("the $name", ({ component, path }) => {
  it("claims no Gated feature as shipped and calls no shipped feature planned", async () => {
    const html = await render(component, path);
    const copy = `${text(html)} ${metaDescription(html)}`;
    for (const pattern of [...GATED_CLAIMS, ...UNDERSTATEMENTS]) expect(copy).not.toMatch(pattern);
  });
});

describe("KalVoice command examples", () => {
  it("use commands that run on Stable", async () => {
    expect(text(await render(KalVoicePage, "/kalvoice"))).toContain("“Pause every active thread.”");
    const docs = text(await render(KalVoiceDocs, "/docs/kalvoice"));
    for (const example of [
      "“Go to the dashboard.”",
      "“Pause every active thread.”",
      "“What needs permission?”",
      "“What are my threads doing?”",
    ]) {
      expect(docs).toContain(example);
    }
    expect(docs).toContain("A command, such as “Pause every active thread”");
    expect(docs).toContain(
      "“Open a terminal” is one request. “Pause every active thread” is also one request, however many threads it pauses.",
    );
  });

  it("count requests with Stable examples in the pricing FAQ", async () => {
    expect(text(await render(Pricing, "/pricing"))).toContain(
      "“Open a terminal” is one request. “Pause every active thread” is also one request, however many threads it pauses.",
    );
  });
});

describe("plans", () => {
  it("compare only what the plans differ in today", async () => {
    const html = await render(Pricing, "/pricing");
    const copy = text(html);
    expect(copy).toContain("Plans differ in KalVoice Requests and threads running at once");
    const rowHeads = [...html.matchAll(/<th scope="row"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1].trim());
    expect(rowHeads).toEqual(["KalVoice Requests a month", "Threads running at once"]);
  });

  it("render a website summary for MAX instead of the catalog's objectives claim", async () => {
    expect(planSummary({ id: "max", summary: "For people who hand whole objectives to KalCode." })).toBe(
      "For heavy daily KalVoice use across many projects.",
    );
    expect(planSummary({ id: "pro", summary: "Catalog text" })).toBe("Catalog text");
    for (const [component, path] of [
      [Home, "/"],
      [Pricing, "/pricing"],
    ] as const) {
      expect(text(await render(component as Component, path))).toContain(
        "For heavy daily KalVoice use across many projects.",
      );
    }
  });
});

describe("home page", () => {
  it("describes the workspace as it ships", async () => {
    const copy = text(await render(Home, "/"));
    expect(copy).toContain("Real terminals, a browser pane and your agents' threads, in one workspace.");
    expect(copy).toMatch(/Dashboard Every thread\. One dashboard\./);
  });

  it("says in the home meta that threads run at the same time, without a panes claim", () => {
    const home = PAGES.find((p) => p.path === "/")?.description ?? "";
    expect(home).toContain("run their threads at the same time");
    expect(PAGES.find((p) => p.path === "/product")?.description).not.toMatch(/provider panes/i);
  });

  it("marks the try-it demo's provider panes as not in Stable", async () => {
    expect(text(await render(TryKalCode as Component, "/"))).toContain("provider panes not in Stable yet");
  });
});

describe("shipped features are not called planned", () => {
  it("lists split panes and the Browser pane as built on the product page", async () => {
    const copy = text(await render(Product, "/product"));
    expect(copy).toContain("Split panes and the Browser pane Built");
    expect(copy).toContain("Approvals and permission modes Built");
    expect(copy).toContain("File tree, Git and diff views Planned");
    expect(copy).toContain("Terminals, the browser and threads open in panes you can split and resize.");
  });

  it("labels the Browser preview and KalVoice stage honestly", async () => {
    const browser = text(await render(BrowserPreview as Component, "/", { interactive: true }));
    expect(browser).not.toMatch(/Planned/);
    const wide = text(await render(KalVoiceStage as Component, "/", { width: "wide" }));
    expect(wide).toContain("KalVoice commands are in Stable · multi-agent runs are not yet");
    const compact = text(await render(KalVoiceStage as Component, "/", { width: "compact" }));
    expect(compact).toContain("Multi-agent runs not in Stable yet");
  });

  it("keeps the product demos from calling provider panes shipped", async () => {
    const copy = text(await render(DemoCenter as Component, "/product"));
    expect(copy).not.toMatch(/side by side/i);
  });
});

describe("credential storage caveats", () => {
  it("says Claude Code and Codex sign-ins can be ordinary files", async () => {
    const copy = text(await render(LocalFirstDocs, "/docs/local-first"));
    expect(copy).toContain(
      "Claude Code and Codex keep their sign-in in their own storage inside that profile, which can be an ordinary, unencrypted file (for example Codex's auth.json).",
    );
  });
});
