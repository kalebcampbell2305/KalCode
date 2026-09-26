import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLANS } from "@kalcode/protocol/plans";
import { describe, expect, it } from "vitest";
import { ACCOUNT_PAGE, EMAIL_ACTION_PAGES, FOOTER_NAV, isKnownPagePath, PAGES, PRIMARY_NAV } from "../../src/lib/site";
import { THEME_SCRIPT } from "../../src/lib/theme-script";
import { buildCsp, cspHash } from "../../worker/lib/security";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Built site to inspect: `dist` by default, or the folder an isolated build wrote to. */
const dist = resolve(root, process.env.KALCODE_DIST ?? "dist");

function pageFile(path: string): string {
  if (path === "/") return resolve(root, "src/pages/index.astro");
  const direct = resolve(root, `src/pages${path}.astro`);
  return existsSync(direct) ? direct : resolve(root, `src/pages${path}/index.astro`);
}

function builtHtml(): { file: string; html: string }[] {
  return readdirSync(dist, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".html"))
    .map((file) => ({ file, html: readFileSync(resolve(dist, file), "utf8") }));
}

const visibleText = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

describe("site map", () => {
  it("has a page source for every listed page", () => {
    for (const page of PAGES) {
      expect(existsSync(pageFile(page.path)), page.path).toBe(true);
    }
  });

  it("lists every page source (no unlisted public pages)", () => {
    const listed = new Set(
      [...PAGES, ...Object.values(EMAIL_ACTION_PAGES), ACCOUNT_PAGE].map((page) => pageFile(page.path)),
    );
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(resolve(dir, entry.name)) : [resolve(dir, entry.name)],
      );
    const sources = walk(resolve(root, "src/pages")).filter(
      (file) => file.endsWith(".astro") && !file.endsWith("404.astro"),
    );
    for (const file of sources) {
      expect(listed.has(file), file).toBe(true);
    }
  });

  it("gives every page a unique title and description", () => {
    expect(new Set(PAGES.map((page) => page.title)).size).toBe(PAGES.length);
    expect(new Set(PAGES.map((page) => page.description)).size).toBe(PAGES.length);
  });

  it("recognises only listed paths as sources", () => {
    expect(isKnownPagePath("/download")).toBe(true);
    expect(isKnownPagePath("/kalvoice")).toBe(true);
    expect(isKnownPagePath("/download/")).toBe(false);
    expect(isKnownPagePath("/404")).toBe(false);
    expect(isKnownPagePath("/early-access/confirm")).toBe(false);
  });

  it("keeps the pages opened from email links out of search and the sitemap", () => {
    for (const page of Object.values(EMAIL_ACTION_PAGES)) {
      expect(existsSync(pageFile(page.path)), page.path).toBe(true);
      expect(PAGES.some((listed) => listed.path === page.path)).toBe(false);
      const source = readFileSync(pageFile(page.path), "utf8");
      expect(source).toMatch(/<Base[^>]*\bnoindex\b/);
      expect(source).toContain('name="referrer" content="no-referrer"');
      if (existsSync(dist)) {
        const html = readFileSync(resolve(dist, `${page.path.slice(1)}.html`), "utf8");
        expect(html).toContain('<meta name="robots" content="noindex">');
        expect(html).not.toContain('rel="canonical"');
      }
    }
    if (existsSync(resolve(dist, "sitemap-0.xml"))) {
      expect(readFileSync(resolve(dist, "sitemap-0.xml"), "utf8")).not.toContain("/early-access/");
    }
  });

  it("keeps the private Account entry point out of search and the public source allow-list", () => {
    expect(PAGES.some((page) => page.path === ACCOUNT_PAGE.path)).toBe(false);
    expect(isKnownPagePath(ACCOUNT_PAGE.path)).toBe(false);
    const source = readFileSync(pageFile(ACCOUNT_PAGE.path), "utf8");
    expect(source).toMatch(/<Base[^>]*\bnoindex\b/);
    expect(source).toContain('name="referrer" content="no-referrer"');
  });

  it("has the header navigation in the agreed order", () => {
    expect(PRIMARY_NAV.map((item) => item.label)).toEqual(["Product", "KalVoice", "Pricing", "Docs", "Updates"]);
    expect(PRIMARY_NAV.at(-1)).toEqual({ href: "/updates", label: "Updates" });
    expect(FOOTER_NAV.product.at(-1)).toEqual({ href: "/updates", label: "Updates" });
  });

  it("publishes Updates as the canonical release-news page", () => {
    expect(PAGES.some((page) => page.path === "/updates")).toBe(true);
    expect(PAGES.some((page) => page.path === "/changelog")).toBe(false);
    expect(existsSync(pageFile("/updates"))).toBe(true);
    expect(existsSync(pageFile("/changelog"))).toBe(false);
  });
});

