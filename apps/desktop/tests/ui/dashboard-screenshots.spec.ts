import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * Z7-W3 visual review: the live Dashboard and notification center in both themes at the owner's
 * reference window sizes (1366 → 3440 ultrawide). Output: apps/desktop/qa/screenshots/w3/.
 * Run: pnpm test:ui --grep @dashboard-shots
 */
const OUT = new URL("../../qa/screenshots/w3/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const SIZES = [
  { name: "1366", width: 1366, height: 768 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
  { name: "2560", width: 2560, height: 1440 },
  { name: "3440", width: 3440, height: 1440 },
] as const;

interface Scene {
  name: string;
  scenario: string;
  /** Brings the scene into its reviewed state once the Dashboard is ready. */
  prepare?: (page: Page) => Promise<void>;
}

const chip = (page: Page, label: string) =>
  page.getByRole("group", { name: "Filter agents" }).getByRole("button", { name: new RegExp(`^${label}, `) });

const SCENES: Scene[] = [
  { name: "agents-1", scenario: "dash-1" },
  { name: "agents-6", scenario: "dash-6" },
  { name: "agents-20", scenario: "dash-20" },
  { name: "agents-50", scenario: "dash-50" },
  { name: "mixed-providers", scenario: "busy" },
  {
    name: "by-provider",
    scenario: "busy",
    prepare: (page) =>
      page.getByRole("radiogroup", { name: "Group by" }).getByRole("radio", { name: "Provider" }).click(),
  },
  { name: "waiting", scenario: "busy", prepare: (page) => chip(page, "Waiting for you").click() },
  { name: "done", scenario: "busy", prepare: (page) => chip(page, "Done").click() },
  { name: "error", scenario: "errors" },
  { name: "empty", scenario: "empty" },
  {
    name: "notification-center",
    scenario: "busy",
    prepare: async (page) => {
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: /^Notifications/ })
        .click();
      await expect(page.getByRole("dialog", { name: "Notifications" }).getByRole("article").first()).toBeVisible();
    },
  },
];

function path(name: string) {
  return new URL(`${name}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("radiogroup", { name: "Theme" })
    .getByRole("radio", { name: theme === "light" ? "Light" : "Dark" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
}

for (const theme of ["dark", "light"] as const) {
  for (const scene of SCENES) {
    test(`@dashboard-shots ${scene.name} in ${theme} theme`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/?scenario=${scene.scenario}`);
      await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
      await setTheme(page, theme);
      await expect(page.getByRole("region", { name: "Activity" }).getByText("KalCode started").first()).toBeAttached();
      await scene.prepare?.(page);
      for (const size of SIZES) {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.waitForTimeout(250);
        await page.screenshot({ path: path(`${scene.name}-${theme}-${size.name}`) });
      }
    });
  }
}
