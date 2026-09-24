import { expect, test } from "@playwright/test";
import { NOT_FOUND_PAGE, PAGES, SITE_ORIGIN } from "../../src/lib/site";

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

  test("the hero globe is served as AVIF/WebP with explicit size and high priority", async ({ page }) => {
    await page.goto("/");
    const img = page.locator(".hero img");
    await expect(img).toHaveAttribute("fetchpriority", "high");
    await expect(img).toHaveAttribute("width", /\d+/);
    await expect(img).toHaveAttribute("height", /\d+/);
    await expect(page.locator('.hero source[type="image/avif"]')).toHaveCount(1);
    await expect(page.locator('.hero source[type="image/webp"]')).toHaveCount(1);
  });
});
