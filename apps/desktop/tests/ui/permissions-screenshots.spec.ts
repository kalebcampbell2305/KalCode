import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * Review screenshots of the permission UI (Z4) in both themes at 1440 and 1024 wide.
 * Output: apps/desktop/qa/screenshots/permissions-*.png. Run: pnpm test:ui --grep @screenshots
 */
const OUT = new URL("../../qa/screenshots/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const SIZES = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1024", width: 1024, height: 700 },
] as const;

async function shot(page: Page, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: new URL(`${name}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
}

for (const theme of ["dark", "light"] as const) {
  test(`@screenshots permission UI in ${theme} theme`, async ({ page }) => {
    test.setTimeout(120_000);
    for (const size of SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto("/?scenario=approvals");
      await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page
        .getByRole("radiogroup", { name: "Theme" })
        .getByRole("radio", { name: theme === "light" ? "Light" : "Dark" })
        .click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

      const section = page.getByRole("region", { name: "Permissions" });
      await section.scrollIntoViewIfNeeded();
      await section.getByText("Code Reviewer", { exact: true }).click();
      await section.getByRole("heading", { name: "Permissions" }).scrollIntoViewIfNeeded();
      await shot(page, `permissions-settings-${theme}-${size.name}`);
      await section.getByRole("table", { name: "Code Reviewer rules" }).scrollIntoViewIfNeeded();
      await shot(page, `permissions-profile-rules-${theme}-${size.name}`);

      await section
        .getByRole("radiogroup", { name: "Default mode for new coding agents" })
        .getByRole("radio", { name: "Bypass" })
        .click();
      await section.getByRole("heading", { name: "Permissions" }).scrollIntoViewIfNeeded();
      await shot(page, `permissions-bypass-on-${theme}-${size.name}`);

      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: /^Needs you/ })
        .click();
      await page
        .getByRole("dialog", { name: "Needs you" })
        .getByRole("button", { name: /^Review: / })
        .first()
        .click();
      await expect(page.getByRole("dialog", { name: "Approvals" }).getByRole("region").first()).toBeVisible();
      await shot(page, `permissions-approvals-${theme}-${size.name}`);
      await page.keyboard.press("Escape");

      if (size.name === "1440") {
        await page.getByRole("button", { name: "Collapse sidebar" }).click();
        await page.getByRole("button", { name: "Activity", exact: true }).click();
        await shot(page, `permissions-sidebar-collapsed-${theme}-${size.name}`);
        await page.getByRole("button", { name: "Expand sidebar" }).click();
      }
    }
  });
}
