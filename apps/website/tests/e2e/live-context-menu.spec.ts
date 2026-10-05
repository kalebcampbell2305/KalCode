import { expect, type Page, test } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
async function openDemo(page: Page) {
  await page.goto("/");
  await page
    .getByRole("link", { name: /Try KalCode/ })
    .first()
    .click();
  await expect(page.locator("[data-live]")).toHaveAttribute("data-live", "ready");
  return page.locator("[data-live-app]");
}

test("context actions duplicate the clicked coding terminal and put Browser beside it", async ({ page }, testInfo) => {
  const app = await openDemo(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const tab = app.locator('[data-do="tab:t-a2"]');
  const count = await app.locator(".lk-tab").count();
  await tab.click({ button: "right" });
  await page.locator("[data-live]").screenshot({ path: testInfo.outputPath("context-menu-desktop.png") });
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await expect(app.locator(".lk-tab")).toHaveCount(count + 1);
  await expect(app.getByRole("button", { name: "Codex", exact: true }).first()).toBeVisible();
  await tab.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open Browser beside" }).click();
  const source = app.locator('[data-key="f2"]');
  await expect(source.locator("xpath=following-sibling::*[1]")).toHaveAttribute("data-kind", "browser");
  expect(errors).toEqual([]);
});

test("keyboard menus stop the selected agent and restore focus on Escape", async ({ page }) => {
  const app = await openDemo(page);
  const tab = app.locator('[data-do="tab:t-a1"]');
  await tab.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Dashboard Redesign actions" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(tab).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Stop", exact: true }).click();
  await tab.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Close", exact: true })).toBeVisible();
});

test("workspace context actions open the actual demo launcher", async ({ page }) => {
  const app = await openDemo(page);
  await app.locator('.lk-ctx__chip[data-do="go:code"] svg').click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /Deploy/ })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "New coding agent…" }).click();
  await expect(app.getByRole("dialog", { name: /New agent/ })).toBeVisible();
});

test("context actions preserve adaptive Tidy and Undo while revealing Browser beside Focus layout", async ({
  page,
}) => {
  const app = await openDemo(page);
  const source = app.locator('[data-canvas-frame="f1"]');
  await app.getByRole("button", { name: "Focus", exact: true }).click();
  await source.locator('[data-do="tab:t-a1"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open Browser beside" }).click();
  await expect(source).toBeVisible();
  await expect(source.locator("xpath=following-sibling::*[1]")).toHaveAttribute("data-kind", "browser");
  await expect(source.locator("xpath=following-sibling::*[1]")).toBeVisible();
  await app.getByRole("button", { name: "Tidy layout", exact: true }).click();
  await source.locator('[data-do="tab:t-a1"]').click({ button: "right" });
  const count = await app.locator(".lk-tab").count();
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await app.getByRole("button", { name: "Undo layout", exact: true }).click();
  await expect(app.locator(".lk-tab")).toHaveCount(count + 1);
  await expect(source).toBeVisible();
});

test("terminal output exposes only relevant content actions under production CSP", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const app = await openDemo(page);
  await app.locator('[data-key="f2"] .lk-term').click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Dashboard Tests output actions" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(1);
  await expect(menu.getByRole("menuitem", { name: "Copy relevant context" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Stop|Close|Duplicate/ })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Copy relevant context" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("Codex");
  expect(copied).not.toContain("Claude Code");
  await app.locator('[data-do="tab:t-a2"]').click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Duplicate", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile sample tabs retain keyboard context actions without page overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const app = await openDemo(page);
  const tab = app.locator('.lk-mtab[data-do="tab:t-a1"]');
  await tab.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu", { name: "Dashboard Redesign actions" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Open Browser beside" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
    0,
  );
  await page.locator("[data-live]").screenshot({ path: testInfo.outputPath("context-menu-mobile.png") });
});
