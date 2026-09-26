import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function openUpdaterSettings(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  return page.getByRole("region", { name: "Updates" });
}

test.describe("signed desktop updates", () => {
  test("defaults to Stable and makes channel changes explicit", async ({ page }) => {
    const updates = await openUpdaterSettings(page);
    const channels = updates.getByRole("radiogroup", { name: "Update channel" });

    await expect(channels.getByRole("radio", { name: "Stable" })).toBeChecked();
    await expect(updates.getByText("Changing channel never installs anything by itself.")).toBeVisible();

    await channels.getByRole("radio", { name: "Beta" }).click();
    await expect(channels.getByRole("radio", { name: "Beta" })).toBeChecked();
    await expect(updates.getByText("Updates download in the background only after their signatures")).toBeVisible();
  });

  test("checks without installing and remains accessible in light mode", async ({ page }) => {
    const updates = await openUpdaterSettings(page);
    await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();

    await updates.getByRole("button", { name: "Check for updates" }).click();
    await expect(updates.getByText("KalCode is up to date")).toBeVisible();
    await expect(updates.getByRole("button", { name: /Restart and install/ })).toHaveCount(0);

    const results = await new AxeBuilder({ page })
      .include("#updates")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
    ).toEqual([]);
  });
});
