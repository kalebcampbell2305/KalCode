import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseManifest } from "../../src/data/releases";
import { publishedManifest } from "./fixtures/releases";

const fixture = vi.hoisted(() => ({ manifest: {} as ReleaseManifest }));
vi.mock("../../src/lib/releases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/releases")>()),
  RELEASES: fixture.manifest,
}));

import ProviderSwitch from "../../src/components/stage/ProviderSwitch.astro";
import { structuredData } from "../../src/lib/seo";
import { ACCOUNT_PAGE, KALVOICE, PAGES, PROVIDER_LINE, PROVIDERS } from "../../src/lib/site";
import Account from "../../src/pages/account.astro";
import DocsIndex from "../../src/pages/docs/index.astro";
import LocalFirstDocs from "../../src/pages/docs/local-first.astro";
import ProvidersDocs from "../../src/pages/docs/providers.astro";
import Download from "../../src/pages/download.astro";
import Home from "../../src/pages/index.astro";
import KalVoicePage from "../../src/pages/kalvoice.astro";
import Pricing from "../../src/pages/pricing.astro";
import Product from "../../src/pages/product.astro";
import Security from "../../src/pages/security.astro";
import Updates from "../../src/pages/updates.astro";

beforeEach(() => Object.assign(fixture.manifest, structuredClone(publishedManifest)));

type Component = Parameters<AstroContainer["renderToString"]>[0];

async function render(component: Component, path: string, props: Record<string, unknown> = {}) {
  const container = await AstroContainer.create();
  return container.renderToString(component, {
    props,
    request: new Request(`https://kalcoded.com${path}`),
  });
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

/** The page's meta description (what search results and link previews show). */
function metaDescription(html: string) {
  const match = html.match(/<meta name="description" content="([^"]*)"/);
  return match ? decode(match[1]) : "";
}

const PAGES_UNDER_TEST: { name: string; component: Component; path: string; credentials?: boolean }[] = [
  { name: "home page", component: Home as Component, path: "/" },
  { name: "product page", component: Product as Component, path: "/product" },
  { name: "provider docs", component: ProvidersDocs as Component, path: "/docs/providers" },
  { name: "local-first docs", component: LocalFirstDocs as Component, path: "/docs/local-first" },
  { name: "security page", component: Security as Component, path: "/security" },
  { name: "docs index", component: DocsIndex as Component, path: "/docs" },
  { name: "account page", component: Account as Component, path: "/account" },
  { name: "KalVoice page", component: KalVoicePage as Component, path: "/kalvoice" },
  // The Updates archive keeps its dated "Foundation" entry ("OS keychain secrets", true of KalCode's
  // own secret store at the time), so only the provider-status list applies there.
  { name: "updates page", component: Updates as Component, path: "/updates", credentials: false },
];

// KalCode account sign-in is Google, Microsoft or a one-time email link (B4 8d6c133:
// apps/desktop/src/account/SocialAuthButtons.tsx and AccountOnboarding.tsx; account.astro).
describe("KalCode account sign-in", () => {
  it("names Google, Microsoft and the email link, never GitHub", async () => {
    expect(ACCOUNT_PAGE.description).toContain("Sign in with Google, Microsoft or a one-time email link");
    const html = await render(Account, "/account");
    expect(metaDescription(html)).toContain("Sign in with Google, Microsoft or a one-time email link");
    expect(html).not.toMatch(/github/i);
  });
});

// All three adapters are Implemented and every thread runs in the account's managed profile
// (B4: crates/providers/src/catalog.rs, apps/desktop/src-tauri/src/thread_commands.rs). Managed
// launches strip API-key variables and sign-in is account-only, so no API-key path is claimed.
// Provider panes are gated off Stable (crates/native-core/src/flags.rs).
const STALE_PROVIDER_STATUS = [
  /adapters? (is )?planned/i,
  /Detected · adapter planned/,
  /Detected today/i,
  /others planned/i,
  /Codex and Gemini CLI planned/i,
  /\bAPI keys? (you provide|you already have)\b/i,
  /\bor (bring )?an API key\b/i,
  /\bor API key\b/i,
  /Bring your own keys/i,
  /enterprise credentials/i,
  /being built to connect/i,
  // Threads use a KalCode-managed per-account profile, never the CLI's own terminal sign-in, and
  // desktop detection is installation-only (a8c4855: crates/providers/src/registry.rs
  // installation_only_guarded clears every spec's auth probe).
  /signed-in session/i,
  /signed in where the CLI exposes/i,
  /version and status commands/i,
];

