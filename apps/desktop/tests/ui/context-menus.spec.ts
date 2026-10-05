import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { goTo } from "./nav.ts";

/** A row, not the favorite (pin/star) button beside it, whose label repeats the row's name (#235). */
const NOT_FAVORITE = ":not([data-favorite-action])";

test.use({ viewport: { width: 1600, height: 900 } });

async function waitForFolderQueue(page: Page) {
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __kalcodeMemory?: { queueFolders?: (...names: string[]) => void } })
        .__kalcodeMemory?.queueFolders === "function",
  );
}

test("Fleet right-click renames its coding agent and opens Browser beside the same pane", async ({ page }) => {
  await page.goto("/");
  await waitForFolderQueue(page);
  await page.evaluate(() => {
    (
      window as unknown as { __kalcodeMemory: { queueFolders: (...names: string[]) => void } }
    ).__kalcodeMemory.queueFolders("fleet-menu");
  });
  const nav = page.getByRole("navigation", { name: "Primary" });
  await nav.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "Open folder…" }).first().click();
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New agent" })
    .getByRole("button", { name: "Launch Claude Code agent" })
    .click();
  await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
  await nav.getByRole("button", { name: "Activity", exact: true }).click();
  const card = page
    .getByRole("article")
    .filter({ has: page.locator("[data-kind=state]") })
    .first();
  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByRole("dialog", { name: "Rename agent" }).getByRole("textbox").fill("Context reviewer");
  await page.getByRole("dialog").getByRole("button", { name: "Save name" }).click();
  const renamed = page.getByRole("article", { name: "Context reviewer" });
  await expect(renamed).toBeVisible();
  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open Browser beside", exact: true }).click();
  await expect(page.locator("#main")).toHaveAttribute("data-surface", "code");
  await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /Browser/ })).toBeVisible();
});

test("Thread right-click renames the clicked row without navigating to it", async ({ page }) => {
  await page.goto("/?scenario=threads");
  await goTo(page, "Threads");
  const list = page.getByRole("list", { name: "Threads", exact: true });
  const row = list.getByRole("button", { name: /Write Unit Tests for Parser Module/ }).and(page.locator(NOT_FAVORITE));
  await row.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for Write Unit Tests for Parser Module" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Duplicate", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/context-thread.png" });
  const audit = await new AxeBuilder({ page }).include('[role="menu"]').analyze();
  expect(audit.violations).toEqual([]);
  await menu.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByRole("dialog", { name: "Rename thread" }).getByLabel("Thread name").fill("Parser review");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  const renamed = list.getByRole("button", { name: /Parser review/ }).and(page.locator(NOT_FAVORITE));
  await expect(renamed).toBeVisible();
  await renamed.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await expect(
    list.getByRole("button", { name: /Parser review \(copy\)/ }).and(page.locator(NOT_FAVORITE)),
  ).toBeVisible();
});

test("Workspace actions open at the target and unavailable actions stay absent", async ({ page }) => {
  await page.goto("/?scenario=rail");
  const tree = page.getByRole("tree", { name: "Workspaces", exact: true });
  const target = tree.getByRole("treeitem", { name: /^atlas-api/ });
  await target.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "New coding agent…", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Open Browser", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Deploy / release", exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/context-workspace.png" });
  await menu.getByRole("menuitem", { name: "Workspace settings…", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "atlas-api settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await tree.getByRole("treeitem", { name: /^old-prototype, folder missing/ }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "New coding agent…", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Open Browser", exact: true })).toHaveCount(0);
});

test("terminal tab rename, duplicate and stop act on the selected terminal", async ({ page }) => {
  await page.goto("/");
  await waitForFolderQueue(page);
  await page.evaluate(() => {
    (
      window as unknown as { __kalcodeMemory: { queueFolders: (...names: string[]) => void } }
    ).__kalcodeMemory.queueFolders("menu-workspace");
  });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "Open folder…" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "menu-workspace" })).toBeVisible();
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  const terminal = page
    .getByRole("tab")
    .filter({ hasText: /PowerShell|zsh|bash|Terminal/ })
    .first();
  await terminal.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open Browser beside", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/context-terminal.png" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Build output");
  await page.getByRole("dialog").getByRole("button", { name: /Save/ }).click();
  const renamed = page.getByRole("tab", { name: /^Build output(?: Ended)?$/ });
  await expect(renamed).toBeVisible();
  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "New like this", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: /Build output \(copy\)/ })).toBeVisible();
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  await page.screenshot({ path: "test-results/smart-duplicate-terminal.png" });
  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Stop terminal", exact: true }).click();
  await expect(renamed).toBeVisible();
  await renamed.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Stop terminal", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Close terminal", exact: true })).toBeVisible();
});
