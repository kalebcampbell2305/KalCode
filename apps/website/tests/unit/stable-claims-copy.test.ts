import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseManifest } from "../../src/data/releases";
import { publishedManifest } from "./fixtures/releases";

const fixture = vi.hoisted(() => ({ manifest: {} as ReleaseManifest }));
vi.mock("../../src/lib/releases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/releases")>()),
  RELEASES: fixture.manifest,
}));

import CommandCenterStage from "../../src/components/stage/CommandCenterStage.astro";
import DemoCenter from "../../src/components/stage/DemoCenter.astro";
import KalVoiceStage from "../../src/components/stage/KalVoiceStage.astro";
import BrowserPreview from "../../src/components/stage/parts/BrowserPreview.astro";
import PermissionsPanel from "../../src/components/stage/parts/PermissionsPanel.astro";
import Rail from "../../src/components/stage/parts/Rail.astro";
import ScrollStory from "../../src/components/stage/ScrollStory.astro";
import TryKalCode from "../../src/components/stage/TryKalCode.astro";
import { DEMO_TABS, MODES, STORY, THREADS } from "../../src/data/story";
import { PAGES, planSummary } from "../../src/lib/site";
import KalVoiceDocs from "../../src/pages/docs/kalvoice.astro";
import LocalFirstDocs from "../../src/pages/docs/local-first.astro";
import PermissionsDocs from "../../src/pages/docs/permissions.astro";
import ProvidersDocs from "../../src/pages/docs/providers.astro";
import Home from "../../src/pages/index.astro";
import KalVoicePage from "../../src/pages/kalvoice.astro";
import Pricing from "../../src/pages/pricing.astro";
import Privacy from "../../src/pages/privacy.astro";
import Product from "../../src/pages/product.astro";
import Security from "../../src/pages/security.astro";
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
  // The Dashboard is Available on Stable (B9 536efd7 crates/native-core/src/flags.rs:113) and live:
  // Dashboard.tsx reads useEvents and useThreadSummaries (data/DashboardData.tsx).
  /live (thread )?data in development/i,
  /Design built/i,
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

// Post-0.1.5 KalVoice and thread work (primary ruling on target/TERMINAL-KALVOICE-GAP.md): naming
// raw terminals, passing context from one agent to another, rewriting prompts, fuzzy nicknames or
// aliases, and the Session Locator (Gated on Stable) are not in 0.1.5.
const NOT_IN_015 = [
  /Session Locator/i,
  /\bnam(e|es|ing) (your |a |the )?terminals?\b/i,
  /\bterminals? by name\b/i,
  /\b(pass|passes|passing|send|sends|sending|share|shares|sharing|hand|hands) (the )?context\b/i,
  /\bcontext (from one|between|to another)\b/i,
  /Context Drop/i,
  /\b(rewrite|rewrites|rewriting|rephrase|rephrases|rephrasing|polish|polishes|polishing) (your |the )?prompts?\b/i,
  /\b(aliases|nicknames?)\b/i,
  // Gated on Stable 0.1.5 (a8c4855 crates/native-core/src/flags.rs) and not switched on for it:
  // the Utility Dock, Environment Doctor, the Resource Governor view, workspace Home and its
  // widgets, and Git worktree views. Git and diff views may appear only as Planned.
  /Utility Dock/i,
  /Environment Doctor/i,
  /Resource Governor/i,
  /Workspace Home/i,
  /\bwidgets?\b/i,
  /\bworktrees?\b/i,
  /Git and diff views (?!Planned)/i,
];

// B5 zero-setup: the default English speech model downloads by itself after install, so no page may
// still say it waits for consent or a setup step.
const STALE_SPEECH_CONSENT = [
  /downloaded only (after|if|with) (you agree|your consent)/i,
  /only with your consent/i,
  /Nothing is downloaded automatically/i,
  /when you set up KalVoice/i,
  /guided setup/i,
];

const B5_PAGES_UNDER_TEST = [
  ...PAGES_UNDER_TEST,
  { name: "security page", component: Security as Component, path: "/security" },
  { name: "privacy page", component: Privacy as Component, path: "/privacy" },
];

