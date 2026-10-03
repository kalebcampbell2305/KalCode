import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("right-click submenu, keyboard focus and edge positioning", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Context thread" }).click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Thread actions" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Move to workspace" }).hover();
  await page.getByRole("menuitem", { name: "Destination" }).click();
  await expect(page.getByRole("status")).toHaveText("Documents created: 1");
  await page.getByRole("button", { name: "Context thread" }).focus();
  await page.keyboard.press("Shift+F10");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Documents created: 2");
  await page.setViewportSize({ width: 640, height: 480 });
  await page.getByRole("button", { name: "Context thread" }).evaluate((el) => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 635, clientY: 475 }));
  });
  const menu = page.getByRole("menu", { name: "Thread actions" });
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(640);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(480);
  const audit = await new AxeBuilder({ page }).include('[role="menu"]').analyze();
  expect(audit.violations).toEqual([]);
  await page.screenshot({ path: "test-results/context-menu.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Context thread" })).toBeFocused();
});
