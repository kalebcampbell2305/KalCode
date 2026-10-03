import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/** KalCode account display name: edited inline in Settings → KalCode account (Account & plan). */
test.describe("KalCode account display name", () => {
  test("edit → save shows the new name in Account Hub and the account panel at once", async ({ page }) => {
    await page.goto("/?scenario=account-ready");
    const hub = page.getByRole("button", { name: /^Account:/ });
    await expect(hub).toHaveAccessibleName("Account: owner, Free plan");

    await hub.click();
    await page.getByRole("menuitem", { name: "Account & plan" }).click();
    const panel = page.getByRole("region", { name: "KalCode account" });
    const field = panel.getByRole("textbox", { name: "Display name" });
    await expect(field).toHaveAttribute("placeholder", "owner");

    await field.fill("Kaleb Campbell");
    await panel.getByRole("button", { name: "Save" }).click();
    await expect(hub).toHaveAccessibleName("Account: Kaleb Campbell, Free plan");
    await expect(hub).toContainText("KC");
    await expect(panel.getByRole("status")).toHaveText("Saved");

    // Renaming again ("Kaleb Campbell" → "Kaleb") with Enter.
    await field.fill("Kaleb");
    await field.press("Enter");
    await expect(hub).toHaveAccessibleName("Account: Kaleb, Free plan");
    await hub.click();
    await expect(page.getByRole("menu")).toContainText("Kaleb");
    await expect(page.getByRole("menu")).toContainText("owner@example.com");
    await page.keyboard.press("Escape");

    // The email, plan and sign-in are untouched.
    await expect(panel).toContainText("owner@example.com");
    await expect(panel).toContainText("Free");

    // An invalid name is explained and never sent; Escape restores the saved name.
    await field.fill("x".repeat(65));
    await expect(panel).toContainText("Use at most 64 characters.");
    await expect(panel.getByRole("button", { name: "Save" })).toBeDisabled();
    await field.press("Escape");
    await expect(field).toHaveValue("Kaleb");

    // Clearing falls back to the email name.
    await field.fill("");
    await panel.getByRole("button", { name: "Save" }).click();
    await expect(hub).toHaveAccessibleName("Account: owner, Free plan");

    const results = await new AxeBuilder({ page })
      .include('[data-testid="account-display-name"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
    ).toEqual([]);
  });
});
