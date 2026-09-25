import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { ReleaseManifest } from "../../src/data/releases";
import { APP_ROOT } from "./helpers";

// Read as data: Playwright loads specs as plain Node ESM, where a JSON import needs attributes.
const RELEASES = JSON.parse(readFileSync(resolve(APP_ROOT, "src/data/releases.json"), "utf8")) as ReleaseManifest;

/**
 * The committed manifest has no public build (latest: null). The published-build state (download
 * button, SHA-256, SmartScreen note) is covered by tests/unit/download-render.test.ts against a
 * fixture manifest.
 */
test.describe("download page without a public build", () => {
  test("says so, lists every OS as not yet available with its reason, and links to no file", async ({ page }) => {
    expect(RELEASES.latest).toBeNull();
    await page.goto("/download");
    await expect(page.locator(".page-head")).toContainText("No public build yet");
    const platforms = page.locator("[data-platforms]");
    for (const os of ["windows", "macos", "linux"]) {
      await expect(platforms.locator(`#${os}`)).toContainText("Not yet available");
    }
    for (const entry of RELEASES.unavailable) await expect(platforms).toContainText(entry.reason);
    await expect(platforms.locator("a")).toHaveCount(0);
    await expect(page.locator("a[download], a[href^='/download/']")).toHaveCount(0);
    // Early access is the path forward, on the same page.
    await expect(page.locator("#early-access form[data-api-form='signup']")).toHaveCount(1);
  });

  test("marks the visitor's system", async ({ browser }) => {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto("/download");
    await expect(page.locator("html")).toHaveAttribute("data-os", "windows");
    await expect(page.locator("#windows .platform__you")).toBeVisible();
    await expect(page.locator("#macos .platform__you")).toBeHidden();
    await context.close();
  });

  test("no page offers a download button", async ({ page }) => {
    for (const path of ["/", "/pricing", "/product", "/kalvoice", "/download"]) {
      await page.goto(path);
      await expect(page.getByRole("link", { name: /Download for/ })).toHaveCount(0);
    }
  });
});
