import { expect, type Locator, type Page, test } from "@playwright/test";

const panes = (page: Page) => page.locator("[data-pane-id]:not([hidden])");
const focusedPane = (page: Page) => page.locator('[data-pane-id][data-focused][aria-current="true"]');

async function openCode(page: Page) {
  await page.goto("/?scenario=code&transcript=write%20a%20short%20comment");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
  await expect(panes(page)).toHaveCount(1);
}

async function focusAppearance(pane: Locator) {
  return pane.evaluate((element) => {
    const frame = getComputedStyle(element);
    const header = getComputedStyle(element.querySelector("header") as HTMLElement);
    return {
      borderColor: frame.borderColor,
      boxShadow: frame.boxShadow,
      headerBackground: header.backgroundImage,
      transitionDuration: frame.transitionDuration,
    };
  });
}

test.describe("active pane focus", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`pointer and keyboard focus select exactly one pane in ${theme} theme`, async ({ page }) => {
      await openCode(page);
      await page.locator("html").evaluate((element, value) => element.setAttribute("data-theme", value), theme);
      await page.keyboard.press("Control+Alt+d");
      await expect(panes(page)).toHaveCount(2);

      const first = panes(page).nth(0);
      const second = panes(page).nth(1);
      await expect(focusedPane(page)).toHaveCount(1);
      await expect(second).toHaveAttribute("aria-current", "true");
      await expect(first).not.toHaveAttribute("aria-current", "true");

      const inactiveAppearance = await focusAppearance(first);
      const activeAppearance = await focusAppearance(second);
      expect(activeAppearance.borderColor).not.toBe(inactiveAppearance.borderColor);
      expect(activeAppearance.boxShadow).not.toBe(inactiveAppearance.boxShadow);
      expect(activeAppearance.headerBackground).not.toBe(inactiveAppearance.headerBackground);
      expect(
        activeAppearance.transitionDuration.split(",").every((duration) => Number.parseFloat(duration) === 0),
      ).toBe(true);

      await first.click({ position: { x: 12, y: 52 } });
      await expect(focusedPane(page)).toHaveAttribute("data-pane-id", (await first.getAttribute("data-pane-id")) ?? "");
      await expect(first).toHaveAttribute("aria-current", "true");
      await expect(second).not.toHaveAttribute("aria-current", "true");

      await page.keyboard.press("Control+Alt+ArrowRight");
      await expect(focusedPane(page)).toHaveAttribute(
        "data-pane-id",
        (await second.getAttribute("data-pane-id")) ?? "",
      );
      await expect(second).toHaveAttribute("aria-current", "true");
    });
  }

  test.describe("with motion", () => {
    test.use({ contextOptions: { reducedMotion: "no-preference" } });

    test("focusing a terminal plays one edge trace; unfocused terminals stay neutral", async ({ page }) => {
      await openCode(page);
      await page.keyboard.press("Control+Alt+d");
      const first = panes(page).nth(0);
      const second = panes(page).nth(1);
      const trace = (pane: Locator) =>
        pane.evaluate((element) => {
          const after = getComputedStyle(element, "::after");
          return { content: after.content, name: after.animationName, iterations: after.animationIterationCount };
        });

      await first.locator(".xterm-screen").click();
      await expect(first).toHaveAttribute("data-terminal", "true");
      const lit = await trace(first);
      expect(lit.content).not.toBe("none");
      expect(lit.name).toContain("pane-trace");
      expect(lit.iterations).toBe("1");
      expect((await trace(second)).content).toBe("none");

      await second.getByRole("button", { name: "New PowerShell 7 terminal" }).click();
      await expect(second).toHaveAttribute("data-terminal", "true");
      await expect(second).toHaveAttribute("data-focused", "true");
      expect((await trace(second)).name).toContain("pane-trace");
      expect((await trace(first)).content).toBe("none");
    });
  });

  test("KalVoice keeps the captured pane visibly targeted while focus moves", async ({ page }) => {
    await openCode(page);
    await page.keyboard.press("Control+Alt+d");
    const first = panes(page).nth(0);
    const second = panes(page).nth(1);

    await first.locator(".xterm-screen").click();
    await expect(first).toHaveAttribute("data-focused", "true");
    const focusedAppearance = await focusAppearance(first);

    await page.keyboard.down("F8");
    await expect(page.getByRole("region", { name: "KalVoice widget" })).toHaveAttribute("data-phase", "listening");
    await expect(first).toHaveAttribute("data-kalvoice-target", "listening");
    await expect(page.getByRole("status").filter({ hasText: "KalVoice is listening to PowerShell 7." })).toHaveCount(1);
    expect((await focusAppearance(first)).boxShadow).not.toBe(focusedAppearance.boxShadow);

    await second.click({ position: { x: 12, y: 52 } });
    await expect(second).toHaveAttribute("data-focused", "true");
    await expect(first).toHaveAttribute("data-kalvoice-target", "listening");
    await expect(second).not.toHaveAttribute("data-kalvoice-target", "listening");

    await page.keyboard.press("Escape");
    await page.keyboard.up("F8");
    await expect(first).not.toHaveAttribute("data-kalvoice-target", "listening");
  });
});
