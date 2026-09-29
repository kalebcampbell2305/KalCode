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
import PermissionsPanel from "../../src/components/stage/parts/PermissionsPanel.astro";
import TryKalCode from "../../src/components/stage/TryKalCode.astro";
import { MODES } from "../../src/data/story";
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
