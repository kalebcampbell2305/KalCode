import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe("Account", () => {
  test("holds new paid purchases until the release is enabled", async ({ page }) => {
    await page.goto("/account");
    const purchases = page.locator("[data-checkout-tier]");
    await expect(purchases).toHaveCount(3);
    for (const purchase of await purchases.all()) await expect(purchase).toBeDisabled();
    await expect(page.locator("[data-billing-portal]")).toBeEnabled();
  });
  test("is a noindex passwordless account surface with truthful account boundaries", async ({ page }) => {
    const response = await page.goto("/account");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle("Account — KalCode");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "Your KalCode account" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "One account. No password to remember." })).toBeVisible();
    await expect(page.getByRole("button", { name: /Email my sign-in link/ })).toBeVisible();
    await expect(page.locator("main")).toContainText("Local Dictation");
    await expect(page.locator("main")).toContainText("Unlimited on every plan");
    await expect(page.locator("main")).toContainText("Handled by your connected provider");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test("fits desktop and mobile viewports", async ({ page }) => {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/account");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        `${width}px viewport`,
      ).toBeLessThanOrEqual(0);
      await expect(page.getByRole("button", { name: /Email my sign-in link/ })).toBeVisible();
    }
  });

  test("does not claim payment from an unconfirmed checkout query flag", async ({ page }) => {
    await page.route("https://api.kalcoded.com/**", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "unauthenticated" }),
      }),
    );
    await page.addInitScript(() => {
      window.setTimeout = ((handler: TimerHandler) => {
        queueMicrotask(() => {
          if (typeof handler === "function") handler();
        });
        return 1;
      }) as typeof window.setTimeout;
    });

    await page.goto("/account?checkout=success");
    await expect(page.locator("[data-account-status]")).toHaveText(
      "Your paid plan is not active yet. If checkout completed, Stripe may still be confirming it. Refresh in a moment.",
    );
    await expect(page.locator("main")).not.toContainText("Payment received");
  });
});
