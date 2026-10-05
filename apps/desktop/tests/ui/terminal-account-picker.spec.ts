import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("terminal header confirms a fresh account session and keeps the original account", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { __kalcodeMemory: { queueFolders: (...folders: string[]) => void } }
    ).__kalcodeMemory.queueFolders("account-picker");
  });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "Open folder…" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "account-picker" })).toBeVisible();
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  const launcher = page.getByRole("dialog", { name: "New agent" });
  await launcher.getByRole("group", { name: "Codex", exact: true }).getByRole("option", { name: /Work/ }).click();
  await launcher.getByRole("button", { name: "Reconnect" }).click();
  const source = page.locator("[data-provider-pane]").first();
  await expect(source).toBeVisible();
  const sourceId = await source.getAttribute("data-provider-pane");
  const identity = source.getByRole("button", { name: /Switch Codex account/ });
  const sourceLabel = await identity.getAttribute("aria-label");
  await identity.click();
  const picker = page.getByRole("dialog", { name: "Account & usage" });
  await expect(picker).toBeVisible();
  await expect(picker.getByText("Current", { exact: true })).toBeVisible();
  const options = picker.getByRole("group", { name: "Codex accounts" }).getByRole("button");
  await expect(options).toHaveCount(2);
  await options.filter({ hasNotText: "Current" }).click();
  await expect(picker.getByText(/starts a fresh coding session/)).toBeVisible();
  await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
  const accessibility = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({ path: "qa/screenshots/terminal-account-picker.png" });
  await picker.getByRole("button", { name: /^Start with/ }).click();
  await expect(picker).not.toBeVisible();
  const next = page.locator(`[data-provider-pane]:not([data-provider-pane="${sourceId}"])`);
  await expect(next).toBeVisible();
  await expect(next.getByRole("button", { name: /Switch Codex account/ })).not.toHaveAttribute(
    "aria-label",
    sourceLabel ?? "",
  );
  await expect(
    page
      .locator(`[data-provider-pane="${sourceId}"]`)
      .getByRole("button", { name: /Switch Codex account/, includeHidden: true }),
  ).toHaveAttribute("aria-label", sourceLabel ?? "");
});
