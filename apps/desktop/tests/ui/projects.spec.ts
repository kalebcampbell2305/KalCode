import { expect, type Page, test } from "@playwright/test";

const projects = (page: Page) => page.getByRole("region", { name: "Projects" });
const rows = (page: Page) => projects(page).locator("li[data-project-id] > button:first-child");
async function open(page: Page) {
  await page.goto("/?scenario=code&channel=stable");
  await expect(projects(page).getByRole("button", { name: "kalcode-site", exact: true })).toBeVisible();
}
async function pin(page: Page, name: string) {
  await projects(page).getByRole("button", { name, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin Project", exact: true }).click();
  await expect(projects(page).getByRole("button", { name: `${name}, pinned`, exact: true })).toBeVisible();
}

test("Projects collapses immediately and remembers its choice across reload and sidebar width changes", async ({
  page,
}) => {
  await open(page);
  const toggle = projects(page).getByRole("button", { name: "Projects", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).first()).toBeHidden();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(rows(page).first()).toBeVisible();
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("pin, pointer reorder, keyboard reorder and unpin share the workspace pin order", async ({ page }) => {
  await open(page);
  await pin(page, "kalcode-site");
  await pin(page, "api-server");
  const a = projects(page).getByRole("button", { name: "kalcode-site, pinned", exact: true });
  const b = projects(page).getByRole("button", { name: "api-server, pinned", exact: true });
  await expect(rows(page).first()).toHaveAccessibleName("kalcode-site, pinned");
  const from = await b.boundingBox();
  const to = await a.boundingBox();
  if (!from || !to) throw new Error("Projects not laid out");
  await page.mouse.move(from.x + 35, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 35, to.y + to.height / 2, { steps: 8 });
  await expect(projects(page).locator('[data-drop="before"]')).toHaveCount(1);
  await page.mouse.up();
  await expect(rows(page).first()).toHaveAccessibleName("api-server, pinned");
  await expect(a).toHaveAttribute("aria-current", "true"); // Drag does not activate a project.
  await a.click();
  await expect(rows(page).first()).toHaveAccessibleName("api-server, pinned");
  await b.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Move pin down" }).click();
  await expect(rows(page).first()).toHaveAccessibleName("kalcode-site, pinned");
  await b.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpin Project", exact: true }).click();
  await expect(projects(page).locator("li[data-pinned]")).toHaveCount(1);
  await expect(rows(page).first()).toHaveAccessibleName("kalcode-site, pinned");
});

test("unavailable projects stay pinned and visible; escape cancels a drag", async ({ page }) => {
  await open(page);
  const missing = projects(page).getByRole("button", { name: /unavailable, folder not found/ });
  const missingBox = await missing.boundingBox();
  if (!missingBox) throw new Error("Unavailable project not laid out");
  await page.mouse.click(missingBox.x + 35, missingBox.y + 10, { button: "right" });
  await page.getByRole("menuitem", { name: "Pin Project", exact: true }).click();
  await expect(rows(page).first()).toHaveAccessibleName(/pinned, unavailable, folder not found/);
  await expect(projects(page).getByText("Unavailable", { exact: true })).toBeVisible();
  await pin(page, "kalcode-site");
  const from = await projects(page).getByRole("button", { name: "kalcode-site, pinned", exact: true }).boundingBox();
  const to = await missing.boundingBox();
  if (!from || !to) throw new Error("Projects not laid out");
  await page.mouse.move(from.x + 35, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(to.x + 35, to.y + 10, { steps: 8 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(rows(page).first()).toHaveAccessibleName(/pinned, unavailable, folder not found/);
  await expect(projects(page).locator("[data-drop]")).toHaveCount(0);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.screenshot({ path: "test-results/projects-pinned.png" });
});

test("pinned projects stay distinguishable in the narrow sidebar", async ({ page }) => {
  await open(page);
  await pin(page, "kalcode-site");
  await pin(page, "api-server");
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  const tiles = rows(page);
  await expect(tiles.first()).toHaveAccessibleName("kalcode-site, pinned");
  // Each tile shows its project's initial; the pin is a badge beside it, not a replacement.
  await expect(tiles.nth(0)).toContainText("K");
  await expect(tiles.nth(1)).toContainText("A");
  await expect(tiles.nth(0).locator("svg")).toHaveCount(1);
  await page.screenshot({
    path: "test-results/projects-narrow-pins.png",
    clip: { x: 0, y: 0, width: 260, height: 860 },
  });
});

test("clicking an unavailable project opens its menu, which removes it from KalCode", async ({ page }) => {
  await open(page);
  const missing = projects(page).getByRole("button", { name: /unavailable, folder not found/ });
  await expect(missing).toHaveCount(1);
  await missing.click();
  const remove = page.getByRole("menuitem", { name: /Remove from KalCode/ });
  await expect(remove).toBeVisible();
  await page.screenshot({ path: "test-results/projects-remove-unavailable.png" });
  await remove.click();
  await expect(projects(page).getByRole("button", { name: /unavailable, folder not found/ })).toHaveCount(0);
});
