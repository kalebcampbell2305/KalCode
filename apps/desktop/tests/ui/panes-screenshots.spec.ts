import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * Z7-W1 visual review: the Code pane canvas at 1366×768, 1440×900, 1920×1080, 2560×1440 and
 * 3440×1440, dark and light: 2, 4 and 6 panes, a maximized pane and a tiny pane.
 * Output: apps/desktop/qa/screenshots/w1/ (git-ignored), or KALCODE_SHOTS_DIR.
 * Run: pnpm test:ui --grep @w1-shots
 */
const OUT = process.env.KALCODE_SHOTS_DIR
  ? `${process.env.KALCODE_SHOTS_DIR.replace(/[\\/]$/, "")}/`
  : new URL("../../qa/screenshots/w1/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(OUT, { recursive: true });

const SIZES = [
  { name: "1366", width: 1366, height: 768 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
  { name: "2560", width: 2560, height: 1440 },
  { name: "3440", width: 3440, height: 1440 },
] as const;

const panes = (page: Page) => page.locator("[data-pane-id]:not([hidden])");
const pane = (page: Page, n: number) => panes(page).nth(n);

async function shot(page: Page, name: string) {
  // No hover tooltips in review shots; let xterm fit and the provider TUI settle.
  await page.mouse.move(1, 1);
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${OUT}${name}.png` });
}

async function start(page: Page, theme: "dark" | "light") {
  await page.goto("/?scenario=code");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  if (theme === "light") {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
}

async function claudePane(page: Page, prompt: string) {
  await page.getByRole("button", { name: "New Claude Code pane" }).click();
  const provider = page.locator("[data-provider-pane]").last();
  await expect(provider.locator("[data-pane-terminal] .xterm-rows")).toContainText("KalCode fake provider");
  await provider.locator("[data-pane-terminal] .xterm-screen").click();
  await page.keyboard.type(prompt);
  await page.keyboard.press("Enter");
  await expect(provider.locator("[data-pane-terminal] .xterm-rows")).toContainText("RAN");
}

for (const theme of ["dark", "light"] as const) {
  for (const size of SIZES) {
    test(`@w1-shots panes ${theme} ${size.name}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: size.width, height: size.height });
      await start(page, theme);
      const tag = `${theme}-${size.name}`;

      // 2 panes: the workspace's terminals beside Claude Code (the real CLI's TUI; the fake here).
      await claudePane(page, "run npm test");
      await expect(panes(page)).toHaveCount(2);
      await shot(page, `panes-2-${tag}`);

      // 4 panes: a grid; a second shell and a second Claude Code pane fill the new panes.
      await page.keyboard.press("Control+Alt+4");
      await expect(panes(page)).toHaveCount(4);
      await pane(page, 2)
        .getByRole("button", { name: /^New .+ terminal$/ })
        .click();
      await expect(pane(page, 2).locator('[role="tabpanel"] .xterm-rows')).toContainText("kalcode-site");
      await pane(page, 3)
        .locator("[data-pane-body]")
        .click({ position: { x: 12, y: 12 } });
      await claudePane(page, "run npm test");
      await shot(page, `panes-4-${tag}`);

      // Maximized: one pane fills the canvas; the others keep running.
      await pane(page, 1).locator('[role="tab"][aria-selected="true"]').click();
      await page.keyboard.press("Control+Alt+Enter");
      await expect(panes(page)).toHaveCount(1);
      await shot(page, `panes-maximized-${tag}`);
      await page.keyboard.press("Control+Alt+Enter");
      await expect(panes(page)).toHaveCount(4);

      // Tiny pane: the first divider pushed to its minimum.
      const divider = page.getByRole("separator").first();
      await divider.focus();
      await page.keyboard.press("Home");
      await shot(page, `panes-tiny-${tag}`);
      await page.keyboard.press("Enter");

      // 6 panes: two rows of three; one pane left empty shows what can be opened there.
      await page.keyboard.press("Control+Alt+6");
      await expect(panes(page)).toHaveCount(6);
      await pane(page, 4)
        .getByRole("button", { name: /^New .+ terminal$/ })
        .click();
      await expect(pane(page, 4).locator('[role="tabpanel"] .xterm-rows')).toContainText("kalcode-site");
      await shot(page, `panes-6-${tag}`);

      // The live Dashboard (Z7-W3) docked into the last pane beside the work.
      await pane(page, 5).getByRole("button", { name: "Add to pane 6" }).click();
      await page.getByRole("menuitem", { name: "Dashboard" }).click();
      await expect(pane(page, 5).locator("[data-dashboard-pane]")).toBeVisible();
      await shot(page, `panes-dashboard-${tag}`);
    });
  }
}
