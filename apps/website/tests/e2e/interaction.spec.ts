import { expect, test } from "@playwright/test";

test.describe("mobile navigation", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("opens and closes with the keyboard and manages focus", async ({ page }) => {
    await page.goto("/");
    const button = page.getByRole("button", { name: "Menu" });
    const nav = page.getByRole("navigation", { name: "Main" });

    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(nav).toBeHidden();

    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link", { name: "Product" })).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(nav.getByRole("link", { name: "Pricing" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(nav).toBeHidden();
    await expect(page.getByRole("button", { name: "Menu" })).toBeFocused();

    // Space toggles too, and a second press closes it.
    await page.keyboard.press("Space");
    await expect(nav).toBeVisible();
    await page.getByRole("button", { name: "Close menu" }).click();
    await expect(nav).toBeHidden();
  });

  test("closes on an outside click", async ({ page }) => {
    await page.goto("/pricing");
    await page.getByRole("button", { name: "Menu" }).click();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await page.mouse.click(195, 800);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  });
});

test.describe("desktop navigation", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("shows links inline without a menu button", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-menu-button]")).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Pricing" })).toBeVisible();
  });

  test("skip link moves focus to the main content", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
  });
});

test.describe("theme", () => {
  test("follows the system preference by default", async ({ browser }) => {
    for (const scheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      await expect(page.getByRole("button", { name: "Use system theme" })).toHaveAttribute("aria-pressed", "true");
      // The hero stays in the Space palette in both themes.
      await expect(page.locator(".hero")).toHaveAttribute("data-theme", "dark");
      await context.close();
    }
  });

  test("the toggle applies a theme, persists it across reloads, and can return to system", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await page.goto("/");
    const html = page.locator("html");

    await page.getByRole("button", { name: "Use light theme" }).click();
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(page.getByRole("button", { name: "Use light theme" })).toHaveAttribute("aria-pressed", "true");
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe("rgb(245, 247, 251)");

    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "light");
    await page.goto("/docs");
    await expect(html).toHaveAttribute("data-theme", "light");
    expect(await page.evaluate(() => localStorage.getItem("kalcode-theme"))).toBe("light");

    await page.getByRole("button", { name: "Use dark theme" }).click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "dark");

    await page.getByRole("button", { name: "Use system theme" }).click();
    expect(await page.evaluate(() => localStorage.getItem("kalcode-theme"))).toBeNull();
    await page.emulateMedia({ colorScheme: "light" });
    await expect(html).toHaveAttribute("data-theme", "light");
    await context.close();
  });

  test("works when storage is unavailable", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "light" });
    await context.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("blocked");
        },
      });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByRole("button", { name: "Use dark theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(errors).toEqual([]);
    await context.close();
  });
});
