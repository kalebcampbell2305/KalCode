import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { PAGES } from "../../src/lib/site";

const paths = [...PAGES.map((page) => page.path), "/this-page-does-not-exist"];

for (const scheme of ["dark", "light"] as const) {
  test.describe(`axe (${scheme} theme)`, () => {
    test.use({ colorScheme: scheme, reducedMotion: "reduce" });

    for (const path of paths) {
      test(`${path} has no serious or critical violations`, async ({ page }) => {
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        await page.evaluate(() => document.fonts.ready);
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
          .analyze();
        const blocking = results.violations
          .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
          .map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            targets: violation.nodes.map((node) => node.target.join(" ")),
          }));
        expect(blocking).toEqual([]);
      });
    }
  });
}

test.describe("axe with the mobile menu open", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("has no serious or critical violations", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Menu" }).click();
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(blocking.map((violation) => violation.id)).toEqual([]);
  });
});
