import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * Review screenshots of the Code surface in both themes at two window sizes.
 * Output: apps/desktop/qa/screenshots/ (git-ignored). Run: pnpm test:ui --grep @screenshots
 */
const OUT = new URL("../../qa/screenshots/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const SIZES = [
  { name: "1440", width: 1440, height: 900 },
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
  await page.waitForTimeout(200);
  await page.screenshot({ path: new URL(`${name}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
}

const code = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true });
const visibleTerminal = (page: Page) => page.locator('[role="tabpanel"]:not([hidden]) .xterm-rows');

for (const theme of ["dark", "light"] as const) {
  test(`@screenshots code surface in ${theme} theme`, async ({ page }) => {
    for (const size of SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });

      // Empty state with recent workspaces.
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
      await setTheme(page, theme);
      await code(page).click();
      await expect(page.getByRole("heading", { name: "Open a project folder" })).toBeVisible();
      await shot(page, `code-empty-${theme}-${size.name}`);

      // A workspace with running, colourful and ended tabs. A returning workspace opens directly in Code.
      await page.goto("/?scenario=code");
      await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
      await setTheme(page, theme);
      await page.getByRole("button", { name: "Activity", exact: true }).click();
      await expect(page.getByRole("region", { name: "Terminals" }).getByText("Git Bash")).toBeVisible();
      await shot(page, `dashboard-terminals-${theme}-${size.name}`);

      await code(page).click();
      await expect(visibleTerminal(page)).toContainText("First release");
      await page.locator('[role="tabpanel"]:not([hidden]) .xterm-screen').click();
      await page.keyboard.type("colors");
      await page.keyboard.press("Enter");
      await expect(visibleTerminal(page)).toContainText("bright7");
      await shot(page, `code-terminals-${theme}-${size.name}`);

      await page.getByRole("tab", { name: /Git Bash/ }).click();
      await expect(visibleTerminal(page)).toContainText("build.sh");
      await shot(page, `code-gitbash-${theme}-${size.name}`);

      await page.getByRole("tab", { name: /Command Prompt/ }).click();
      await expect(page.locator('[role="tabpanel"]:not([hidden])').getByRole("status")).toBeVisible();
      await shot(page, `code-ended-${theme}-${size.name}`);

      await page.getByRole("button", { name: /^Workspace\s/ }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await shot(page, `code-switcher-${theme}-${size.name}`);
      await page.getByRole("menuitemradio", { name: /api-server/ }).click();
      await expect(page.getByRole("heading", { name: "This terminal ended when KalCode closed" })).toBeVisible();
      await shot(page, `code-restored-${theme}-${size.name}`);

      await page.getByRole("button", { name: "Choose a shell" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await shot(page, `code-shells-${theme}-${size.name}`);
      await page.keyboard.press("Escape");
    }
  });
}
