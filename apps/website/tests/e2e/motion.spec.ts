import { expect, test } from "@playwright/test";

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  for (const path of ["/", "/kalvoice", "/pricing", "/download"]) {
    test(`${path} runs no CSS animations and no smooth scrolling`, async ({ page }) => {
      await page.goto(path);
      await page.waitForTimeout(300);
      const running = await page.evaluate(() =>
        document
          .getAnimations()
          .filter((animation) => {
            const duration = Number(animation.effect?.getComputedTiming().duration ?? 0);
            return animation.playState === "running" && duration > 1;
          })
          .map((animation) => (animation as CSSAnimation).animationName ?? "transition"),
      );
      expect(running).toEqual([]);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
    });
  }
});
