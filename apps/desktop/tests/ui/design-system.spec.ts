import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * Z7-W0 design system: every restyled surface passes axe (WCAG 2.2 AA, incl. colour contrast) in
 * both themes, and the review screenshots at the Z7 window sizes. Screenshots only run with
 * `--grep @screenshots`; output: apps/desktop/qa/screenshots/w0/.
 */
const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function open(page: Page, scenario: string, theme: "dark" | "light") {
  await page.goto(scenario ? `/?scenario=${scenario}` : "/");
  // A returning user with an active workspace is sent to Code once restore finishes; choose
  // Dashboard explicitly so the check never races that redirect.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Dashboard", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type(`use ${theme} theme`);
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name, exact: true }).click();

async function expectAxeClean(page: Page, where: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    serious,
    `${where}: ${JSON.stringify(
      serious.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
      null,
      2,
    )}`,
  ).toEqual([]);
}

type Scene = { name: string; run: (page: Page, theme: "dark" | "light") => Promise<void> };

const SCENES: Scene[] = [
  {
    name: "dashboard-busy",
    run: async (page, theme) => {
      await open(page, "busy", theme);
    },
  },
  {
    name: "dashboard-empty",
    run: async (page, theme) => {
      await open(page, "empty", theme);
    },
  },
  {
    name: "approvals",
    run: async (page, theme) => {
      await open(page, "approvals", theme);
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: /^Approvals/ })
        .click();
      await expect(page.getByRole("dialog", { name: "Approvals" }).getByRole("region").first()).toBeVisible();
    },
  },
  {
    name: "code",
    run: async (page, theme) => {
      await open(page, "code", theme);
      await nav(page, "Code");
      await expect(page.getByRole("tab").first()).toBeVisible();
    },
  },
  {
    name: "threads-waiting",
    run: async (page, theme) => {
      await open(page, "threads", theme);
      await nav(page, "Threads");
      await page
        .getByRole("list", { name: "Threads" })
        .getByRole("button", { name: /Add Dark Mode Toggle/ })
        .click();
      await expect(page.getByText("Waiting for 1 permission decision")).toBeVisible();
    },
  },
  {
    name: "threads-new",
    run: async (page, theme) => {
      await open(page, "threads", theme);
      await nav(page, "Threads");
      await page.getByRole("button", { name: "New thread" }).first().click();
      await expect(page.getByRole("region", { name: "New thread" })).toBeVisible();
    },
  },
  {
    name: "providers",
    run: async (page, theme) => {
      await open(page, "", theme);
      await nav(page, "Providers");
      await page.getByRole("tab", { name: "Setup" }).click();
      await expect(page.getByText("Installed, version 2.1.282")).toBeVisible();
    },
  },
  {
    name: "settings",
    run: async (page, theme) => {
      await open(page, "approvals", theme);
      await nav(page, "Settings");
    },
  },
  {
    name: "kalvoice",
    run: async (page, theme) => {
      await open(page, "", theme);
      await nav(page, "KalVoice");
    },
  },
  {
    name: "gated",
    run: async (page, theme) => {
      await open(page, "", theme);
      await nav(page, "Agents");
    },
  },
];

test.describe("Z7-W0 design system accessibility", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`every restyled surface passes axe in ${theme} theme`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      for (const scene of SCENES) {
        await scene.run(page, theme);
        await expectAxeClean(page, `${scene.name} (${theme})`);
      }
    });
  }
});

const SIZES = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3440, height: 1440 },
] as const;

const OUT = new URL("../../qa/screenshots/w0/", import.meta.url);

for (const theme of ["dark", "light"] as const) {
  test(`@screenshots Z7-W0 surfaces in ${theme} theme at the Z7 window sizes`, async ({ page }) => {
    test.setTimeout(600_000);
    mkdirSync(OUT, { recursive: true });
    for (const size of SIZES) {
      await page.setViewportSize(size);
      for (const scene of SCENES) {
        await scene.run(page, theme);
        await page.waitForTimeout(200);
        await page.screenshot({
          path: new URL(`${scene.name}-${theme}-${size.width}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
        });
      }
    }
  });
}
