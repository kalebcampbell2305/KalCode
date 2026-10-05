import { expect, type Page, test } from "@playwright/test";
import { goTo } from "./nav.ts";

const MOD = process.platform === "darwin" ? "Meta" : "Control";
const BACK = process.platform === "darwin" ? "Meta+[" : "Alt+ArrowLeft";
const FORWARD = process.platform === "darwin" ? "Meta+]" : "Alt+ArrowRight";
const surface = (page: Page) => page.locator("#main");
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

async function openCode(page: Page) {
  await page.goto("/?scenario=code");
  await expect(surface(page)).toHaveAttribute("data-surface", "code");
  await expect(page.locator(".xterm-helper-textarea").first()).toBeVisible();
}

async function search(page: Page, query: string) {
  await page.keyboard.press(`${MOD}+k`);
  await expect(palette(page)).toBeVisible();
  await palette(page).getByRole("combobox").fill(query);
}

test("Back and Forward retrace surfaces without replacing the live terminal", async ({ page }) => {
  await openCode(page);
  const input = page.locator(".xterm-helper-textarea").first();
  await input.focus();
  await page.keyboard.type("echo navigation-keeps-this-session");
  await page.keyboard.press("Enter");
  const terminal = page.locator(".xterm").first();
  await expect(terminal).toContainText("navigation-keeps-this-session");
  const node = await terminal.elementHandle();
  expect(node).not.toBeNull();
  const processes = await page.evaluate(() =>
    (window as unknown as { __kalcodeMemory: { runningProcessCount(): number } }).__kalcodeMemory.runningProcessCount(),
  );

  await goTo(page, "Providers");
  await expect(surface(page)).toHaveAttribute("data-surface", "providers");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(surface(page)).toHaveAttribute("data-surface", "settings");
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(surface(page)).toHaveAttribute("data-surface", "providers");
  await page.keyboard.press(BACK);
  await expect(surface(page)).toHaveAttribute("data-surface", "code");
  await expect(input).toBeFocused();
  expect(await node?.evaluate((element) => element.isConnected && element === document.querySelector(".xterm"))).toBe(
    true,
  );
  await expect(terminal).toContainText("navigation-keeps-this-session");
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { __kalcodeMemory: { runningProcessCount(): number } }
      ).__kalcodeMemory.runningProcessCount(),
    ),
  ).toBe(processes);

  await page.keyboard.press(FORWARD);
  await expect(surface(page)).toHaveAttribute("data-surface", "providers");
  await page.getByRole("button", { name: "Go forward", exact: true }).click();
  await expect(surface(page)).toHaveAttribute("data-surface", "settings");
  await expect(page.getByRole("button", { name: "Go forward", exact: true })).toBeDisabled();
});

test("workspace history keeps Browser identity, address and terminal alive", async ({ page }) => {
  await openCode(page);
  const terminal = await page.locator(".xterm").first().elementHandle();
  await page.getByRole("button", { name: "Split pane 1 right", exact: true }).click();
  await page.getByRole("button", { name: "Open Browser", exact: true }).click();
  const browser = page.locator("[data-browser-id]").first();
  await expect(browser.getByLabel("Web address")).toHaveValue("http://localhost:3000/");
  const browserId = await browser.getAttribute("data-browser-id");
  const browserNode = await browser.elementHandle();
  await browser.getByLabel("Web address").fill("https://example.test/navigation");
  await browser.getByLabel("Web address").press("Enter");
  await expect(browser.getByLabel("Web address")).toHaveValue("https://example.test/navigation");

  await page.evaluate(() => {
    (
      window as unknown as { __kalcodeMemory: { queueFolders(...folders: string[]): void } }
    ).__kalcodeMemory.queueFolders("navigation-second");
  });
  await search(page, "Open folder");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "navigation-second", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(page.getByRole("heading", { name: "kalcode-site", level: 1 })).toBeVisible();
  await expect(browser).toHaveAttribute("data-browser-id", browserId ?? "");
  await expect(browser.getByLabel("Web address")).toHaveValue("https://example.test/navigation");
  expect(await browserNode?.evaluate((element) => element.isConnected)).toBe(true);
  expect(await terminal?.evaluate((element) => element.isConnected)).toBe(true);
});

test("quick switcher opens the exact setting and recent navigation returns to it", async ({ page }) => {
  await openCode(page);
  await search(page, "diagnostics");
  await palette(page).getByRole("option").filter({ hasText: "Diagnostics" }).first().click();
  await expect(surface(page)).toHaveAttribute("data-surface", "settings");
  await expect(page.locator("#diagnostics")).toBeInViewport();
  await goTo(page, "Providers");
  await page.getByRole("button", { name: "Recent navigation", exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: "Diagnostics" }).first().click();
  await expect(surface(page)).toHaveAttribute("data-surface", "settings");
  await expect(page.locator("#diagnostics")).toBeInViewport();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Diagnostics");
});

test("navigation and universal results fit desktop and compact windows", async ({ page }, testInfo) => {
  await openCode(page);
  for (const width of [1360, 960]) {
    await page.setViewportSize({ width, height: 860 });
    await expect(page.getByRole("button", { name: "Open quick switcher", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`navigation-${width}.png`) });
    await page.getByRole("button", { name: "Open quick switcher", exact: true }).click();
    await expect(palette(page)).toBeVisible();
    await palette(page).getByRole("combobox").fill("kalcode");
    await expect(palette(page).getByRole("option").first()).toBeVisible();
    const bounds = await palette(page).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`quick-switcher-${width}.png`) });
    await page.keyboard.press("Escape");
  }
});
