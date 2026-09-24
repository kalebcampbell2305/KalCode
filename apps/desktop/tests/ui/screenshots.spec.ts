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
        await page.getByRole("button", { name: "JARVIS" }).click();
        await shot(page, `jarvis-${theme}-${size.name}`);
        await page.getByRole("button", { name: "Agents" }).click();
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

test("@screenshots startup error", async ({ page }) => {
  await page.goto("/?scenario=startup-error");
  await expect(page.getByRole("heading", { name: "KalCode couldn't start" })).toBeVisible();
  await shot(page, "startup-error-dark-1360");
});
