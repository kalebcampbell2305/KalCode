import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Accessibility and truth labels for every stage component on the page, in both themes, with
 * and without reduced motion. Also fails on console errors (for example a CSP violation from an
 * inline style).
 */
const STAGE_URL = process.env.STAGE_URL ?? "/";
const COMPONENTS = [
  "try-kalcode",
  "scroll-story",
  "before-after",
  "provider-switch",
  "permission-modes",
  "kalvoice-demo",
  "demo-center",
];

for (const scheme of ["dark", "light"] as const) {
  for (const motion of ["no-preference", "reduce"] as const) {
    test.describe(`stage axe (${scheme}, motion ${motion})`, () => {
      test.use({ colorScheme: scheme, reducedMotion: motion, viewport: { width: 1440, height: 900 } });

      test("no serious or critical violations in the stage components", async ({ page }) => {
        await page.goto(STAGE_URL);
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        const present: string[] = [];
        for (const id of COMPONENTS) if ((await page.getByTestId(id).count()) > 0) present.push(id);
        test.skip(present.length === 0, `No stage components on ${STAGE_URL}`);
        // Bring each into view so lazy scripts initialise, then settle.
        for (const id of present) await page.getByTestId(id).first().scrollIntoViewIfNeeded();
        // Let one-time sequences (Before/After fold, intros) finish on screen, so contrast is
        // measured at rest (offscreen demos skip rendering, which also pauses their transitions).
        await page.waitForTimeout(1500);
        const ba = page.getByTestId("before-after");
        if ((await ba.count()) > 0) {
          await ba.scrollIntoViewIfNeeded();
          if (motion === "no-preference") await expect(ba).toHaveAttribute("data-state", "after", { timeout: 5000 });
          await page.waitForTimeout(900);
        }
        await page.evaluate(() => document.fonts.ready);
        let builder = new AxeBuilder({ page }).withTags([
          "wcag2a",
          "wcag2aa",
          "wcag21a",
          "wcag21aa",
          "wcag22aa",
          "best-practice",
        ]);
        for (const id of present) builder = builder.include(`[data-testid="${id}"]`);
        const results = await builder.analyze();
        const blocking = results.violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => ({ id: v.id, targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")) }));
        expect(blocking).toEqual([]);
      });
    });
  }
}

test.describe("stage truth labels and console", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("every demo carries Product preview · sample data, and nothing logs an error", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(STAGE_URL);
    let found = 0;
    for (const id of COMPONENTS) {
      const block = page.getByTestId(id);
      if ((await block.count()) === 0) continue;
      found += 1;
      await block.first().scrollIntoViewIfNeeded();
      await expect(block.first().getByTestId("stage-label").first()).toContainText("Product preview · sample data");
    }
    test.skip(found === 0, `No stage components on ${STAGE_URL}`);
    await page.waitForTimeout(1500);
    expect(errors).toEqual([]);
  });

  test("approval buttons keep the app order everywhere", async ({ page }) => {
    await page.goto(STAGE_URL);
    const cards = page.locator(".kc-approval");
    test.skip((await cards.count()) === 0, "No approval cards");
    const orders = await cards.evaluateAll((els) =>
      els.map((el) => Array.from(el.querySelectorAll(".kc-approval__actions > *")).map((b) => b.textContent?.trim())),
    );
    for (const order of orders) expect(order).toEqual(["Deny", "Allow for thread", "Approve once"]);
  });
});