describe.each(B5_PAGES_UNDER_TEST)("the $name for 0.1.5", ({ component, path }) => {
  it("claims no post-0.1.5 voice or thread feature and no consent-gated speech download", async () => {
    const html = await render(component, path);
    const copy = `${text(html)} ${metaDescription(html)}`;
    for (const pattern of [...NOT_IN_015, ...STALE_SPEECH_CONSENT]) expect(copy).not.toMatch(pattern);
  });
});

// B5 voice-to-thread phrases, checked against crates/kalvoice/src/grammar_sessions.rs (lane B1) and
// apps/desktop/src-tauri/src/{kalvoice_executor,session_resolver}.rs on staging/b5.
describe("KalVoice voice-to-thread docs", () => {
  it("lists only phrases the 0.1.5 grammar understands", async () => {
    const docs = text(await render(KalVoiceDocs, "/docs/kalvoice"));
    for (const phrase of [
      "“Send that” sends what is in the focused thread's message box.",
      "“Clear that” removes only the text KalVoice typed there since the last send or clear, and never text you typed yourself; if KalVoice can't tell which text it typed, it changes nothing and says so.",
      "neither counts as a KalVoice Request.",
      "“Tell Authentication to run the tests” or “Ask Research why the build failed” opens that thread",
      "“Research on Codex B”",
      "“Which one — Release Windows or Release Mac?”",
      "“What needs permission?”, “Open the one that failed” and “Go back”",
      "“Tell it to continue”",
      "KalVoice never sends to a thread that is waiting for your permission and never resumes a stopped thread to send to it.",
      "In a terminal, KalVoice types your words but never presses Enter or runs a command.",
    ]) {
      expect(docs).toContain(phrase);
    }
    // B5 fix/voice-clear-scope (582ab5b, voiceDirectives.ts clearComposer): "clear that" never
    // empties the whole message box.
    expect(docs).not.toMatch(/Clear that[^.]*\bempties\b/i);
  });

  it("describes the automatic speech model and local intelligence preparation", async () => {
    const docs = text(await render(KalVoiceDocs, "/docs/kalvoice"));
    expect(docs).toContain("KalCode gets its default English speech model by itself the first time you open it");
    expect(docs).toContain("verifies its signature and SHA-256 checksum before using it");
    expect(docs).toContain("If you remove the model, KalCode doesn't download it again on its own.");
    expect(docs).toContain("Once the speech model is ready, KalCode prepares that on-device runtime by itself");
    expect(docs).toContain("Prepare local intelligence automatically");
    expect(text(await render(Security, "/security"))).toContain(
      "KalCode downloads its default speech model by itself from its signed component catalog",
    );
  });

  it("discloses the automatic interpreter download wherever the speech download is described", async () => {
    const disclosure =
      "Once speech is ready, KalCode also downloads its on-device interpreter (about 850 MB) from the same signed catalog. Turn off Prepare local intelligence automatically in Settings › KalVoice to download it yourself instead. These downloads send no audio or text.";
    for (const [component, path] of [
      [Privacy, "/privacy"],
      [Security, "/security"],
      [LocalFirstDocs, "/docs/local-first"],
    ] as const) {
      expect(text(await render(component as Component, path)), path).toContain(disclosure);
    }
  });

  it("names what KalCode itself contacts kalcoded.com for", async () => {
    const copy = text(await render(LocalFirstDocs, "/docs/local-first"));
    expect(copy).toContain(
      "KalCode contacts kalcoded.com only for its signed update feed, at launch and about every six hours while it is open, and to download KalVoice's signed components when they are needed. None of these requests carry telemetry, audio or text.",
    );
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

// B9 536efd7 enforces no per-plan thread limit: limits::CONCURRENT_THREADS is read only inside
// crates/entitlements (document.rs and its tests); the only limit the app consumes is
// KALVOICE_REQUESTS_PER_MONTH (apps/desktop/src-tauri/src/kalvoice_accounting.rs:49,
// crates/entitlements/src/usage.rs:104). Admission is capped by the Resource Governor, which starts
// in Balanced (crates/resources/src/mode.rs:28, max_agents 4 at :277) for every plan, and its view
// is Gated on Stable (crates/native-core/src/flags.rs:70). So no page may promise a thread count
// by plan.
const PLAN_CONCURRENCY_CLAIMS = [
  /threads running at once/i,
  /\bthreads at once\b/i,
  /\b(concurrent|simultaneous|parallel) threads\b/i,
  /Plans differ in KalVoice Requests and threads/i,
];

describe("plans", () => {
  it("compare only what the plans differ in today", async () => {
    const html = await render(Pricing, "/pricing");
    const copy = text(html);
    expect(copy).toContain(
      "Every plan runs every provider in Plan, Approve and Auto modes. Plans differ in KalVoice Requests — your AI usage stays on your own account.",
    );
    const rowHeads = [...html.matchAll(/<th scope="row"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1].trim());
    expect(rowHeads).toEqual(["KalVoice Requests a month"]);
    expect(PAGES.find((p) => p.path === "/pricing")?.description).toContain(
      "plans differ in KalVoice Requests. AI usage stays on your own provider account.",
    );
  });

  it.each([
    { name: "home page", component: Home as Component, path: "/" },
    { name: "pricing page", component: Pricing as Component, path: "/pricing" },
  ])("the $name promises no thread count by plan", async ({ component, path }) => {
    const html = await render(component, path);
    const copy = `${text(html)} ${metaDescription(html)}`;
    for (const pattern of PLAN_CONCURRENCY_CLAIMS) expect(copy).not.toMatch(pattern);
  });

  it("give each home plan card only what Stable enforces", async () => {
    const html = await render(Home, "/");
    const cards = [...html.matchAll(/<ul class="plan-card__points"[^>]*>([\s\S]*?)<\/ul>/g)].map((m) => text(m[1]));
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(card).toMatch(/KalVoice Requests a month/);
      expect(card).toContain("Every provider; Plan, Approve and Auto modes");
      expect(card).not.toMatch(/\bthreads?\b/i);
    }
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

  it("lists the live Dashboard as built on the product page", async () => {
    const html = await render(Product, "/product");
    const copy = text(html);
    expect(copy).toContain("Dashboard Built Live thread status from runtime events, with approvals inline");
    expect(copy).toContain("Built Every thread, one Dashboard.");
    expect(html).toMatch(/<p class="chip chip--built"[^>]*>Built<\/p>\s*<h2 id="threads-title"/);
  });

  it("keeps the product demos from calling provider panes shipped", async () => {
    const copy = text(await render(DemoCenter as Component, "/product"));
    expect(copy).not.toMatch(/side by side/i);
  });
});

// Stable 0.1.5 ships the app shell, palette, terminals, Dashboard and the local-first and security
// controls these pages describe, so none may frame them as a development build or pre-release only.
const DEV_BUILD_FRAMING = [
  /current development builds?/i,
  /In the development build/i,
  /Built · development build/i,
  /ahead of the public preview/i,
  /planned before release/i,
  /in private development/i,
];

describe("Stable features are not framed as a development build", () => {
  it.each([
    { name: "product page", component: Product as Component, path: "/product" },
    { name: "security page", component: Security as Component, path: "/security" },
    { name: "local-first docs", component: LocalFirstDocs as Component, path: "/docs/local-first" },
  ])("the $name", async ({ component, path }) => {
    const html = await render(component, path);
    const copy = `${text(html)} ${metaDescription(html)}`;
    for (const pattern of DEV_BUILD_FRAMING) expect(copy).not.toMatch(pattern);
  });

  it("states the current-build claims plainly", async () => {
    const product = text(await render(Product, "/product"));
    expect(product).toContain("App shell, search and palette, light and dark themes Built In the app today");
    expect(product).toContain("Built Real terminals in a real workspace.");
    expect(product).toContain("Updated with every milestone. Built means in the app you can download today.");
    const security = text(await render(Security, "/security"));
    expect(security).toContain("This page lists the controls in current builds and the ones still planned.");
    expect(security).toContain("Current builds send no user data off the device.");
    expect(text(await render(LocalFirstDocs, "/docs/local-first"))).toContain(
      "Current builds send no telemetry and no user data off your device.",
    );
  });
});

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
    size: 14_048_116,
    sha256: "d".repeat(64),
    signed: true,
  });
  fixture.manifest.unavailable = fixture.manifest.unavailable.filter((entry) => entry.os !== "macos");
}

/** The items under the security page's "Planned" heading. */
function plannedItems(html: string) {
  const list = html.match(/<h2[^>]*>Planned<\/h2>\s*<ul[^>]*>([\s\S]*?)<\/ul>/)?.[1];
  if (list === undefined) throw new Error("no Planned list on /security");
  return [...list.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]).trim());
}

