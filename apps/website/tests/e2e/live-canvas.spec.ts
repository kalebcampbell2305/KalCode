import { expect, test } from "@playwright/test";

const app = (page: import("@playwright/test").Page) => page.locator("[data-live-app]");
async function open(page: import("@playwright/test").Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  await page
    .getByRole("link", { name: /Try KalCode/ })
    .first()
    .click();
  await expect(page.locator("[data-live]")).toHaveAttribute("data-live", "ready");
  return errors;
}

/** The element's box once two consecutive reads agree (smooth scrolling and layout have settled). */
async function settledBox(page: import("@playwright/test").Page, locator: import("@playwright/test").Locator) {
  let previous = await locator.boundingBox();
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.waitForTimeout(25);
    const current = await locator.boundingBox();
    if (
      current &&
      previous &&
      current.x === previous.x &&
      current.y === previous.y &&
      current.width === previous.width &&
      current.height === previous.height
    )
      return current;
    previous = current;
  }
  throw new Error("element bounds never settled");
}

test("task layouts and Tidy preserve pane identity, drafts and newly opened work", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = await open(page);
  const first = app(page).locator('[data-canvas-frame="f1"]');
  const original = await first.elementHandle();
  const count = await app(page).locator(".lk-tab").count();
  const draft = app(page).getByRole("textbox", { name: "Command for PowerShell \u00b7 dev server" });
  await draft.fill("npm run build -- --watch");
  for (const name of ["Build", "Debug", "Review", "Ship", "Focus"]) {
    await app(page).getByRole("button", { name, exact: true }).click();
    expect(await original?.evaluate((node) => node.isConnected)).toBe(true);
    await expect(app(page).locator(".lk-tab")).toHaveCount(count);
  }
  await app(page).getByRole("button", { name: "Build", exact: true }).click();
  await first.getByRole("button", { name: /Minimize pane/ }).click();
  await expect(first).toBeHidden();
  await app(page).getByRole("button", { name: "Tidy layout", exact: true }).click();
  await expect(first).toBeVisible();
  await app(page).getByRole("button", { name: "New terminal", exact: true }).click();
  await app(page).getByRole("button", { name: "Undo layout", exact: true }).click();
  await expect(first).toBeHidden();
  await expect(app(page).locator(".lk-tab")).toHaveCount(count + 1);
  await expect(draft).toHaveValue("npm run build -- --watch");
  await expect(app(page).locator(".lk-adaptive [style]")).toHaveCount(0);
  await page.locator("[data-live]").screenshot({ path: "test-results/adaptive-canvas-desktop.png" });
  expect(errors).toEqual([]);
});

test("pointer preview, keyboard movement and resizing use the same canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = await open(page);
  const first = app(page).locator('[data-canvas-frame="f1"]');
  await first.focus();
  await page.keyboard.press("Control+Alt+Shift+L");
  await expect(app(page).locator("[data-canvas-frame]").first()).toHaveAttribute("data-canvas-frame", "f2");
  const range = app(page).getByRole("slider", { name: "Resize canvas columns" });
  await range.focus();
  await page.keyboard.press("ArrowRight");
  await expect(range).toHaveValue("60");
  await app(page).locator('[data-canvas-grip="f1"]').scrollIntoViewIfNeeded();
  // The page scrolls smoothly (critical.css), so measure only once the scroll has settled.
  const source = await settledBox(page, app(page).locator('[data-canvas-grip="f1"]'));
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  // Start the drag, then aim at where the target is now.
  await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2 + 12, { steps: 2 });
  const target = await settledBox(page, app(page).locator('[data-canvas-frame="f2"]'));
  // The drop side depends only on the horizontal position. Aim at the pane's vertical middle: its
  // top edge can sit under the sticky site header, depending on where focus scrolling settled.
  await page.mouse.move(target.x + 15, target.y + target.height / 2, { steps: 6 });
  await expect(app(page).locator('[data-canvas-frame="f2"]')).toHaveAttribute("data-canvas-snap", "before");
  await page.mouse.up();
  await expect(app(page).locator("[data-canvas-frame]").first()).toHaveAttribute("data-canvas-frame", "f1");
  expect(errors).toEqual([]);
});

test("phone canvas keeps a readable pane and restores minimized sessions with reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors = await open(page);
  await app(page)
    .getByRole("group", { name: "Panes", exact: true })
    .getByRole("button", { name: /Codex A/ })
    .click();
  await expect(app(page).getByRole("log", { name: "Codex A terminal" })).toBeVisible();
  const focused = app(page).locator("[data-canvas-frame]:not([hidden])");
  const bounds = await focused.boundingBox();
  expect(bounds?.width).toBeGreaterThanOrEqual(320);
  expect(bounds?.height).toBeGreaterThanOrEqual(220);
  await focused.getByRole("button", { name: /Minimize pane/ }).click();
  await app(page)
    .getByRole("button", { name: /Restore Codex/ })
    .click();
  await expect(app(page).getByRole("log", { name: "Codex A terminal" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator("[data-live]").screenshot({ path: "test-results/adaptive-canvas-mobile.png" });
  expect(errors).toEqual([]);
});
