import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("asChild menu action receives keyboard focus and selects once", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Editor options" });
  await page.keyboard.press("Tab");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");

  const action = page.getByTestId("new-document");
  await expect(action).toHaveAttribute("role", "menuitem");
  await expect(action).toBeFocused();
  await expect(action).toContainText("Create a document");
  await expect(action).toContainText("Ctrl+N");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("status")).toHaveText("Documents created: 1");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("asChild radio items navigate, select, retain selection and return focus on Escape", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Editor options" });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("new-document")).toBeFocused();
  await page.keyboard.press("ArrowDown");

  const light = page.getByTestId("light-theme");
  const dark = page.getByTestId("dark-theme");
  await expect(light).toBeFocused();
  await expect(light).toHaveAttribute("role", "menuitemradio");
  await expect(light).toBeChecked();
  await expect(dark).not.toBeChecked();
  await page.keyboard.press("ArrowDown");
  await expect(dark).toBeFocused();
  await expect(dark).toContainText("Dim colors");
  await expect(dark).toContainText("Ctrl+D");
  await page.keyboard.press("Space");

  await expect(page.getByTestId("theme-value")).toHaveText("Theme: dark");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(light).not.toBeChecked();
  await expect(dark).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("tooltip combines the existing description with its hint and restores it on Escape", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Save document" });
  await expect(trigger).toHaveAccessibleDescription("Saves your current document.");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await expect(trigger).toHaveAccessibleDescription("Saves your current document. Save changes with Ctrl+S");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-describedby", "save-description");
  await expect(trigger).toHaveAccessibleDescription("Saves your current document.");
});

test("background toast arrivals retain keyboard focus and resume FIFO after blur", async ({ page }) => {
  await page.goto("/toast");
  const add = page.getByRole("button", { name: "Add notification" });
  for (let n = 1; n <= 4; n++) await add.click();
  const first = page.getByRole("listitem").filter({ hasText: "Notice 1" });
  const dismiss = first.getByRole("button", { name: "Dismiss notification" });
  await dismiss.focus();
  for (let n = 5; n <= 7; n++) {
    // Dispatch an arrival without moving keyboard focus, as background notifications do.
    await add.evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.getByText(`Notice ${n}`, { exact: true })).toBeVisible();
    await expect(dismiss).toBeFocused();
    await expect(page.getByRole("listitem")).toHaveCount(4);
    await expect(page.getByText(`Notice ${n - 3}`, { exact: true })).toHaveCount(0);
  }
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(first).toHaveCount(0);
  await expect(page.getByRole("listitem")).toHaveCount(4);
  await expect(page.getByText("Notice 8", { exact: true })).toBeVisible();
});
