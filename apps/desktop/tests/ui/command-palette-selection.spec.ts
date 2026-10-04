import { expect, type Page, test } from "@playwright/test";

async function openPalette(page: Page) {
  await page.goto("/?scenario=rail");
  await expect(page.locator("#main")).toHaveAttribute("data-surface", "code");
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Dashboard", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.keyboard.press("Control+k");
  return page.getByRole("dialog", { name: "Command palette" });
}

async function expectAccessibleSelection(page: Page) {
  await expect
    .poll(async () =>
      page.getByRole("dialog").evaluate((dialog) => {
        const selected = dialog.querySelector('[role="option"][aria-selected="true"]');
        const owners = [...dialog.querySelectorAll('[role="combobox"], [role="listbox"]')];
        return (
          owners.length === 2 &&
          owners.every((owner) => {
            const id = owner.getAttribute("aria-activedescendant");
            return selected ? id === selected.id && document.getElementById(id) === selected : !id;
          })
        );
      }),
    )
    .toBe(true);
}

test("async locator selection keeps both ARIA owners bound to the current option", async ({ page }) => {
  const dialog = await openPalette(page);
  const input = dialog.getByRole("combobox");
  await input.fill("Authentication Refactor");
  await expect(dialog.getByRole("option").first()).toContainText("Authentication Refactor");
  await expect(dialog.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await expectAccessibleSelection(page);
  await input.fill("zzzz-no-matching-result");
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await expectAccessibleSelection(page);
  await input.fill("Open folder");
  await expect(dialog.getByRole("option", { name: /Open folder/ })).toHaveAttribute("aria-selected", "true");
  await expectAccessibleSelection(page);
  await input.press("Escape");
  await page.keyboard.press("Control+k");
  await expect(dialog).toBeVisible();
  await expectAccessibleSelection(page);
});

test("arrow navigation survives the preferred-result correction", async ({ page }) => {
  const dialog = await openPalette(page);
  const input = dialog.getByRole("combobox");
  await input.fill("auth");
  // Files now participate in the universal ranking. Wait for local indexing, then
  // follow the selected entity's identity instead of assuming a fixed thread-first order.
  await expect(dialog.locator("footer")).toContainText("Search across your workspace");
  await expect(dialog.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  const id = (await dialog.getByRole("option").nth(1).getAttribute("id")) ?? "";
  const second = dialog.locator(`[id="${id}"]`);
  expect(id).not.toBe("");
  await input.press("ArrowDown");
  // Cross the frame where the old effect reselected the preferred first result.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect(second).toHaveAttribute("aria-selected", "true");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-activedescendant", id);
  await expectAccessibleSelection(page);
});

test("Enter honors deliberate command navigation and immediate named commands", async ({ page }) => {
  const dialog = await openPalette(page);
  const input = dialog.getByRole("combobox");
  await input.fill("theme");
  await expect(dialog.getByRole("option", { name: "Use light theme" })).toBeVisible();
  const firstTheme = await dialog
    .getByRole("option", { name: /^Use .* theme/ })
    .first()
    .innerText();
  const theme = firstTheme.includes("light") ? "dark" : "light";
  const target = dialog.getByRole("option", { name: `Use ${theme} theme` });
  await input.press("Home");
  for (let index = 0; index < (await dialog.getByRole("option").count()); index++) {
    if ((await target.getAttribute("aria-selected")) === "true") break;
    await input.press("ArrowDown");
  }
  await expect(target).toHaveAttribute("aria-selected", "true");
  await expectAccessibleSelection(page);
  await input.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.keyboard.press("Control+k");
  await input.fill("Use light theme");
  await input.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
