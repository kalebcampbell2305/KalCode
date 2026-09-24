import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * Captures review screenshots of every desktop surface in both themes at three window sizes.
 * Output: apps/desktop/qa/screenshots/. Run: pnpm test:ui --grep @screenshots
 */
const OUT = new URL("../../qa/screenshots/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const SIZES = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1280", width: 1280, height: 800 },
  { name: "1024", width: 1024, height: 700 },
] as const;

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("radiogroup", { name: "Theme" })
    .getByRole("radio", { name: theme === "light" ? "Light" : "Dark" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: new URL(`${name}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
}

for (const theme of ["dark", "light"] as const) {
  test(`@screenshots surfaces in ${theme} theme`, async ({ page }) => {
    for (const size of SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
      await setTheme(page, theme);
      await page.getByRole("button", { name: "Check credential store" }).click();
      await page.getByRole("button", { name: "Dismiss notification" }).first().click();
      await shot(page, `settings-${theme}-${size.name}`);
      await page.getByRole("button", { name: "Dashboard" }).click();
      await shot(page, `dashboard-${theme}-${size.name}`);
      if (size.name === "1440") {
        await page.getByRole("button", { name: "KalVoice" }).click();
        await shot(page, `kalvoice-${theme}-${size.name}`);
        await page.getByRole("button", { name: "Threads" }).click();
        await shot(page, `gated-${theme}-${size.name}`);
        await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
        await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
        await shot(page, `palette-${theme}-${size.name}`);
        await page.keyboard.press("Escape");
        await page.keyboard.press(process.platform === "darwin" ? "Meta+b" : "Control+b");
        await page.getByRole("button", { name: "Dashboard" }).click();
        await shot(page, `dashboard-collapsed-${theme}-${size.name}`);
      }
    }
  });
}

const PROVIDER_SIZES = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1024", width: 1024, height: 700 },
] as const;

for (const theme of ["dark", "light"] as const) {
  test(`@screenshots providers in ${theme} theme`, async ({ page }) => {
    for (const size of PROVIDER_SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
      await setTheme(page, theme);
      await page.getByRole("button", { name: "Providers" }).click();
      await expect(page.getByText("Installed, version 2.1.282")).toBeVisible();
      await shot(page, `providers-${theme}-${size.name}`);
      // Review aids: the lower part of the page (permission table, a provider that isn't installed).
      await page.locator("#provider-claude-code table").scrollIntoViewIfNeeded();
      await shot(page, `providers-table-${theme}-${size.name}`);
      await page.locator("#provider-gemini-cli").scrollIntoViewIfNeeded();
      await shot(page, `providers-gemini-${theme}-${size.name}`);
    }
  });
}

test("@screenshots providers states", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const scenario of ["providers-outdated", "providers-error", "providers-none"]) {
    await page.goto(`/?scenario=${scenario}`);
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await page.getByRole("button", { name: "Providers" }).click();
    await expect(page.getByRole("button", { name: "Check again" })).not.toHaveAttribute("aria-busy", "true");
    await shot(page, `${scenario}-dark-1440`);
  }
  await page.getByRole("button", { name: "Dashboard" }).click();
  await shot(page, "dashboard-providers-none-dark-1440");
});

test("@screenshots startup error", async ({ page }) => {
  await page.goto("/?scenario=startup-error");
  await expect(page.getByRole("heading", { name: "KalCode couldn't start" })).toBeVisible();
  await shot(page, "startup-error-dark-1360");
});
