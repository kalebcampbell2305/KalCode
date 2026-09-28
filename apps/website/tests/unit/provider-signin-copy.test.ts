import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseManifest } from "../../src/data/releases";
import { publishedManifest } from "./fixtures/releases";

const fixture = vi.hoisted(() => ({ manifest: {} as ReleaseManifest }));
vi.mock("../../src/lib/releases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/releases")>()),
  RELEASES: fixture.manifest,
}));

import ProvidersDocs from "../../src/pages/docs/providers.astro";
import Home from "../../src/pages/index.astro";
import Product from "../../src/pages/product.astro";

beforeEach(() => Object.assign(fixture.manifest, structuredClone(publishedManifest)));

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

// Threads run every provider in a managed per-account profile (docs/PROVIDERS.md, "Managed Gemini
// accounts"; desktop Setup guidance): a CLI signed in from a terminal is a separate profile that
// KalCode threads never read, so no page may imply that an existing terminal sign-in is reused or
// tell people to sign a CLI in by hand.
const TERMINAL_SIGN_IN = [
  /\bsigned-in (session|local CLI)\b/i,
  /sign-in or API key you already have/i,
  /\brun(ning)? `?(claude|codex|gemini)`?( \/?(login|auth))? in (a|your) terminal to sign in/i,
  // CLI commands are lowercase; the sample mission's "Codex Login and reset forms" is a task name.
  /\b(claude|codex|gemini) (\/login|login|auth login)\b/,
];

describe.each([
  { name: "home page", component: Home as Component, path: "/" },
  { name: "product page", component: Product as Component, path: "/product" },
  { name: "provider docs", component: ProvidersDocs as Component, path: "/docs/providers" },
])("the $name", ({ component, path }) => {
  it("never points provider sign-in at a CLI signed in from a terminal", async () => {
    const copy = text(await render(component, path));
    for (const pattern of TERMINAL_SIGN_IN) expect(copy).not.toMatch(pattern);
  });
});

describe("provider docs sign-in", () => {
  it("sends every provider through its account card in KalCode", async () => {
    const copy = text(await render(ProvidersDocs, "/docs/providers"));
    expect(copy).toContain("open Providers, then Accounts, add an account and choose Sign in");
    expect(copy).toContain("Claude Code and Codex open their browser sign-in");
    expect(copy).toContain("Gemini CLI opens Google sign-in in your browser");
    expect(copy).toMatch(
      /Signing a CLI in from a separate terminal signs in a different profile that KalCode threads don't use/,
    );
  });

  it("states that Gemini CLI sign-in is encrypted and never plaintext", async () => {
    const copy = text(await render(ProvidersDocs, "/docs/providers"));
    expect(copy).toMatch(/Gemini CLI keeps its sign-in in its own encrypted credential store, never in plaintext/);
  });
});

describe("home and product provider summaries", () => {
  it("say sign-in happens from KalCode", async () => {
    expect(text(await render(Home, "/"))).toContain(
      "run on your own accounts: sign in to each from KalCode, with a separate managed profile for every account",
    );
    expect(text(await render(Product, "/product"))).toContain(
      "each provider's own sign-in, run from KalCode for your account.",
    );
  });
});
