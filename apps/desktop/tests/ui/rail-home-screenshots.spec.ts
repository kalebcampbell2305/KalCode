import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/**
 * Z7-W2 visual review: the workspace rail with many workspaces, Home (first run and returning),
 * the project page, search and the surfaces in panes, in both themes at the owner's reference window sizes
 * (1366 → 3440 ultrawide). Output: apps/desktop/qa/screenshots/w2/.
 * Run: pnpm test:ui --grep @w2-shots
 */
const OUT = new URL("../../qa/screenshots/w2/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const SIZES = [
  { name: "1366", width: 1366, height: 768 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
  { name: "2560", width: 2560, height: 1440 },
  { name: "3440", width: 3440, height: 1440 },
] as const;

const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name, exact: true });
const item = (page: Page, name: RegExp) =>
  page.getByRole("tree", { name: "Workspaces" }).getByRole("treeitem", { name });

interface Scene {
  name: string;
  scenario: string;
  prepare: (page: Page) => Promise<void>;
}

const SCENES: Scene[] = [
  {
    name: "home-returning",
    scenario: "home",
    prepare: async (page) => {
      await nav(page, "Home").click();
      await expect(page.getByRole("list", { name: "Recent work, today" })).toBeVisible();
    },
  },
  {
    name: "home-first-run",
    scenario: "",
    prepare: async (page) => {
      await nav(page, "Home").click();
      await expect(page.getByRole("heading", { level: 1, name: "Welcome to KalCode." })).toBeVisible();
    },
  },
  {
    name: "rail-project",
    scenario: "rail",
    prepare: async (page) => {
      await item(page, /^atlas-api/).click();
      await expect(page.getByRole("list", { name: "Changed files" })).toBeVisible();
      await page.getByRole("tree", { name: "Files" }).getByRole("treeitem", { name: "src, folder" }).click();
    },
  },
  {
    name: "rail-dashboard",
    scenario: "rail",
    prepare: async (page) => {
      await expect(item(page, /^kalcode, active workspace/)).toBeVisible();
    },
  },
  {
    name: "search",
    scenario: "rail",
    prepare: async (page) => {
      await page.keyboard.press("Control+k");
      await page.keyboard.type("auth");
      await expect(page.getByRole("option").first()).toContainText("Authentication Refactor");
    },
  },
  {
    name: "panes",
    scenario: "home",
    prepare: async (page) => {
      await item(page, /^atlas-api/).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Open project in a pane" }).click();
      await expect(page.getByRole("tab", { name: /^Project/ })).toBeVisible();
      await expect(page.locator('[role="menu"]')).toHaveCount(0);
      for (const name of ["Show Home in a pane", "Show Git status in a pane"]) {
        await page.keyboard.press("Control+k");
        await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
        await page.keyboard.type(name);
        await page.getByRole("option", { name }).click();
      }
      await expect(
        page.getByRole("tabpanel", { name: "Git" }).getByRole("list", { name: "Local branches" }),
      ).toBeVisible();
      await page.mouse.move(0, 0);
    },
  },
  {
    name: "rail-strip",
    scenario: "home",
    prepare: async (page) => {
      await nav(page, "Home").click();
      if ((await page.getByRole("tree", { name: "Workspaces" }).count()) > 0) {
        await page.keyboard.press("Control+Shift+B");
      }
      await expect(page.getByRole("navigation", { name: "Workspaces (collapsed rail)" })).toBeVisible();
    },
  },
];

async function setTheme(page: Page, theme: "light" | "dark") {
  await nav(page, "Settings").click();
  await page
    .getByRole("radiogroup", { name: "Theme" })
    .getByRole("radio", { name: theme === "light" ? "Light" : "Dark" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await nav(page, "Dashboard").click();
}

test.describe("@w2-shots", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const scene of SCENES) {
      test(`${scene.name} ${theme}`, async ({ page }) => {
        test.setTimeout(120_000);
        for (const size of SIZES) {
          await page.setViewportSize({ width: size.width, height: size.height });
          await page.goto(scene.scenario ? `/?scenario=${scene.scenario}` : "/");
          await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
          await setTheme(page, theme);
          // Under 1400 px the rail starts as a strip; rail scenes show it open.
          const strip = page.getByRole("navigation", { name: "Workspaces (collapsed rail)" });
          if (
            (scene.name.startsWith("rail-") || scene.name === "panes") &&
            scene.name !== "rail-strip" &&
            (await strip.count()) > 0
          ) {
            await strip.getByRole("button", { name: "Show the workspace rail" }).click();
          }
          await scene.prepare(page);
          await page.waitForTimeout(350);
          await page.screenshot({ path: fileURLToPath(new URL(`${scene.name}-${theme}-${size.name}.png`, OUT)) });
        }
      });
    }
  }
});
