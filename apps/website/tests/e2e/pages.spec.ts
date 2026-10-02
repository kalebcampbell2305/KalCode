import { PLANS } from "@kalcode/protocol/plans";
import { expect, test } from "@playwright/test";
import { NOT_FOUND_PAGE, PAGES, SITE_ORIGIN, SOCIAL } from "../../src/lib/site";
import { CHANNEL_LABEL, MANIFEST, renderedDescription, SERVED_STABLE, SIGNED_STABLE, WINDOWS_BUILD } from "./helpers";

const STABLE_016 = SIGNED_STABLE && MANIFEST.latest?.version === "0.1.6";
const STABLE_017 = SIGNED_STABLE && MANIFEST.latest?.version === "0.1.7";
// A signed Stable 0.1.8+N build, which MANIFEST presents by its public version (helpers.ts presentedManifest).
const STABLE_018 = SIGNED_STABLE && MANIFEST.latest?.version === "0.1.8";
const GEMINI_UNAVAILABLE_TAG = STABLE_018
  ? /Gemini CLI unavailable in (KalCode )?0\.1\.8/
  : STABLE_017
    ? /Gemini CLI unavailable in (KalCode )?0\.1\.7/
    : /Gemini CLI unavailable in (KalCode )?0.1.6/;

test.describe("every page", () => {
  for (const page of PAGES) {
    test(`${page.path} renders with correct metadata and no console errors`, async ({ page: tab }) => {
      const errors: string[] = [];
      tab.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      tab.on("pageerror", (error) => errors.push(error.message));

      const response = await tab.goto(page.path);
      expect(response?.status()).toBe(200);
      await expect(tab).toHaveTitle(page.title);

      const head = tab.locator("head");
      await expect(head.locator('meta[name="description"]')).toHaveAttribute("content", renderedDescription(page));
      if (page.path === "/kalvoice") {
        // Preview or no release: KalVoice is still in development. Stable served: it has shipped.
        const description = head.locator('meta[name="description"]');
        if (SERVED_STABLE) await expect(description).not.toHaveAttribute("content", /In development/);
        else await expect(description).toHaveAttribute("content", / In development\.$/);
      }
      await expect(head.locator('link[rel="canonical"]')).toHaveAttribute("href", new URL(page.path, SITE_ORIGIN).href);
      await expect(head.locator('meta[property="og:title"]')).toHaveAttribute("content", page.title);
      await expect(head.locator('meta[property="og:image"]')).toHaveAttribute("content", `${SITE_ORIGIN}/og.png`);
      await expect(head.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
      await expect(head.locator('meta[name="twitter:site"]')).toHaveAttribute("content", SOCIAL.official.handle);
      await expect(head.locator('meta[name="theme-color"]').first()).toHaveAttribute("content", /#/);
      await expect(tab.locator("h1")).toHaveCount(1);
      await expect(tab.locator("main#main")).toBeVisible();
      await expect(tab.locator("footer")).toContainText("© 2026 KalCode");

      // CSP violations and script failures surface as console errors.
      expect(errors).toEqual([]);
    });
  }

  test("stages call no Stable-shipped feature a development build once Stable is served", async ({ page }) => {
    test.skip(!SERVED_STABLE, "the preview keeps its preview-era stage tags");
    for (const path of ["/", "/product", "/kalvoice"]) {
      await page.goto(path);
      const stages = page.locator("[data-stage-slot]");
      for (const text of await stages.allInnerTexts()) {
        expect(text, path).not.toMatch(/Development build|Preview · in development|\bIn development\b|\b0\.1\.0\b/i);
        // 0.1.6 is variant A (Gemini CLI unavailable): a stage that names the Stable release draws no
        // Gemini CLI thread.
        if (/In Stable \d|Dashboard in Stable \d/.test(text)) expect(text, path).not.toMatch(/Gemini CLI/);
        // Any other stage that still shows Gemini CLI says it is unavailable.
        // (The stage tags name the served Stable version: 0.1.6, 0.1.7 or 0.1.8, whichever is selected.)
        if (/Gemini CLI/.test(text)) expect(text, path).toMatch(GEMINI_UNAVAILABLE_TAG);
      }
    }
  });

  test("unknown paths return the styled 404 with status 404", async ({ page }) => {
    const response = await page.goto("/this-page-does-not-exist");
    expect(response?.status()).toBe(404);
    await expect(page).toHaveTitle(NOT_FOUND_PAGE.title);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
    await expect(page.getByRole("link", { name: "Go to the home page" })).toBeVisible();
  });

  test("responses carry the security headers", async ({ request }) => {
    const response = await request.get("/");
    const headers = response.headers();
    expect(headers["content-security-policy"]).toContain("default-src 'none'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["permissions-policy"]).toContain("camera=()");
  });

  test("hashed assets are immutable; SEO files exist", async ({ page, request }) => {
    await page.goto("/");
    const css = await page.locator('link[rel="stylesheet"]').first().getAttribute("href");
    expect(css).toMatch(/^\/_astro\//);
    const asset = await request.get(css ?? "");
    expect(asset.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");

    const robots = await request.get("/robots.txt");
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toContain("Sitemap: https://kalcoded.com/sitemap-index.xml");
    const sitemap = await request.get("/sitemap-0.xml");
    const xml = await sitemap.text();
    for (const entry of PAGES) {
      expect(xml).toContain(`<loc>${new URL(entry.path, SITE_ORIGIN).href}</loc>`);
    }
    expect(xml).toContain(`<loc>${SITE_ORIGIN}/updates</loc>`);
    expect(xml).not.toContain(`${SITE_ORIGIN}/changelog`);
    expect(xml).not.toContain("404");
    for (const icon of [
      "/favicon.ico",
      "/favicon-32.png",
      "/apple-touch-icon.png",
      "/og.png",
      "/assets/brand/kalcode-wordmark.png",
    ]) {
      expect((await request.get(icon)).status(), icon).toBe(200);
    }
  });

  test("legacy Changelog URLs redirect permanently to Updates and preserve release anchors", async ({
    page,
    request,
  }) => {
    const response = await request.get("/changelog?from=bookmark", { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    expect(response.headers().location).toBe("/updates?from=bookmark");

    await page.goto("/changelog#release-kalvoice");
    await expect(page).toHaveURL(/\/updates#release-kalvoice$/);
    await expect(page.locator("#release-kalvoice")).toBeVisible();
  });

  test("Updates is a concise product-news page with meaningful release sections", async ({ page }) => {
    await page.goto("/updates");
    await expect(page.getByRole("heading", { level: 1, name: "Updates" })).toBeVisible();
    // The 0.1.6 notes render only from a complete signed Stable 0.1.6, 0.1.7 or 0.1.8 manifest, the 0.1.7
    // notes only from a signed Stable 0.1.7 or 0.1.8 one, and the 0.1.8 notes only from a signed Stable
    // 0.1.8 build (the page's own rule).
    await expect(page.locator("article")).toHaveCount(STABLE_018 ? 7 : STABLE_017 ? 6 : STABLE_016 ? 5 : 4);
    if (STABLE_018) {
      await expect(page.locator("#release-0-1-8")).toBeVisible();
      await expect(page.locator("#release-0-1-8")).toContainText(
        "Windows: 0.1.6 can't update itself. Download the 0.1.8 installer from the download page and run it once — your data is kept.",
      );
      await expect(page.locator("#release-0-1-8")).toContainText("macOS: update from 0.1.6 in the app.");
      await expect(page.locator("#release-0-1-8").getByRole("link", { name: "download page" })).toHaveAttribute(
        "href",
        "/download",
      );
    } else await expect(page.locator("#release-0-1-8")).toHaveCount(0);
    if (STABLE_017 || STABLE_018) {
      await expect(page.locator("#release-0-1-7")).toBeVisible();
      await expect(page.locator("#release-0-1-7")).toContainText(
        "Windows: 0.1.6 can't update itself. Download the 0.1.7 installer from the download page and run it once — your data is kept.",
      );
      await expect(page.locator("#release-0-1-7")).toContainText("macOS: update from 0.1.6 in the app.");
      await expect(page.locator("#release-0-1-7").getByRole("link", { name: "download page" })).toHaveAttribute(
        "href",
        "/download",
      );
    } else await expect(page.locator("#release-0-1-7")).toHaveCount(0);
    if (STABLE_016 || STABLE_017 || STABLE_018) {
      await expect(page.locator("#release-0-1-6")).toBeVisible();
      await expect(page.locator("#release-0-1-6")).toContainText(
        "Windows: in-app Update and Restore previous version don't work in 0.1.6.",
      );
      await expect(page.locator("#release-0-1-6").getByRole("link", { name: "download page" })).toHaveAttribute(
        "href",
        "/download",
      );
    } else await expect(page.locator("#release-0-1-6")).toHaveCount(0);
    await expect(page.locator("#release-0-1-1")).toBeVisible();
    await expect(page.locator("#release-website-2026-09-24")).toBeVisible();
    await expect(page.locator("#release-kalvoice")).toBeVisible();
    await expect(page.locator("#milestone-foundation")).toBeVisible();
    await expect(page.locator("main")).not.toContainText("commit");
  });

  test("Updates stays inside the viewport on desktop and mobile", async ({ page }) => {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/updates");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${width}px viewport has no horizontal overflow`).toBeLessThanOrEqual(0);
      for (const card of await page.locator("article.update").all()) {
        const box = await card.boundingBox();
        expect(box && box.x >= 0 && box.x + box.width <= width, `update card fits at ${width}px`).toBe(true);
      }
    }
  });

  test("the home hero names the product, the providers and an honest call to action", async ({ page }) => {
    await page.goto("/");
    const h1 = page.locator("h1");
    await expect(h1).toContainText("KalCode");
    await expect(h1).toContainText("One intelligence that operates your entire AI workspace.");
    const hero = page.locator(".hero");
    await expect(hero).toContainText("Claude Code, Codex and the coding tools you already use");
    await expect(hero).not.toContainText("Gemini");
    const primary = hero.locator(".button--primary");
    await expect(primary).toHaveText("Download KalCode");
    if (WINDOWS_BUILD && MANIFEST.latest) {
      // A published Windows build: the primary action is the real download (Windows visitors).
      await expect(primary).toHaveAttribute("data-download-state", "download");
      await expect(hero).toContainText(`${CHANNEL_LABEL} ${MANIFEST.latest.version}`);
    } else {
      // No public build: the button goes to the honest download page, the status line says so,
      // and nothing links to a file.
      await expect(primary).toHaveAttribute("href", "/download");
      await expect(primary).toHaveAttribute("data-download-state", "pending");
      await expect(hero).toContainText("No public build yet");
      await expect(page.locator('a[href^="/download/"]')).toHaveCount(0);
    }
    await hero.getByRole("link", { name: "See it in action" }).click();
    await expect(page).toHaveURL(/#workspace$/);
    // Provider constellation: honest adapter status.
    const providers = page.getByRole("list", { name: "Works with the coding agents you already use" });
    await expect(providers).toContainText("Adapter built");
    await expect(providers).not.toContainText("planned");
  });

  test("the header offers Download (plain label) in every manifest state", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const cta = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Download", exact: true });
    await expect(cta).toHaveText("Download");
    await expect(cta).toHaveAttribute("href", "/download");
    await page.setViewportSize({ width: 390, height: 844 });
    const compact = page.locator(".header-tools").getByRole("link", { name: "Download", exact: true });
    await expect(compact).toHaveText("Download");
    await expect(compact).toHaveAttribute("href", "/download");
  });

  test("the hero is a full-bleed first viewport with centred type and both calls to action", async ({ page }) => {
    for (const [width, height] of [
      [390, 844],
      [1440, 900],
      [2560, 1440],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/");
      const hero = await page.locator(".hero").boundingBox();
      expect(hero && hero.width >= width - 1 && hero.height >= height - 1, `hero fills ${width}x${height}`).toBe(true);
      const title = await page.locator(".hero__statement").boundingBox();
      // Centred: the title's centre is within 2 px of the viewport's centre line.
      expect(title && Math.abs(title.x + title.width / 2 - width / 2) < 2, `title centred at ${width}`).toBe(true);
      for (const name of ["Download KalCode", "See it in action"]) {
        const box = await page.locator(".hero").getByRole("link", { name }).boundingBox();
        expect(box && box.y + box.height <= Math.max(height, hero?.height ?? 0), `${name} inside the hero`).toBe(true);
      }
    }
  });

  test("home carries Organization and SoftwareApplication JSON-LD built from site data", async ({ page }) => {
    await page.goto("/");
    const raw = await page.locator('script[type="application/ld+json"]').textContent();
    const data = JSON.parse(raw ?? "{}") as { "@graph": Record<string, unknown>[] };
    const byType = (type: string) => data["@graph"].find((node) => node["@type"] === type);
    expect(byType("Organization")?.sameAs).toEqual([SOCIAL.official.url]);
    const app = byType("SoftwareApplication") as {
      offers: { name: string; price: string; priceSpecification: { price: string; billingDuration: string }[] }[];
    };
    expect(app.offers.map((offer) => [offer.name, Number(offer.price)])).toEqual(
      PLANS.map((plan) => [plan.name, plan.price.monthlyUsd]),
    );
    expect(
      app.offers.map((offer) => offer.priceSpecification.map((spec) => [spec.billingDuration, Number(spec.price)])),
    ).toEqual(
      PLANS.map((plan) => [
        ["P1M", plan.price.monthlyUsd],
        ["P1Y", plan.price.yearlyUsd],
      ]),
    );
    expect(raw).not.toMatch(/aggregateRating|review/i);
  });

  test("the hero's first images are explicit-size and the orb poster is high priority", async ({ page }) => {
    await page.goto("/");
    const images = page.locator(".hero img");
    expect(await images.count()).toBeGreaterThan(0);
    for (const img of await images.all()) {
      await expect(img).toHaveAttribute("width", /\d+/);
      await expect(img).toHaveAttribute("height", /\d+/);
    }
    expect(await page.locator('.hero img[fetchpriority="high"]').count()).toBeGreaterThan(0);
    expect(await page.locator('.hero source[type="image/avif"]').count()).toBeGreaterThan(0);
    // The poster (the LCP image) is preloaded with the layout's sizes.
    await expect(page.locator('head link[rel="preload"][as="image"]')).toHaveCount(3);
  });
});

test("the build stamp names the commit this build came from", async ({ request }) => {
  // Read by `node tooling/release/ship.mjs lifecycle status` to tell whether main is deployed.
  const response = await request.get("/.well-known/kalcode-build.json");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  const stamp = await response.json();
  expect(stamp).toMatchObject({ schema: "kalcode-build/v1", app: "website" });
  expect(stamp.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(typeof stamp.dirty).toBe("boolean");
  expect(Number.isNaN(Date.parse(stamp.builtAt))).toBe(false);
});