// B9 536efd7 ships workspace containment (crates/permissions/src/paths.rs), sanitized provider
// environments (crates/providers/src/env.rs) and the permission engine with its audit trail
// (crates/permissions/src/service.rs). The certified 0.1.5 artifacts are an Authenticode-signed
// Windows installer, a Developer ID signed and notarized Mac app, and minisign update signatures.
describe("security controls that shipped are not listed as planned", () => {
  const SHIPPED = [
    /Workspace containment: path canonicalization/i,
    /Provider isolation with sanitized environments/i,
    /The permission engine with an audit log/i,
  ];

  it("states the shipped controls in the present tense in every release state", async () => {
    const html = await render(Security, "/security");
    const copy = text(html);
    expect(copy).toContain(
      "Workspace containment A path counts as inside your workspace only when it still lands inside the workspace folder after",
    );
    expect(copy).toContain("symlinks and junctions are resolved. Paths KalCode cannot resolve safely");
    expect(copy).toContain("Provider isolation Each provider's CLI starts with a sanitized environment");
    expect(copy).toContain(
      "KalCode's permission engine checks every action an AI agent wants to take against the permission mode you choose: Plan, Approve or Auto.",
    );
    expect(copy).toContain("Consequential decisions are recorded in an audit log.");
    const planned = plannedItems(html);
    for (const pattern of SHIPPED) expect(planned.join(" ")).not.toMatch(pattern);
    expect(planned).toContain(
      "Server-side plan and usage checks, and verified billing webhooks, when paid plans launch.",
    );
  });

  it("claims signed installers and updates only while a signed Stable release is served", async () => {
    const preview = await render(Security, "/security");
    expect(text(preview)).not.toContain("Signed installers and updates");
    expect(plannedItems(preview)).toContain("Code-signed installers and signed updates.");

    selectSignedStable();
    const stable = await render(Security, "/security");
    const copy = text(stable);
    expect(copy).toContain(
      "Signed installers and updates The Windows installer is Authenticode-signed, and the Mac app is signed with an Apple Developer ID and notarized by Apple.",
    );
    expect(copy).toContain(
      "before installing one, KalCode checks its SHA-256 checksum and its update signature, and on Windows the installer's Authenticode signature too.",
    );
    expect(plannedItems(stable)).toEqual([
      "Server-side plan and usage checks, and verified billing webhooks, when paid plans launch.",
    ]);
    for (const pattern of DEV_BUILD_FRAMING) expect(`${copy} ${metaDescription(stable)}`).not.toMatch(pattern);
  });
});

