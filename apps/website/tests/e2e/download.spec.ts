import { expect, test } from "@playwright/test";
import { MANIFEST as RELEASES, WINDOWS_BUILD } from "./helpers";

/**
 * Asserts the state the site is built from (src/data/releases.json). Both states are also
 * rendered against fixture manifests in tests/unit/download-render.test.ts.
 */
test.describe("download page", () => {
  test("lists every OS: a build to download or the manifest's reason, never a dead link", async ({ page }) => {
    await page.goto("/download");
    const platforms = page.locator("[data-platforms]");
    for (const entry of RELEASES.unavailable) {
      const row = platforms.locator(`#${entry.os}`);
      await expect(row).toContainText("Not yet available");
      await expect(row).toContainText(entry.reason);
      await expect(row.locator("a")).toHaveCount(0);
    }
    if (WINDOWS_BUILD && RELEASES.latest) {
      const windows = platforms.locator("#windows");
      const button = windows.getByRole("link", { name: "Download for Windows" });
      await expect(button).toHaveAttribute("href", WINDOWS_BUILD.url);
      await expect(button).toHaveAttribute("download", WINDOWS_BUILD.file);
      await expect(windows).toContainText(WINDOWS_BUILD.sha256);
      await expect(windows).toContainText(RELEASES.latest.version);
      if (!WINDOWS_BUILD.signed) await expect(windows).toContainText("SmartScreen");
      await expect(windows).toContainText(`Get-FileHash .\\${WINDOWS_BUILD.file} -Algorithm SHA256`);
      await expect(page.locator("[data-platforms] > li")).toHaveCount(3);
      const canonicalNotesUrl = RELEASES.latest.notesUrl.replace(/^\/changelog(?=#|$)/, "/updates");
      await expect(windows.getByRole("link", { name: "Release notes" })).toHaveAttribute("href", canonicalNotesUrl);
    } else {
      await expect(page.locator(".page-head")).toContainText("No public build yet");
      await expect(platforms.locator("a")).toHaveCount(0);
      await expect(page.locator("a[download], a[href^='/download/']")).toHaveCount(0);
    }
    // Early access stays on the same page in both states.
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

  test("Download KalCode buttons follow the manifest: the installer, or the honest download page", async ({ page }) => {
    for (const path of ["/", "/pricing", "/product", "/kalvoice"]) {
      await page.goto(path);
      const buttons = page.locator("a[data-download-state]");
      for (const [state, href] of await buttons.evaluateAll((links) =>
        links.map((link) => [link.getAttribute("data-download-state"), link.getAttribute("href")]),
      )) {
        if (WINDOWS_BUILD) {
          expect(state).toBe("download");
          // Windows visitors get the installer; other systems are routed to the download page.
          expect([WINDOWS_BUILD.url, "/download", "/download#windows", "/download#macos", "/download#linux"]).toContain(
            href,
          );
        } else {
          expect(state).toBe("pending");
          expect(href).toBe("/download");
        }
      }
    }
  });

  test("the release notes link resolves to its Updates entry", async ({ page }) => {
    test.skip(RELEASES.latest === null, "no published release, so there are no release notes to link");
    const notes = new URL(RELEASES.latest?.notesUrl.replace(/^\/changelog(?=#|$)/, "/updates") ?? "/", "http://local");
    await page.goto(notes.pathname);
    await expect(page.locator(notes.hash)).toBeVisible();
  });
});
