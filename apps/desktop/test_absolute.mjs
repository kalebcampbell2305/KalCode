const { test, expect } = await import("@playwright/test");

test('test with absolute URL', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${process.env.KALCODE_UI_TEST_PORT || 1467}/`);
  await expect(page).toHaveTitle("KalCode");
});
