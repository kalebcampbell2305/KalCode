import { expect, test } from "@playwright/test";

for (const mode of ["unified", "split"] as const) {
  test(`manual scrolling keeps ${mode} rows bounded and the active row available`, async ({ page }) => {
    await page.goto(`/?mode=${mode}`);
    const grid = page.getByRole("grid", { name: "Harness changes" });
    const viewport = grid.locator("..");
    await grid.focus();
    const initialActive = await grid.getAttribute("aria-activedescendant");
    await viewport.hover();
    await page.mouse.wheel(0, 40_000);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(30_000);
    await expect.poll(() => grid.locator("tr").count()).toBeLessThan(120);
    await expect(grid).toHaveAttribute("aria-activedescendant", initialActive ?? "");
    await expect(grid.locator('[aria-rowindex="1"]')).toHaveCount(1);
    await expect(grid.locator('[aria-rowindex="1"]')).toContainText("crates/git/src/status.rs");
    const visibleRows = () =>
      grid.evaluate((el) => {
        const bounds = el.parentElement?.getBoundingClientRect();
        if (!bounds) return 0;
        return [...el.querySelectorAll("tr")].filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
        }).length;
      });
    await expect.poll(visibleRows).toBeGreaterThan(10);

    await page.keyboard.press("End");
    const lastActive = await grid.getAttribute("aria-activedescendant");
    await page.mouse.wheel(0, -80_000);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(0);
    await expect.poll(() => grid.locator("tr").count()).toBeLessThan(120);
    await expect(grid).toHaveAttribute("aria-activedescendant", lastActive ?? "");
    await expect(grid.locator('[data-active="true"]')).toContainText("fn gone() {}");
    await expect.poll(visibleRows).toBeGreaterThan(10);

    await page.keyboard.press("ArrowUp");
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(30_000);
    await expect(grid.locator('[data-active="true"]')).toContainText("@@ -1 +0,0 @@");
    await expect(grid.locator('[data-active="true"]')).toBeInViewport();
    await expect.poll(() => grid.locator("tr").count()).toBeLessThan(120);
  });
}
