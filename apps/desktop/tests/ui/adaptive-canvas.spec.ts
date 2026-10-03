import { expect, type Page, test } from "@playwright/test";

type MemoryWindow = Window & { __kalcodeMemory: { runningProcessCount(): number } };

const panes = (page: Page) => page.locator("[data-pane-id]:not([hidden])");
async function openCode(page: Page) {
  await page.goto("/?scenario=code");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await expect(panes(page)).toHaveCount(1);
}
async function task(page: Page, name: string) {
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${name} `) }).click();
}

test("task layouts, reversible Tidy and manual arrangement preserve the exact terminal view", async ({
  page,
}, testInfo) => {
  await openCode(page);
  const terminal = page.locator(".xterm").first();
  await expect(terminal).toBeVisible();
  const original = await terminal.elementHandle();
  const running = await page.evaluate(() => (window as unknown as MemoryWindow).__kalcodeMemory.runningProcessCount());
  await task(page, "Build");
  await expect(page.getByRole("tab", { name: "Browser", exact: true })).toBeVisible();
  expect(await original?.evaluate((node) => node.isConnected)).toBe(true);
  await page.getByRole("button", { name: "Tidy", exact: true }).click();
  await expect(page.getByRole("button", { name: "Undo Tidy", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo Tidy", exact: true }).click();
  expect(await original?.evaluate((node) => node.isConnected)).toBe(true);
  await task(page, "Debug");
  await expect(page.getByRole("tab", { name: "Activity", exact: true })).toBeVisible();
  const focused = page.locator("[data-pane-id][data-focused]");
  const before = await focused.getAttribute("data-pane-id");
  await page.keyboard.press("Control+Alt+ArrowRight");
  await page.keyboard.press("Control+Alt+Shift+H");
  expect(await original?.evaluate((node) => node.isConnected)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as MemoryWindow).__kalcodeMemory.runningProcessCount())).toBe(
    running,
  );
  const manual = await panes(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-pane-id")));
  await page.setViewportSize({ width: 1000, height: 720 });
  expect(await panes(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-pane-id")))).toEqual(
    manual,
  );
  expect(before).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("adaptive-canvas-debug.png") });
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("adaptive-canvas-layouts.png") });
});

test("many panes stay readable and keyboard focus reveals offscreen panes", async ({ page }) => {
  await openCode(page);
  for (let i = 0; i < 7; i++) await page.keyboard.press("Control+Alt+d");
  await expect(panes(page)).toHaveCount(8);
  const boxes = await panes(page).evaluateAll((nodes) =>
    nodes.map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
  );
  expect(boxes.every((box) => box.width >= 319 && box.height >= 219)).toBe(true);
  await page.keyboard.press("Control+Alt+t");
  await page.keyboard.press("Control+Alt+z");
  await expect(panes(page)).toHaveCount(8);
  const viewport = page.locator("[data-pane-canvas]");
  expect(await viewport.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await page.keyboard.press("Control+Alt+ArrowLeft");
  await expect(page.locator("[data-pane-id][data-focused]")).toBeInViewport();
});

test("workspace switching restores selected tabs, sizes and the focused pane", async ({ page }) => {
  await openCode(page);
  await page.keyboard.press("Control+Alt+d");
  const second = panes(page).nth(1);
  await second.getByRole("button", { name: "Add to pane 2" }).click();
  await page.getByRole("menuitem", { name: "Dashboard", exact: true }).click();
  const id = await second.getAttribute("data-pane-id");
  if (!id) throw new Error("Missing focused pane identity");
  await second.getByRole("tab", { name: "Dashboard", exact: true }).click();
  await page.getByRole("button", { name: /^Workspace\s/ }).click();
  await page.getByRole("menuitemradio", { name: /api-server/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "api-server" })).toBeVisible();
  await page.getByRole("button", { name: /^Workspace\s/ }).click();
  await page.getByRole("menuitemradio", { name: /kalcode-site/ }).click();
  await expect(page.locator("[data-pane-id][data-focused]")).toHaveAttribute("data-pane-id", id);
  await expect(
    page.locator(`[data-pane-id="${id}"]`).getByRole("tab", { name: "Dashboard", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("magnetic edge preview shows the actual placement before drop", async ({ page }, testInfo) => {
  await openCode(page);
  await page.keyboard.press("Control+Alt+d");
  const tab = panes(page).first().getByRole("tab").first();
  const source = await tab.boundingBox();
  const target = await panes(page).nth(1).boundingBox();
  if (!source || !target) throw new Error("Missing drag target");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width * 0.1, target.y + target.height * 0.5, { steps: 8 });
  const preview = page.locator('[data-zone="left"]');
  await expect(preview).toBeVisible();
  const proposed = await preview.boundingBox();
  await page.screenshot({ path: testInfo.outputPath("adaptive-canvas-snap-preview.png") });
  await page.mouse.up();
  await expect(panes(page)).toHaveCount(3);
  const placed = await page.locator("[data-pane-id][data-focused]").boundingBox();
  expect(placed?.width).toBeCloseTo(proposed?.width ?? 0, 0);
  expect(placed?.x).toBeCloseTo(proposed?.x ?? 0, 0);
});
