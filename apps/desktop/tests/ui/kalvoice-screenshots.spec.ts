import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * Review screenshots of the KalVoice voice widget in every state, the KalVoice page and
 * Settings → KalVoice, in both themes at 1440×900. Output: apps/desktop/qa/screenshots/kalvoice/.
 * Run: pnpm test:ui --grep @screenshots. Speech comes from the memory transport's test double.
 */
const OUT = new URL("../../qa/screenshots/kalvoice/", import.meta.url);
mkdirSync(OUT, { recursive: true });

function file(name: string) {
  return new URL(`${name}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const widget = (page: Page) => page.getByRole("region", { name: "KalVoice widget" });
const state = (page: Page, name: string) =>
  widget(page).locator(':scope > :not([role="status"])').getByText(name, { exact: true });

async function start(page: Page, theme: "dark" | "light", query = "") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("radiogroup", { name: "Theme" })
    .getByRole("radio", { name: theme === "light" ? "Light" : "Dark" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.getByRole("button", { name: "Dashboard" }).click();
}

async function widgetShot(page: Page, name: string) {
  await page.waitForTimeout(250);
  const box = await widget(page).boundingBox();
  if (!box) throw new Error("widget not visible");
  await page.screenshot({
    path: file(name),
    clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 },
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`@screenshots KalVoice widget, a spoken command end to end, in ${theme} theme`, async ({ page }) => {
    test.setTimeout(120_000);
    await start(page, theme, "?scenario=kalvoice-slow&transcript=go%20to%20settings");
    await widgetShot(page, `ready-compact-${theme}`);
    await page.screenshot({ path: file(`workspace-${theme}-1440`) });

    await widget(page).getByRole("button", { name: "Show more" }).click();
    await widgetShot(page, `ready-expanded-${theme}`);
    await widget(page).getByRole("button", { name: "Show less" }).click();

    await page.getByRole("button", { name: "KalVoice", exact: true }).click();
    await page.getByRole("main").getByRole("textbox", { name: "Type a request for KalVoice" }).focus();
    await page.keyboard.down("F8");
    await expect(state(page, "Listening")).toBeVisible();
    await page.waitForTimeout(450);
    await widgetShot(page, `listening-${theme}`);
    await page.screenshot({ path: file(`kalvoice-page-listening-${theme}-1440`) });
    await page.keyboard.up("F8");
    await expect(state(page, "Processing")).toBeVisible();
    await widgetShot(page, `processing-${theme}`);
    await expect(state(page, "Executing")).toBeVisible();
    await widgetShot(page, `executing-${theme}`);
    await expect(state(page, "Done")).toBeVisible();
    await widgetShot(page, `done-type-it-instead-${theme}`);
    await page.screenshot({ path: file(`done-${theme}-1440`) });
  });

  test(`@screenshots KalVoice immediate app control, error and orb in ${theme} theme`, async ({ page }) => {
    await start(page, theme, "?scenario=kalvoice-approvals&transcript=open%20four%20codex%20threads");
    await page.keyboard.down("F8");
    await page.waitForTimeout(400);
    await page.keyboard.up("F8");
    await expect(state(page, "Done")).toBeVisible();
    await widgetShot(page, `immediate-app-control-${theme}`);
    await expect(state(page, "Ready")).toBeVisible();
    await widgetShot(page, `ready-after-app-control-${theme}`);

    await start(page, theme, "?transcript=plan%20the%20release");
    await page.keyboard.down("F8");
    await page.waitForTimeout(300);
    await page.keyboard.up("F8");
    await expect(state(page, "Error")).toBeVisible();
    await widgetShot(page, `error-needs-provider-${theme}`);

    await widget(page).getByRole("button", { name: "Collapse to the orb" }).click();
    await widgetShot(page, `orb-${theme}`);
  });

  test(`@screenshots KalVoice settings and consent in ${theme} theme`, async ({ page }) => {
    await start(page, theme, "?scenario=kalvoice-no-model");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator("#kalvoice").scrollIntoViewIfNeeded();
    await page.screenshot({ path: file(`settings-${theme}-1440`) });
    await page.locator("#kalvoice").screenshot({ path: file(`settings-section-${theme}`) });
    const fastest = page.getByRole("listitem").filter({ hasText: "English (fastest)" });
    await fastest.getByRole("button", { name: "Download" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.screenshot({ path: file(`consent-${theme}-1440`) });
  });
}
