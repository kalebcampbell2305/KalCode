import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function activateFree(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("textbox", { name: "Email" }).fill("owner@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.getByRole("button", { name: "I've verified my email" }).click();
  await expect(page.getByRole("heading", { name: "Choose your plan" })).toBeVisible();
  await page.getByRole("button", { name: "Continue with Free" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
}

test.describe("desktop account authority", () => {
  test("gates the workspace through onboarding, logout, and clean relogin", async ({ page }) => {
    await page.goto("/?scenario=account-fresh");
    await expect(page.getByRole("heading", { name: "Welcome to KalCode" })).toBeVisible();
    await activateFree(page);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const account = page.getByRole("region", { name: "KalCode account" });
    await expect(account).toContainText("owner@example.com");
    await expect(account).toContainText("Free");
    await account.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Welcome to KalCode" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toHaveCount(0);

    await activateFree(page);
  });

  test("keeps signed offline authority visible and accessible", async ({ page }) => {
    await page.goto("/?scenario=account-offline-grace");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Using verified offline access" })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(
      results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
    ).toEqual([]);
  });
});
