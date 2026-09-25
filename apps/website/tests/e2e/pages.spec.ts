import { PLANS } from "@kalcode/protocol/plans";
import { expect, test } from "@playwright/test";
import { NOT_FOUND_PAGE, PAGES, SITE_ORIGIN, SOCIAL } from "../../src/lib/site";

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
      await expect(head.locator('meta[name="description"]')).toHaveAttribute("content", page.description);
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

  test("the home hero names the product, the providers and an honest call to action", async ({ page }) => {
    await page.goto("/");
    const h1 = page.locator("h1");
    await expect(h1).toContainText("KalCode");
    await expect(h1).toContainText("One intelligence that operates your entire AI workspace.");
    const hero = page.locator(".hero");
    await expect(hero).toContainText("Claude Code, Codex and Gemini CLI");
    // No public build: the primary action is early access, on this page, and nothing links to a file.
    const primary = hero.locator(".button--primary");
    await expect(primary).toHaveText("Join early access");
    await expect(primary).toHaveAttribute("href", "#early-access");
    await expect(hero).toContainText("No public build yet");
    await expect(page.locator('a[href^="/download/"]')).toHaveCount(0);
    await hero.getByRole("link", { name: "See it in action" }).click();
    await expect(page).toHaveURL(/#story$/);
    // Provider bar: honest adapter status.
    const providers = page.getByRole("list", { name: "Runs the coding agents you already use" });
    await expect(providers).toContainText("Adapter built");
    await expect(providers).toContainText("adapter planned");
  });

  test("the header offers Download (plain label) while there is no public build", async ({ page }) => {
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

  test("from 1024 px the hero copy sits left, clear of the orb and its stream", async ({ page }) => {
    for (const width of [1024, 1440, 2560]) {
      await page.setViewportSize({ width, height: width > 2000 ? 1440 : 900 });
      await page.goto("/");
      const orb = await page.locator(".hero__orb").boundingBox();
      for (const selector of [".hero__title", ".hero__support", ".hero__actions", ".hero__note"]) {
        const box = await page.locator(selector).boundingBox();
        expect(box && orb && box.x + box.width <= orb.x + 1, `${selector} at ${width}px`).toBe(true);
      }
      // The stream lands on the provider bar: the orb cell ends where the hero ends.
      const hero = await page.locator(".hero").boundingBox();
      expect(orb && hero && Math.abs(orb.y + orb.height - (hero.y + hero.height)) < 1).toBe(true);
    }
  });

  test("home carries Organization and SoftwareApplication JSON-LD built from site data", async ({ page }) => {
    await page.goto("/");
    const raw = await page.locator('script[type="application/ld+json"]').textContent();
    const data = JSON.parse(raw ?? "{}") as { "@graph": Record<string, unknown>[] };
    const byType = (type: string) => data["@graph"].find((node) => node["@type"] === type);
    expect(byType("Organization")?.sameAs).toEqual([SOCIAL.official.url]);
    const app = byType("SoftwareApplication") as { offers: { name: string; price: string }[] };
    expect(app.offers.map((offer) => [offer.name, Number(offer.price)])).toEqual(
      PLANS.map((plan) => [plan.name, plan.price.amountUsd]),
    );
    expect(raw).not.toMatch(/aggregateRating|review/i);
  });

  test("the hero orb poster is served as AVIF/WebP with explicit size and high priority", async ({ page }) => {
    await page.goto("/");
    const img = page.locator(".hero img");
    await expect(img).toHaveAttribute("fetchpriority", "high");
    await expect(img).toHaveAttribute("width", /\d+/);
    await expect(img).toHaveAttribute("height", /\d+/);
    await expect(page.locator('.hero source[type="image/avif"]')).toHaveCount(1);
    await expect(page.locator('.hero source[type="image/webp"]')).toHaveCount(1);
  });
});
