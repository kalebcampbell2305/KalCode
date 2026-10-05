import { expect, test } from "@playwright/test";

/**
 * The Activity widget's rows: a long event title shrinks with an ellipsis (full text on hover) and
 * never paints into the time column, at a wide and a narrow window.
 */
for (const width of [1440, 1024]) {
  test(`activity titles never overlap their time at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?scenario=code");
    await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
    await page.getByRole("button", { name: "Dashboard", exact: true }).click();
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity.getByText(/health: unknown/).first()).toBeVisible();
    const rows = activity.locator("li");
    expect(await rows.count()).toBeGreaterThan(0);
    const overlapping = await rows.evaluateAll(
      (items) =>
        items.filter((li) => {
          const title = li.querySelector("[title]");
          const time = li.querySelector("time");
          return title && time && title.getBoundingClientRect().right > time.getBoundingClientRect().left + 0.5;
        }).length,
    );
    expect(overlapping).toBe(0);
    // The full title stays available.
    const first = activity.locator("li [title]").first();
    await expect(first).toHaveAttribute("title", /.+/);
  });
}