describe("pricing source of truth", () => {
  it("reads the four public plans from @kalcode/protocol", () => {
    expect(PLANS.map((plan) => [plan.name, plan.price.amountUsd])).toEqual([
      ["Free", 0],
      ["Pro", 10],
      ["MAX", 25],
      ["MAX 2X", 50],
    ]);
  });

  it("never hardcodes a price or an allowance in page sources", () => {
    const sources = ["/", "/pricing", "/kalvoice", "/product"].map((path) => readFileSync(pageFile(path), "utf8"));
    sources.push(readFileSync(resolve(root, "src/components/PlanStrip.astro"), "utf8"));
    for (const source of sources) {
      expect(source).not.toMatch(/\$\s?(0|10|25|50)\b/);
      expect(source).not.toMatch(/\b(75|1,500|5,000|10,000)\b/);
    }
  });

  it.runIf(existsSync(dist))("renders every plan's price and KalVoice Requests on the pricing page", () => {
    const pricing = visibleText(readFileSync(resolve(dist, "pricing.html"), "utf8"));
    for (const plan of PLANS) {
      expect(pricing).toContain(plan.name);
      expect(pricing).toContain(`$${plan.price.amountUsd}`);
      expect(pricing).toContain((plan.limits.kalvoiceRequestsPerMonth ?? 0).toLocaleString("en-US"));
    }
    expect(pricing).toContain("Every plan includes");
  });
});

describe("plan wording on the public site", () => {
  it.runIf(existsSync(dist))("never shows the private tier, the old assistant name, or calls usage tokens", () => {
    // The old assistant name is assembled here so this file does not trip the branding check.
    const oldName = new RegExp(`\\b${["J", "A", "R", "V", "I", "S"].join("")}\\b`, "i");
    for (const { file, html } of builtHtml()) {
      const text = visibleText(html);
      expect(text, file).not.toMatch(/\bOWNER\b/);
      expect(text, file).not.toMatch(/\btokens?\b/i);
      expect(text, file).not.toMatch(/\bentitlements?\b/i);
      expect(html, file).not.toMatch(oldName);
    }
  });

  it("shows every plan's KalVoice Request allowance on the pricing page", () => {
    const pricing = readFileSync(pageFile("/pricing"), "utf8");
    expect(pricing).toContain("formatKalVoiceAllowance");
    expect(pricing).toContain("plan.limits");
    expect(pricing).not.toContain("OWNER");
  });
});

describe("content security policy", () => {
  it("hashes the theme script with SHA-256", async () => {
    const expected = createHash("sha256").update(THEME_SCRIPT, "utf8").digest("base64");
    await expect(cspHash(THEME_SCRIPT)).resolves.toBe(`'sha256-${expected}'`);
  });

  it("allows no inline code except the hashed theme script", () => {
    const csp = buildCsp("'sha256-abc='");
    expect(csp).toContain("script-src 'self' 'sha256-abc='");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toMatch(/unsafe-(inline|eval)/);
  });

  it.runIf(existsSync(dist))("matches every inline script in the built HTML", () => {
    const pages = builtHtml();
    expect(pages.length).toBeGreaterThan(0);
    for (const { file, html } of pages) {
      // JSON-LD is a non-executing data block, which CSP script-src does not govern.
      const inline = [
        ...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g),
      ].map((match) => match[1]);
      expect(inline, file).toEqual([THEME_SCRIPT]);
      expect(html, file).not.toMatch(/<style[\s>]/);
      expect(html, file).not.toMatch(/\sstyle="/);
    }
  });

  it.runIf(existsSync(dist))("puts valid JSON-LD only on the home page", () => {
    for (const { file, html } of builtHtml()) {
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      if (file === "index.html") {
        expect(blocks).toHaveLength(1);
        expect(() => JSON.parse(blocks[0]?.[1] ?? "")).not.toThrow();
      } else {
        expect(blocks, file).toHaveLength(0);
      }
    }
  });
});
