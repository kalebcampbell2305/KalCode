import { expect, type Page, test } from "@playwright/test";

const running = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __kalcodeMemory: { runningProcessCount(): number };
      }
    ).__kalcodeMemory.runningProcessCount(),
  );

async function openCode(page: Page) {
  await page.goto("/?scenario=code");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.getByRole("heading", { name: "kalcode-site", exact: true })).toBeVisible();
}

test("Cancel preserves unsent input; Stop and Close ends the owned shell", async ({ page }, testInfo) => {
  await openCode(page);
  const tab = page.getByRole("tab", { name: /^PowerShell 7$/ });
  await tab.click();
  await page.locator(".xterm-screen:visible").click();
  await page.keyboard.type("echo keep this unsent");
  const before = await running(page);
  await page.keyboard.press("Control+Shift+W");
  const dialog = page.getByRole("alertdialog", { name: "Close active work?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("smart-close-dark.png") });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(tab).toBeVisible();
  expect(await running(page)).toBe(before);
  await expect(page.locator(".xterm-rows:visible")).toContainText("echo keep this unsent");
  await tab.locator("[data-tab-close]").click();
  await expect(page.getByRole("alertdialog")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Keep Running", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Stop and Close", exact: true }).click();
  await expect(tab).toHaveCount(0);
  await expect.poll(() => running(page)).toBe(before - 1);
  await expect(page.getByRole("button", { name: /in background/ })).toHaveCount(0);
});

test("one decision closes all active tabs in a pane", async ({ page }) => {
  await openCode(page);
  const before = await running(page);
  await page.getByRole("button", { name: "Close pane 1" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Close active work?" });
  await expect(dialog).toBeVisible();
  expect(await running(page)).toBe(before);
  await dialog.getByRole("button", { name: "Stop and Close", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect.poll(() => running(page)).toBe(0);
  await expect(page.getByRole("tab")).toHaveCount(0);
});

test("an ended shell closes immediately without confirmation", async ({ page }) => {
  await openCode(page);
  await page.getByRole("tab", { name: /^PowerShell 7$/ }).click();
  await page.locator(".xterm-screen:visible").click();
  await page.keyboard.type("exit 0");
  await page.keyboard.press("Enter");
  const tab = page.getByRole("tab", { name: /PowerShell 7.*Ended/ });
  await expect(tab).toBeVisible();
  await tab.locator("[data-tab-close]").click();
  await expect(tab).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
