import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1600, height: 900 } });

test("Thread right-click renames the clicked row without navigating to it", async ({ page }) => {
  await page.goto("/?scenario=threads");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Threads", exact: true }).click();
  const list = page.getByRole("list", { name: "Threads", exact: true });
  const row = list.getByRole("button", { name: /Write Unit Tests for Parser Module/ });
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
  const renamed = list.getByRole("button", { name: /Parser review/ });
  await expect(renamed).toBeVisible();
  await renamed.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await expect(list.getByRole("button", { name: /Parser review \(copy\)/ })).toBeVisible();
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
  const renamed = page.getByRole("tab", { name: /Build output/ });
  await expect(renamed).toBeVisible();
  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate terminal", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Stop terminal", exact: true }).click();
  await expect(renamed).toBeVisible();
  await renamed.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Stop terminal", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Close terminal", exact: true })).toBeVisible();
});
