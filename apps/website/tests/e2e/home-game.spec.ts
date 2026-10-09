import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`home introduces KAL University before the product story at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    const discovery = page.locator(".hero").getByRole("link", { name: "Discover KAL University" });
    await expect(discovery).toBeVisible();
    await expect(discovery).toBeInViewport();
    await expect(discovery).toHaveAttribute("href", "/games/kal-university");

    const feature = page.getByRole("region", { name: "KAL University", exact: true });
    await feature.scrollIntoViewIfNeeded();
    await expect(feature.getByText("Coming soon · Not on sale yet", { exact: true })).toBeVisible();
    const image = feature.getByRole("img");
    await expect(image).toHaveAttribute("loading", "lazy");
    await expect
      .poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0))
      .toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(
      await feature.evaluate((node) => {
        const story = document.querySelector(".story");
        return story !== null && Boolean(node.compareDocumentPosition(story) & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
    ).toBe(true);
    await feature.getByRole("link", { name: "Explore KAL University", exact: true }).click();
    await expect(page).toHaveURL(/\/games\/kal-university$/);
    await expect(page.locator("h1")).toContainText("University");
  });
}
