import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * Every surface fills the area right of the sidebar at any window size (no narrow column with
 * an empty right side), while prose keeps a readable measure. Screenshots at five window sizes
 * in both themes are written to apps/desktop/qa/screenshots/layout/ for review
 * (`pnpm test:ui --grep @layout-shots`).
 */
const OUT = new URL("../../qa/screenshots/layout/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const SIZES = [
  { name: "1366", width: 1366, height: 768 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
  { name: "2560", width: 2560, height: 1440 },
  { name: "3440", width: 3440, height: 1440 },
] as const;

type Surface = "dashboard" | "code" | "threads" | "providers" | "settings";

/** Opens a surface in a state with content, and returns the element that holds its content. */
async function openSurface(page: Page, surface: Surface) {
  const nav = (name: string) =>
    page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name, exact: true });
  switch (surface) {
    case "dashboard":
      await page.goto("/?scenario=busy");
      await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Activity" }).getByText("KalCode started")).toBeVisible();
      return page.locator("#main [data-page-content]");
    case "code":
      await page.goto("/?scenario=code");
      await nav("Code").click();
      await expect(page.locator('[role="tabpanel"]:not([hidden]) .xterm-rows')).toContainText("First release");
      return page.locator('[role="tabpanel"]:not([hidden])');
    case "threads":
      await page.goto("/?scenario=threads");
      await nav("Threads").click();
      await expect(
        page.getByRole("region", { name: "Thread", exact: true }).getByText("Run npm test").first(),
      ).toBeVisible();
      return page.getByRole("region", { name: "Thread", exact: true });
    case "providers":
      await page.goto("/");
      await nav("Providers").click();
      await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();
      // Accounts is the default tab; the width check uses Setup's widest content.
      await page.getByRole("tab", { name: "Setup" }).click();
      await expect(
        page.getByRole("region", { name: "Claude Code", exact: true }).getByText(/^Installed/),
      ).toBeVisible();
      return page.locator("#main [data-page-content]");
    case "settings":
      await page.goto("/");
      await page.getByRole("button", { name: "Settings" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
      return page.locator("#main [data-page-content]");
  }
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type(`use ${theme} theme`);
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

const SURFACES: readonly Surface[] = ["dashboard", "code", "threads", "providers", "settings"];

for (const surface of SURFACES) {
  test(`${surface} fills the window at 2560 wide`, async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    const content = await openSurface(page, surface);
    const box = await content.boundingBox();
    if (!box) throw new Error("content not rendered");
    const { width, padding } = await page.evaluate(() => {
      const main = document.getElementById("main") as HTMLElement;
      const style = getComputedStyle(document.documentElement);
      return {
        width: main.getBoundingClientRect().right,
        padding: Number.parseFloat(style.getPropertyValue("--page-px")) * 16 || 32,
      };
    });
    // The content reaches the right edge of the window, give or take the page padding and the
    // scroll bar gutter.
    expect(box.x + box.width).toBeGreaterThanOrEqual(width - padding - 20);
  });
}

test("the terminal refits when the window grows", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const panel = await openSurface(page, "code");
  const widths = async () =>
    panel.evaluate((el) => ({
      panel: el.getBoundingClientRect().width,
      screen: (el.querySelector(".xterm-screen") as HTMLElement).getBoundingClientRect().width,
    }));
  const small = await widths();
  await page.setViewportSize({ width: 3440, height: 1440 });
  await expect.poll(async () => (await widths()).screen).toBeGreaterThan(small.screen * 2);
  const large = await widths();
  // xterm uses whole character cells, so up to one cell plus padding stays unused.
  expect(large.screen).toBeGreaterThan(large.panel - 48);
});

for (const theme of ["dark", "light"] as const) {
  for (const surface of SURFACES) {
    test(`@layout-shots ${surface} in ${theme} theme`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await openSurface(page, surface);
      await setTheme(page, theme);
      for (const size of SIZES) {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.waitForTimeout(250);
        await page.screenshot({
          path: new URL(`${surface}-${theme}-${size.name}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
        });
      }
    });
  }
}
