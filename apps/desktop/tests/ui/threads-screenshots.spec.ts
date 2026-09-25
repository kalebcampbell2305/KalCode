import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * Review screenshots of the Threads surface (list, detail, new-thread flow, streaming) in both
 * themes at 1440 and 1024. Output: apps/desktop/qa/screenshots/. Run: pnpm test:ui --grep @screenshots
 */
const OUT = new URL("../../qa/screenshots/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const SIZES = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1024", width: 1024, height: 700 },
] as const;

async function shot(page: Page, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: new URL(`${name}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
}

async function open(page: Page, scenario: string, theme: "light" | "dark") {
  await page.goto(`/?scenario=${scenario}`);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type(`use ${theme} theme`);
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Threads" }).click();
}

for (const theme of ["dark", "light"] as const) {
  for (const size of SIZES) {
    test(`@screenshots threads in ${theme} theme at ${size.name}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const detail = page.getByRole("region", { name: "Thread", exact: true });
      const list = page.getByRole("list", { name: "Threads" });

      await open(page, "threads", theme);
      await expect(detail.getByText("Run npm test").first()).toBeVisible();
      await shot(page, `threads-list-${theme}-${size.name}`);

      await list.getByRole("button", { name: /Add Dark Mode Toggle/ }).click();
      await expect(detail.getByText("Waiting for 1 permission decision")).toBeVisible();
      await shot(page, `threads-waiting-${theme}-${size.name}`);

      await list.getByRole("button", { name: /Migrate API to v2/ }).click();
      await expect(detail.getByRole("alert")).toBeVisible();
      await shot(page, `threads-failed-${theme}-${size.name}`);

      await page.getByRole("button", { name: "New thread" }).first().click();
      const form = page.getByRole("region", { name: "New thread" });
      await form.getByLabel("Task").fill("Fix the OAuth callback race in the login flow");
      await shot(page, `threads-new-${theme}-${size.name}`);

      // "slow" makes the scripted provider stream slowly enough to catch mid-message.
      await form.getByLabel("Task").fill("fix the OAuth callback race in the slow login flow");
      await form.getByRole("button", { name: "Start thread" }).click();
      await expect(detail.getByText("Writing")).toBeVisible();
      await page.waitForTimeout(1_600);
      await shot(page, `threads-streaming-${theme}-${size.name}`);

      await open(page, "default", theme);
      await expect(page.getByRole("heading", { name: "No threads yet" })).toBeVisible();
      await shot(page, `threads-empty-${theme}-${size.name}`);

      await open(page, "providers-none", theme);
      await page.getByRole("button", { name: "New thread" }).first().click();
      await expect(page.getByRole("heading", { name: "No provider is ready for threads" })).toBeVisible();
      await shot(page, `threads-no-provider-${theme}-${size.name}`);
    });
  }
}