// The product stages draw Stable-shipped features: terminals, the Dashboard, approvals, KalVoice
// dictation and commands, and the Providers surface (B9 536efd7 crates/native-core/src/flags.rs:113-125:
// Dashboard, KalVoice, Code, Threads, Providers and Settings Available). Once Stable is served no
// stage may tag them as a development build or in development, or show a stale build number.
const STAGE_UNDERSTATEMENTS = [
  /Development build/i,
  /Preview · in development/i,
  /\b0\.1\.0\b/,
  /KPIs are sample data/i,
  /In development Agents/i,
];
// Inside a stage nothing Stable ships is "in development". (Whole pages keep the footer's true
// "More in development.", so this stricter rule applies to the stage components only.)
const STAGE_ONLY = [/\bIn development\b/i];

/** The rail as the story and demos draw it: nav, then the dimmed group, then the build line. */
async function renderRail() {
  return text(
    await render(Rail as Component, "/", {
      threads: THREADS,
      approval: "none",
      interactive: false,
      focus: "claude-checkout",
      view: "code",
      present: [],
    }),
  );
}

describe("product stages once Stable is served", () => {
  const STAGES = [
    { name: "scroll story", component: ScrollStory as Component, path: "/product", stage: true },
    { name: "demo center", component: DemoCenter as Component, path: "/product", stage: true },
    { name: "home Dashboard stage", component: CommandCenterStage as Component, path: "/", stage: true },
    { name: "try-it window", component: TryKalCode as Component, path: "/", stage: true },
    { name: "product page", component: Product as Component, path: "/product", stage: false },
    { name: "home page", component: Home as Component, path: "/", stage: false },
    { name: "KalVoice page", component: KalVoicePage as Component, path: "/kalvoice", stage: false },
  ];

  it.each(STAGES)("the $name calls no Stable feature in development", async ({ component, path, stage }) => {
    selectSignedStable();
    const copy = text(await render(component, path));
    for (const pattern of [...STAGE_UNDERSTATEMENTS, ...(stage ? STAGE_ONLY : [])]) {
      expect(copy).not.toMatch(pattern);
    }
  });

  it("renders the stages on the Stable /product page", async () => {
    selectSignedStable();
    const copy = text(await render(Product, "/product"));
    expect(copy).toContain("The words land in the focused agent. In Stable 0.1.5");
    expect(copy).toContain("Real terminals in your workspace.");
  });

  it("tags the Stable-shipped steps and demos with the served release", async () => {
    selectSignedStable();
    const story = text(await render(ScrollStory as Component, "/product"));
    expect(story).toContain("Real terminals start inside it. In Stable 0.1.5");
    expect(story).toContain(
      "Status comes from runtime events, not from what a model says. In Stable 0.1.5 · sample data",
    );
    expect(story).toContain("Nothing leaves your rules without asking. In Stable 0.1.5 · sample data");
    expect(story).toContain("The words land in the focused agent. In Stable 0.1.5");
    // Voice-created threads need ProviderPanes, which Stable gates (kalvoice_executor.rs).
    expect(story).toContain("Preview · creating agents by voice is not in Stable yet");
    expect(story).toContain("Preview · provider panes not in Stable yet");
    const demos = text(await render(DemoCenter as Component, "/product"));
    expect(demos.match(/In Stable 0\.1\.5/g)?.length).toBe(4);
    expect(demos).toContain("Preview · missions and provider panes are not in Stable yet");
    expect(text(await render(CommandCenterStage as Component, "/"))).toContain(
      "Dashboard in Stable 0.1.5 · the KPI tiles are illustrative",
    );
  });

  it("draws the rail with Stable's surfaces and the served build", async () => {
    selectSignedStable();
    const rail = await renderRail();
    expect(rail).toMatch(/KalVoice Providers Not in Stable yet Agents Missions Automations Stable 0\.1\.5/);
    expect(rail).not.toMatch(/In development/i);
  });

  it("keeps the preview-era tags while the preview is served", async () => {
    for (const item of [...STORY, ...DEMO_TABS])
      expect(item.stableTag ?? "").not.toMatch(/in development|Development build/i);
    const story = text(await render(ScrollStory as Component, "/product"));
    expect(story).toContain("The words land in the focused agent. Preview · in development");
    expect(story).not.toContain("In Stable");
    expect(await renderRail()).toMatch(/KalVoice In development Agents Missions Automations Providers Preview 0\.1\.0/);
  });
});

