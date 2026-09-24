import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * Review screenshots of every Dashboard scenario, in both themes, at the three reference window
 * sizes. Output: apps/desktop/qa/screenshots/dashboard/. Run: pnpm test:ui --grep @dashboard-shots
 *
 * `-full` captures render the whole scrolling page (taller viewport) for layout review.
 */
const OUT = new URL("../../qa/screenshots/dashboard/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const SIZES = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1280", width: 1280, height: 800 },
  { name: "1024", width: 1024, height: 700 },
] as const;

const SCENARIOS = ["busy", "approvals-flood", "empty", "errors", "loading", "unavailable"] as const;

function path(name: string) {
  return new URL(`${name}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("radiogroup", { name: "Theme" })
    .getByRole("radio", { name: theme === "light" ? "Light" : "Dark" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.getByRole("button", { name: "Dashboard" }).click();
}

async function ready(page: Page, scenario: (typeof SCENARIOS)[number]) {
  const main = page.locator("#main");
  if (scenario === "busy" || scenario === "approvals-flood") {
    await expect(main.getByRole("heading", { name: "Needs approval" })).toBeVisible();
    await expect(main.getByText("Fix flaky checkout test").first()).toBeVisible();
  } else if (scenario === "empty") {
    await expect(main.getByRole("heading", { name: "No active threads" })).toBeVisible();
  } else if (scenario === "errors") {
    await expect(main.getByRole("heading", { name: "Threads couldn't load" })).toBeVisible();
  } else if (scenario === "unavailable") {
    await expect(main.getByRole("heading", { name: "Threads arrive with provider support" })).toBeVisible();
  } else {
    await expect(main.getByText("Loading threads")).toBeAttached();
  }
  await expect(page.getByRole("region", { name: "Activity" }).getByText("KalCode started")).toBeVisible();
}

for (const theme of ["dark", "light"] as const) {
  for (const scenario of SCENARIOS) {
    test(`@dashboard-shots ${scenario} in ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(scenario === "unavailable" ? "/" : `/?scenario=${scenario}`);
      await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
      await setTheme(page, theme);
      await ready(page, scenario);
      for (const size of SIZES) {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.waitForTimeout(200);
        await page.screenshot({ path: path(`${scenario}-${theme}-${size.name}`) });
      }
      await page.setViewportSize({ width: 1440, height: 2400 });
      await page.waitForTimeout(200);
      await page.screenshot({ path: path(`${scenario}-${theme}-1440-full`) });
      await page.setViewportSize({ width: 1024, height: 2600 });
      await page.waitForTimeout(200);
      await page.screenshot({ path: path(`${scenario}-${theme}-1024-full`) });
    });
  }
}
