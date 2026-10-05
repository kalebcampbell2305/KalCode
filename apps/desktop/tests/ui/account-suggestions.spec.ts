import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("Code suggests a healthy account inline and waits for explicit confirmation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { __kalcodeMemory: { queueFolders: (...folders: string[]) => void } }
    ).__kalcodeMemory.queueFolders("account-suggestions");
  });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "Open folder…" }).first().click();
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  const launcher = page.getByRole("dialog", { name: "New agent" });
  await launcher.getByRole("group", { name: "Codex", exact: true }).getByRole("option", { name: /Work/ }).click();
  await launcher.getByRole("button", { name: "Reconnect" }).click();
  const source = page.locator("[data-provider-pane]").first();
  const sourceId = await source.getAttribute("data-provider-pane");
  const suggestion = source.getByRole("complementary", { name: "Account suggestion" });
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText("Work has 8% left in its weekly limit.");
  await expect(suggestion).toContainText("Personal · Signed in · 56% weekly remaining · Your default");
  await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
  await page.screenshot({ path: "qa/screenshots/account-suggestion-wide.png" });
  await page.setViewportSize({ width: 980, height: 720 });
  await expect(suggestion.getByRole("button", { name: "Continue with Personal?" })).toBeVisible();
  await page.screenshot({ path: "qa/screenshots/account-suggestion-compact.png" });
  await suggestion.getByRole("button", { name: "Continue with Personal?" }).click();
  const picker = page.getByRole("dialog", { name: "Account & usage" });
  await expect(picker.getByText(/starts a fresh coding session/)).toBeVisible();
  await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
  const accessibility = await new AxeBuilder({ page })
    .include('[aria-label="Account suggestion"]')
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(picker.getByRole("button", { name: "Start with Personal" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await suggestion.getByRole("button", { name: "Continue with Personal?" }).click();
  await picker.getByRole("button", { name: "Start with Personal" }).click();
  await expect(picker).not.toBeVisible();
  const next = page.locator(`[data-provider-pane]:not([data-provider-pane="${sourceId}"])`);
  await expect(next).toBeVisible();
  await expect(next.getByRole("button", { name: /Personal\. Switch Codex account/ })).toBeVisible();
  await expect(
    page
      .locator(`[data-provider-pane="${sourceId}"]`)
      .getByRole("button", { name: /Work\. Switch Codex account/, includeHidden: true }),
  ).toHaveCount(1);
  await expect(next.getByRole("complementary", { name: "Account suggestion" })).toHaveCount(0);
});