/** Each rendered stage slot's own markup (div-balanced), prefixed by its name in quotes. */
function stageSlots(html: string): string[] {
  const slots: string[] = [];
  for (const start of html.matchAll(/<div class="stage-slot"[^>]*data-stage-slot=/g)) {
    const from = start.index ?? 0;
    let depth = 0;
    for (const tag of html.slice(from).matchAll(/<(\/?)div\b[^>]*>/g)) {
      depth += tag[1] ? -1 : 1;
      if (depth === 0) {
        slots.push(html.slice(from + start[0].length, from + (tag.index ?? 0)));
        break;
      }
    }
  }
  return slots;
}

// 0.1.5 is variant A: Gemini CLI is unavailable (site.ts GEMINI_AVAILABILITY). A stage that names
// the Stable release must not draw a Gemini CLI thread at work; a stage that keeps Gemini CLI must
// say it is unavailable.
describe("Gemini CLI in stages once Stable is served", () => {
  const GEMINI_AT_WORK = [/Gemini CLI/, /gemini-2\.5-pro/, /✦/, /GEMINI\.md/];

  it.each([
    { name: "scroll story", component: ScrollStory as Component, path: "/product" },
    { name: "demo center", component: DemoCenter as Component, path: "/product" },
    { name: "home Dashboard stage", component: CommandCenterStage as Component, path: "/" },
  ])("the Stable-labelled $name draws no Gemini CLI thread", async ({ component, path }) => {
    selectSignedStable();
    const copy = text(await render(component, path));
    expect(copy).toMatch(/In Stable 0\.1\.5|Dashboard in Stable 0\.1\.5/);
    for (const pattern of GEMINI_AT_WORK) expect(copy).not.toMatch(pattern);
    // The research thread is still drawn, as a Codex thread.
    expect(copy).toContain("Research rate-limit options");
  });

  it("draws the research thread as Codex on the Stable Dashboard stage", async () => {
    selectSignedStable();
    const html = await render(CommandCenterStage as Component, "/");
    expect(html).toMatch(/data-agent="gemini-research" data-provider="codex"/);
    expect(html).not.toMatch(/data-provider="gemini"/);
    expect(text(html)).toContain("• A sliding window in Redis fits best.");
  });

  it("describes the Stable story Dashboard step without Gemini CLI", async () => {
    selectSignedStable();
    const html = await render(ScrollStory as Component, "/product");
    for (const describe of html.matchAll(/data-kc-describe="([^"]*)"/g)) expect(describe[1]).not.toMatch(/Gemini/);
    expect(html).toContain("Codex reviewing and researching");
  });

  it("marks Gemini CLI unavailable wherever a Stable page still draws it", async () => {
    selectSignedStable();
    expect(text(await render(TryKalCode as Component, "/"))).toContain(
      "provider panes not in Stable yet · Gemini CLI unavailable in 0.1.5",
    );
  });

  it.each([
    { name: "home page", component: Home as Component, path: "/" },
    { name: "product page", component: Product as Component, path: "/product" },
    { name: "KalVoice page", component: KalVoicePage as Component, path: "/kalvoice" },
  ])(
    "every stage on the Stable $name either draws no Gemini CLI or says it is unavailable",
    async ({ component, path }) => {
      selectSignedStable();
      const html = await render(component, path);
      const slots = stageSlots(html);
      expect(slots.length).toBeGreaterThan(0);
      for (const slot of slots) {
        const name = slot.match(/^"([^"]+)"/)?.[1];
        const copy = text(slot);
        if (/In Stable \d|Dashboard in Stable \d/.test(copy)) expect(copy, name).not.toMatch(/Gemini CLI/);
        if (/Gemini CLI/.test(copy)) expect(copy, name).toMatch(/Gemini CLI unavailable in (KalCode )?0\.1\.5/);
      }
    },
  );

  it("keeps the Gemini CLI research thread in the preview", async () => {
    const story = text(await render(ScrollStory as Component, "/product"));
    expect(story).toContain("Gemini CLI");
    const cc = await render(CommandCenterStage as Component, "/");
    expect(cc).toMatch(/data-agent="gemini-research" data-provider="gemini"/);
    expect(text(await render(TryKalCode as Component, "/"))).not.toContain("Gemini CLI unavailable in");
  });
});

