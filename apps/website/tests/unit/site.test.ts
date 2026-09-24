import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLANS } from "@kalcode/protocol/plans";
import { describe, expect, it } from "vitest";
import { isKnownPagePath, PAGES } from "../../src/lib/site";
import { THEME_SCRIPT } from "../../src/lib/theme-script";
import { buildCsp, cspHash } from "../../worker/lib/security";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function pageFile(path: string): string {
  if (path === "/") return resolve(root, "src/pages/index.astro");
  const direct = resolve(root, `src/pages${path}.astro`);
  return existsSync(direct) ? direct : resolve(root, `src/pages${path}/index.astro`);
}

describe("site map", () => {
  it("has a page source for every listed page", () => {
    for (const page of PAGES) {
      expect(existsSync(pageFile(page.path)), page.path).toBe(true);
    }
  });

  it("lists every page source (no unlisted public pages)", () => {
    const listed = new Set(PAGES.map((page) => pageFile(page.path)));
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
    expect(isKnownPagePath("/download/")).toBe(false);
    expect(isKnownPagePath("/404")).toBe(false);
  });
});

describe("pricing source of truth", () => {
  it("reads the three plans from @kalcode/protocol", () => {
    expect(PLANS.map((plan) => [plan.name, plan.price.amountUsd])).toEqual([
      ["Free", 0],
      ["Pro", 10],
      ["MAX", 25],
    ]);
  });

  it("never hardcodes a price in page sources", () => {
    const pricing = readFileSync(pageFile("/pricing"), "utf8");
    const home = readFileSync(pageFile("/"), "utf8");
    for (const source of [pricing, home]) {
      expect(source).not.toMatch(/\$\s?(10|25)\b/);
    }
  });
});

describe("plan wording on the public site", () => {
  const dist = resolve(root, "dist");
  it.runIf(existsSync(dist))("never shows the private tier or calls usage tokens", () => {
    const htmlFiles = readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".html"));
    for (const file of htmlFiles) {
      const text = readFileSync(resolve(dist, file), "utf8")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ");
      expect(text, file).not.toMatch(/\bOWNER\b/);
      expect(text, file).not.toMatch(/\btokens?\b/i);
      expect(text, file).not.toMatch(/\bentitlements?\b/i);
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

  const dist = resolve(root, "dist");
  it.runIf(existsSync(dist))("matches every inline script in the built HTML", () => {
    const htmlFiles = readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".html"));
    expect(htmlFiles.length).toBeGreaterThan(0);
    for (const file of htmlFiles) {
      const html = readFileSync(resolve(dist, file), "utf8");
      const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
      expect(inline, file).toEqual([THEME_SCRIPT]);
      expect(html, file).not.toMatch(/<style[\s>]/);
      expect(html, file).not.toMatch(/\sstyle="/);
    }
  });
});
