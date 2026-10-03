import { expect, test } from "@playwright/test";

test.describe("Owner analytics", () => {
  test("says Not connected, without an uncaught error, when the API is unreachable", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://api.kalcoded.com/**", (route) => route.abort("connectionrefused"));
    await page.goto("/owner/analytics");
    await expect(page.locator("[data-gate-title]")).toHaveText("Could not load");
    await expect(page.locator("[data-live]")).toHaveAttribute("data-state", "offline");
    await expect(page.locator("[data-live-label]")).toHaveText("Not connected");
    expect(errors).toEqual([]);
  });

  test("stops saying Connecting once a signed-out answer arrives", async ({ page }) => {
    await page.route("https://api.kalcoded.com/**", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        headers: {
          "access-control-allow-origin": route.request().headers().origin ?? "*",
          "access-control-allow-credentials": "true",
        },
        body: JSON.stringify({ error: "unauthorized" }),
      }),
    );
    await page.goto("/owner/analytics");
    await expect(page.locator("[data-gate-title]")).toHaveText("Owner sign-in required");
    await expect(page.locator("[data-live-label]")).toHaveText("Not connected");
  });
});