// signedStableRelease requires signed Windows x64 AND macOS arm64 builds; a Windows-only Stable
// must not claim a notarized Mac app.
describe("signed-build claims on a Windows-only Stable", () => {
  it("keeps signed installers planned on /security", async () => {
    const latest = fixture.manifest.latest;
    if (!latest?.platforms[0]) throw new Error("fixture has no Windows release");
    latest.version = "0.1.5";
    latest.channel = "stable";
    latest.platforms[0].signed = true;
    const html = await render(Security, "/security");
    const copy = text(html);
    expect(copy).not.toContain("Signed installers and updates");
    expect(copy).not.toMatch(/notarized/i);
    expect(plannedItems(html)).toContain("Code-signed installers and signed updates.");
  });
});

describe("home meta description", () => {
  it("describes KalCode as released, not in private development", async () => {
    const home = PAGES.find((p) => p.path === "/")?.description ?? "";
    expect(home).toBe(
      "KalCode is a desktop workspace for the coding agents you already use. Connect Claude Code and Codex, run their threads at the same time, approve every action, and speak your prompts with KalVoice.",
    );
    expect(home).not.toMatch(/private development/i);
    selectSignedStable();
    expect(metaDescription(await render(Home, "/"))).toBe(home);
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

// Stable 0.1.5 threads start only in Plan, Approve or Auto (B9 536efd7:
// crates/threads/src/runtime.rs ThreadOptions.permission_modes; apps/desktop/src/surfaces/permissions
// START_MODES, the only modes Stable's Settings offers). Bypass and Custom are not available in
// 0.1.5, so no page may present every mode as available or leave either unmarked.
const EVERY_MODE_CLAIMS = [
  /every mode is available/i,
  /every mode (is )?on every plan/i,
  /a mode for every thread/i,
  /all permission modes/i,
  // The 0.1.1 note "deny rules in every permission mode" is a true statement about deny rules.
  /(includes|with) every permission mode/i,
  /every provider and permission mode/i,
  /includes all of them/i,
  /Plan, Approve, Auto, Bypass/i,
  /Bypass activation/i,
];

describe("permission modes in 0.1.5", () => {
  it.each([
    ...PAGES_UNDER_TEST,
    { name: "permissions docs", component: PermissionsDocs as Component, path: "/docs/permissions" },
    { name: "security page", component: Security as Component, path: "/security" },
  ])("the $name never presents Bypass or Custom as available", async ({ component, path }) => {
    const html = await render(component, path);
    const copy = `${text(html)} ${metaDescription(html)}`;
    for (const pattern of EVERY_MODE_CLAIMS) expect(copy).not.toMatch(pattern);
  });

  it("says in the permissions docs which modes 0.1.5 threads start in and marks the rest Planned", async () => {
    const copy = text(await render(PermissionsDocs, "/docs/permissions"));
    expect(copy).toContain("In KalCode 0.1.5, threads start in Plan, Approve or Auto, on every plan.");
    expect(copy).toContain("Bypass and Custom are planned and not available in 0.1.5.");
    expect(copy).toContain("Bypass Planned");
    expect(copy).toContain("Custom Planned");
    expect(copy).not.toMatch(/Plan Planned|Approve Planned|Auto Planned/);
  });

  it("marks Bypass and Custom Planned on the product page", async () => {
    const copy = text(await render(Product, "/product"));
    expect(copy).toContain("Threads run in Plan, Approve or Auto on every plan. Bypass and Custom are planned.");
    expect(copy).toContain("Bypass Planned");
    expect(copy).toContain("Custom Planned");
  });

  it("names only the startable modes where the plans list what every plan includes", async () => {
    for (const [component, path] of [
      [Home, "/"],
      [Pricing, "/pricing"],
    ] as const) {
      expect(text(await render(component, path))).toContain("Plan, Approve and Auto");
    }
    const pricing = text(await render(Pricing, "/pricing"));
    expect(pricing).toContain(
      "In 0.1.5, threads run in Plan, Approve or Auto on every plan; Bypass and Custom are planned.",
    );
  });

  it("marks Bypass and Custom Planned in the permission-modes preview", async () => {
    expect(MODES.filter((mode) => mode.planned).map((mode) => mode.id)).toEqual(["bypass", "custom"]);
    const panel = text(
      await render(PermissionsPanel as Component, "/", {
        uid: "pm",
        mode: "approve",
        approval: "none",
        interactive: true,
        variant: "full",
      }),
    );
    expect(panel).toContain("Bypass Planned");
    expect(panel).toContain("Custom Planned");
  });
});

describe("native code safety claim", () => {
  // B9 536efd7 Cargo.toml [workspace.lints.rust] unsafe_code = "deny" (not "forbid"), with
  // #[allow(unsafe_code)] on OS-integration modules and functions (Win32, macOS and libc calls).
  // third_party/portable-pty (vendored, patched per KALCODE_PATCH.md) is outside the workspace lint.
  it("does not say unsafe Rust is forbidden", async () => {
    const copy = text(await render(Security, "/security"));
    expect(copy).not.toMatch(/unsafe Rust is forbidden/i);
    expect(copy).toContain("Unsafe Rust is denied by default across KalCode's workspace crates.");
    expect(copy).toContain(
      "The vendored terminal library (portable-pty, which KalCode patches for Windows job objects and macOS terminal handling) sits outside that lint.",
    );
    expect(copy).not.toMatch(/KalCode's own native code/);
  });
});