// Provider sign-ins live in each provider's own storage for a KalCode-managed per-account profile;
// only KalCode's own secrets (the account session) are in the OS credential store.
const STALE_CREDENTIAL_STORAGE = [
  /\bOS keychain/i,
  /keychain for secrets/i,
  /Secrets in your OS keychain/i,
  /Credentials go to your operating system's keychain/i,
  /Credentials are stored in your operating system's credential store/i,
  /provider credentials stay in your operating system's credential store/i,
  /API keys and other credentials are stored/i,
  /Secret Service on Linux/i,
];

describe.each(PAGES_UNDER_TEST)("the $name", ({ component, path, credentials = true }) => {
  it("carries no stale provider-status or credential-storage claim", async () => {
    const html = await render(component, path);
    const copy = `${text(html)} ${metaDescription(html)}`;
    for (const pattern of [...STALE_PROVIDER_STATUS, ...(credentials ? STALE_CREDENTIAL_STORAGE : [])]) {
      expect(copy).not.toMatch(pattern);
    }
  });
});

describe("provider support status", () => {
  // 0.1.9+1738: all four adapters Implemented (crates/providers/src/catalog.rs), Gemini CLI since
  // 0.1.9+1450 and Cursor since 0.1.9+1502, each a native terminal with native parity (1658), on the
  // user's own accounts (Codex Business, Enterprise and Edu accounts work since 1658).
  it("lists Claude Code, Codex, Cursor and Gemini CLI as native terminals on your own accounts", () => {
    expect(PROVIDERS.map((p) => [p.name, p.access, p.status, p.state])).toEqual([
      ["Claude Code", "Your Claude account", "Native terminal", "built"],
      ["Codex", "Your ChatGPT account, personal or work", "Native terminal", "built"],
      ["Cursor", "Your Cursor account", "Native terminal", "built"],
      ["Gemini CLI", "Your Google account", "Native terminal", "built"],
    ]);
    for (const provider of PROVIDERS)
      expect(`${provider.access} ${provider.runs}`).not.toMatch(/personal plans|unavailable|sanitized/i);
  });

  it("shows every provider as a native terminal on the home page", async () => {
    const copy = text(await render(Home, "/"));
    for (const name of ["Claude Code", "Codex", "Cursor", "Gemini CLI"])
      expect(copy).toContain(`${name} Native terminal`);
    expect(copy).toContain(PROVIDER_LINE);
    expect(copy).not.toMatch(/Gemini CLI (is )?unavailable|Unavailable in 0\.1/i);
  });

  it("describes how each provider runs on the product page", async () => {
    const copy = text(await render(Product, "/product"));
    for (const provider of PROVIDERS) {
      expect(copy).toContain(`${provider.name} ${provider.status} ${provider.runs} ${provider.access}`);
    }
    expect(copy).toContain("Agents see your real environment");
    expect(copy).not.toMatch(/sanitized environment|Headless (stream|JSON) mode|Gemini CLI (is )?unavailable/i);
  });

  it("never implies provider panes are in the Stable app", async () => {
    const contained = text(await render(ProviderSwitch as Component, "/", { width: "contained" }));
    expect(contained).toMatch(/panes not in Stable yet/);
    // The compact switch sits on / under the Gemini notice, so it names itself a preview and
    // never claims all three providers work.
    const compact = text(await render(ProviderSwitch as Component, "/", { width: "compact" }));
    expect(compact).toContain("Preview · Gemini CLI unavailable in 0.1.6");
    expect(compact).not.toMatch(/All three built/);
    for (const copy of [contained, compact]) expect(copy).not.toMatch(/planned/i);
  });

  // crates/providers/src/catalog.rs: Claude Code, Codex, Gemini CLI and Cursor adapters are all
  // Implemented (Gemini 0.1.9+1450/1658, Cursor 0.1.9+1502).
  it("names the account each provider signs in with in the provider docs", async () => {
    const copy = text(await render(ProvidersDocs, "/docs/providers"));
    expect(copy).toContain("Every coding agent in KalCode is the provider's real CLI, in its own terminal");
    expect(copy).toContain("Claude Code — the local CLI, signed in with your own Claude account.");
    expect(copy).toContain("Codex — the local CLI, signed in with your own ChatGPT account");
    expect(copy).toContain("Cursor — Cursor Agent in an interactive terminal, signed in with your Cursor account");
    expect(copy).toContain(
      "Gemini CLI — the local CLI, signed in with Google's own sign-in, running in your real workspace.",
    );
    expect(copy).not.toMatch(/Gemini CLI is unavailable/);
  });

  // 0.1.9+1658 notes: "Business, Enterprise and Edu accounts are no longer refused."
  it("names the ChatGPT accounts Codex runs on", async () => {
    const copy = text(await render(ProvidersDocs, "/docs/providers"));
    expect(copy).toContain("including Business, Enterprise and Edu accounts");
    expect(copy).not.toMatch(/personal ChatGPT plans|doesn't start Codex threads/);
    const security = text(await render(Security, "/security"));
    expect(security).not.toMatch(/personal ChatGPT plans/);
    const graph = JSON.stringify(structuredData()["@graph"]);
    expect(graph).toContain("Claude Code, and Codex on a personal ChatGPT plan");
    expect(graph).not.toMatch(/Gemini/);
  });

  it("says detection finds installs only and sign-in shows per account", async () => {
    const copy = text(await render(ProvidersDocs, "/docs/providers"));
    expect(copy).toContain("then runs only each CLI's version command, with a timeout.");
    expect(copy).toContain(
      "Detection doesn't check sign-in: whether each account is signed in shows on its card in Providers, then Accounts.",
    );
  });
});

// B5 staging/b5: crates/providers/src/claude/mod.rs (2.1.282 up to 2.2.0), codex/mod.rs and
// gemini/mod.rs (VersionWindow floors 0.155.1, 0.156.0, 0.157.0, 0.158.0 and 0.61.0).
describe("supported provider CLI versions", () => {
  it("names the certified release lines in the provider docs", async () => {
    const copy = text(await render(ProvidersDocs, "/docs/providers"));
    // codex/mod.rs MANAGED_VERSIONS: 0.160 everywhere; 0.155.1-0.159 lines on macOS only.
    expect(copy).toContain(
      "Claude Code 2.1.282 or a later 2.1 release, Codex CLI 0.160 (on macOS also the 0.155 to 0.159 lines, from 0.155.1), and Gemini CLI 0.61.",
    );
    expect(copy).toContain("Pre-release builds aren't supported.");
    // Refusals name the supported versions but no install command.
    expect(copy).toContain("agents stop with a message that names the supported versions.");
  });
});

// B5 Switch Accounts: AccountSwitcher.tsx, RebindThreadDialog.tsx, NewThread.tsx and
// ProviderAccountsView.tsx on staging/b5.
describe("provider accounts", () => {
  it("describe several accounts, workspace defaults and confirmed switching", async () => {
    const copy = text(await render(ProvidersDocs, "/docs/providers"));
    // 0.1.9+1565: the terminal-header account picker starts a fresh session and keeps the original;
    // 0.1.9+1738: account suggestions, never silent switches.
    expect(copy).toContain("You can add more than one account for each provider");
    expect(copy).toContain(
      "Set default chooses the account new agents use where a workspace has no default of its own",
    );
    expect(copy).toContain("Connect another account adds an account and starts its sign-in");
    expect(copy).toContain("never changes account on its own");
    expect(copy).toContain("choosing a different account starts a fresh session on it and keeps the original");
    expect(copy).toContain("switches only when you choose to");
  });
});

describe("credential storage", () => {
  it("puts KalCode's own session in the OS credential store and provider sign-ins with the provider", async () => {
    const copy = text(await render(LocalFirstDocs, "/docs/local-first"));
    expect(copy).toContain(
      "KalCode's own secrets, such as your KalCode account session, are stored in your operating system's credential store: Windows Credential Manager or macOS Keychain.",
    );
    expect(copy).toContain(
      "Each provider account you add gets its own KalCode-managed provider profile on your device",
    );
    expect(copy).toContain("Gemini CLI keeps its sign-in in its own AES-256-GCM encrypted file, never in plaintext");
    expect(copy).toContain("KalCode never reads or copies these credentials");
  });

  it("does not claim more than Gemini's host-derived key gives", async () => {
    for (const [component, path] of [
      [LocalFirstDocs, "/docs/local-first"],
      [Security, "/security"],
      [ProvidersDocs, "/docs/providers"],
    ] as const) {
      const copy = text(await render(component as Component, path));
      expect(copy).toMatch(/key from your computer and user names/);
      expect(copy).toMatch(/not away from other programs running as your user/);
      expect(copy).not.toMatch(/isolated from other (apps|programs|processes)/i);
    }
  });

  it("states where credentials are kept on the security page", async () => {
    const copy = text(await render(Security, "/security"));
    expect(copy).toContain(
      "Your KalCode account session is kept in your operating system's credential store (Windows Credential Manager or macOS Keychain).",
    );
    expect(copy).toContain("Provider sign-ins are kept by each provider's own CLI");
    expect(copy).toContain("provider sign-ins stay with each provider's own CLI, separately for every account you add");
  });

  it("describes the local-first and security pages without the OS-keychain claim", () => {
    const descriptions = PAGES.filter((p) => p.path === "/docs/local-first" || p.path === "/security").map(
      (p) => p.description,
    );
    for (const description of descriptions) expect(description).not.toMatch(/keychain/i);
    expect(descriptions.join(" ")).toContain("KalCode session");
  });
});

// Claims that Gemini CLI works in 0.1.6 or that KalCode supports Google's replacement. Stage
// previews (sample data) and the dated September 24 KalVoice archive entry are out of scope.
const GEMINI_OVERCLAIMS = [
  /Claude Code, Codex,? and Gemini CLI (run|connect|use)\b/i,
  /Connect Claude Code, Codex, Gemini/i,
  /Built · Claude Code, Codex, Gemini CLI/,
  /Claude Code, Codex,? and Gemini CLI through/i,
  /Antigravity/i,
];

/** Makes the fixture a signed Stable 0.1.6 (Windows and Apple silicon), so Updates shows its entry. */
function selectSignedStable016() {
  const latest = fixture.manifest.latest;
  const windows = latest?.platforms[0];
  if (!latest || !windows) throw new Error("fixture has no Windows release");
  latest.version = "0.1.6";
  latest.channel = "stable";
  windows.signed = true;
  latest.platforms.push({ ...windows, os: "macos", arch: "arm64", signed: true });
}

describe("Gemini CLI availability", () => {
  // Home and product describe Gemini CLI as the working provider it is (see "provider support status").
  const pages = [{ name: "provider docs", component: ProvidersDocs as Component, path: "/docs/providers" }];

  // 0.1.9+1658: "Gemini CLI runs in your real workspace with your MCP servers, extensions and skills."
  it.each(pages)("the $name describes Gemini CLI as a working provider", async ({ component, path }) => {
    const copy = text(await render(component, path));
    expect(copy).toContain("signed in with Google's own sign-in, running in your real workspace");
    expect(copy).not.toMatch(/Gemini CLI is unavailable|June 18, 2026/);
  });

  it.each([
    ...pages,
    { name: "pricing page", component: Pricing as Component, path: "/pricing" },
    { name: "download page", component: Download as Component, path: "/download" },
    { name: "KalVoice page", component: KalVoicePage as Component, path: "/kalvoice" },
    { name: "security page", component: Security as Component, path: "/security" },
    { name: "home page", component: Home as Component, path: "/" },
    { name: "product page", component: Product as Component, path: "/product" },
  ])(
    "the $name never claims Gemini CLI works in 0.1.6 or that Antigravity is supported",
    async ({ component, path }) => {
      const html = await render(component, path);
      const copy = `${text(html)} ${metaDescription(html)}`;
      for (const pattern of GEMINI_OVERCLAIMS) expect(copy).not.toMatch(pattern);
    },
  );

  it("marks Gemini CLI unavailable in the 0.1.6 release entry", async () => {
    selectSignedStable016();
    const copy = text(await render(Updates, "/updates"));
    expect(copy).toContain("Work with Claude Code and Codex through their official accounts");
    expect(copy).toContain(
      "Sign-in and threads with Claude Code 2.1.282 and later 2.1 releases and Codex 0.155.1 through 0.158.",
    );
    expect(copy).toContain(
      "Gemini CLI is unavailable: on June 18, 2026, Google ended Gemini CLI access through Sign in with Google for personal accounts, and 0.1.6 can't set the Google Cloud project that Standard and Enterprise licenses need.",
    );
    expect(copy).not.toContain("Codex 0.155.1 through 0.158 and Gemini CLI 0.61");
    expect(copy).not.toMatch(/Antigravity/i);
  });

  it("names every provider on the download page", async () => {
    const copy = text(await render(Download as Component, "/download"));
    expect(copy).toContain("Claude Code, Codex, Cursor and Gemini CLI connect free on every plan");
    expect(copy).not.toMatch(/Gemini CLI is unavailable/);
  });

  it("names all four providers in the home and provider-docs descriptions", () => {
    const home = PAGES.find((p) => p.path === "/");
    const docs = PAGES.find((p) => p.path === "/docs/providers");
    expect(home?.description).toContain("Claude Code, Codex, Cursor and Gemini CLI");
    expect(docs?.description).toContain("Claude Code, Codex, Cursor and Gemini CLI as native terminals");
    expect(`${home?.description} ${docs?.description}`).not.toMatch(/unavailable/i);
    expect(KALVOICE.summary).not.toMatch(/Gemini/);
  });

  it("uses a working provider, not Gemini, as the account-switching example", async () => {
    const copy = text(await render(ProvidersDocs, "/docs/providers"));
    expect(copy).toContain("The account picker in a coding terminal's header opens Account & usage");
    expect(copy).not.toMatch(/Gemini [AB]\b|switch gemini/i);
  });
});
