import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const evidence = process.env.KALCODE_EVIDENCE_DIR;

for (const theme of ["dark", "light"] as const) {
  for (const mode of ["unified", "split"] as const) {
    test(`axe clean: ${theme} theme, ${mode} layout (focused)`, async ({ page }) => {
      await page.goto(`/?theme=${theme}&mode=${mode}`);
      const grid = page.getByRole("grid", { name: "Harness changes" });
      await expect(grid).toBeVisible();
      await grid.focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual(
        [],
      );
      if (evidence) await page.screenshot({ path: `${evidence}/diffview-${theme}-${mode}.png` });
    });
  }
}

test("keyboard navigation moves the active row and scrolls a virtualized diff", async ({ page }) => {
  await page.goto("/?theme=dark");
  const grid = page.getByRole("grid", { name: "Harness changes" });
  // Tab reaches the layout switch, then the grid.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Unified" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(grid).toBeFocused();
  const activeText = () =>
    grid.evaluate((el) => document.getElementById(el.getAttribute("aria-activedescendant") ?? "")?.textContent ?? "");
  expect(await activeText()).toContain("crates/git/src/status.rs");
  await page.keyboard.press("n");
  expect(await activeText()).toContain("@@ -10,7 +10,8 @@");
  await page.keyboard.press("n");
  expect(await activeText()).toContain("docs/guide.md");
  await page.keyboard.press("End");
  expect(await activeText()).toContain("fn gone() {}");
  expect(await grid.locator("tr").count()).toBeLessThan(200);
  expect(Number(await grid.getAttribute("aria-rowcount"))).toBeGreaterThan(3000);
  // The active row is actually on screen.
  const visible = await grid.evaluate((el) => {
    const row = document.getElementById(el.getAttribute("aria-activedescendant") ?? "");
    const viewport = el.parentElement;
    if (!row || !viewport) return false;
    const r = row.getBoundingClientRect();
    const v = viewport.getBoundingClientRect();
    return r.top >= v.top - 1 && r.bottom <= v.bottom + 1;
  });
  expect(visible).toBe(true);
  await page.keyboard.press("Home");
  expect(await activeText()).toContain("crates/git/src/status.rs");
});

test("layout switch is keyboard operable", async ({ page }) => {
  await page.goto("/?theme=light");
  await page.getByRole("radio", { name: "Unified" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Split" })).toBeChecked();
  await expect(page.getByRole("grid", { name: "Harness changes" })).toHaveAttribute("aria-colcount", "4");
});
