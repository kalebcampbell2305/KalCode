import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * Review screenshots of the KalVoice assistant in every state, the KalVoice page and
 * Settings → KalVoice, in both themes at 1440×900. Output: apps/desktop/qa/screenshots/kalvoice/.
 * Run: pnpm test:ui --grep @screenshots. Speech comes from the memory transport's test double.
 */
const OUT = new URL("../../qa/screenshots/kalvoice/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const MOD = process.platform === "darwin" ? "Meta" : "Control";

function file(name: string) {
  return new URL(`${name}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const assistant = (page: Page) => page.getByRole("region", { name: "KalVoice assistant" });
const phase = (page: Page, name: string) =>
  assistant(page).locator(':scope > :not([role="status"])').getByText(name, { exact: true });

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

async function panelShot(page: Page, name: string) {
  await page.waitForTimeout(250);
  const box = await assistant(page).boundingBox();
  if (!box) throw new Error("assistant not visible");
  await page.screenshot({
    path: file(name),
    clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 },
  });
}

async function expand(page: Page) {
  await assistant(page).getByRole("button", { name: "Expand the assistant" }).click();
}

async function ask(page: Page, text: string) {
  const input = assistant(page).getByRole("textbox", { name: "Request for KalVoice" });
  await input.fill(text);
  await input.press("Enter");
}

for (const theme of ["dark", "light"] as const) {
  test(`@screenshots KalVoice assistant states in ${theme} theme`, async ({ page }) => {
    test.setTimeout(120_000);
    await start(page, theme, "?scenario=kalvoice-slow&transcript=add%20a%20unit%20test");
    await panelShot(page, `idle-compact-${theme}`);
    await page.screenshot({ path: file(`workspace-${theme}-1440`) });

    await expand(page);
    await panelShot(page, `idle-expanded-${theme}`);

    const input = assistant(page).getByRole("textbox", { name: "Request for KalVoice" });
    await input.focus();
    await page.keyboard.down(MOD);
    await page.keyboard.down("Shift");
    await page.keyboard.down("Space");
    await expect(phase(page, "LISTENING")).toBeVisible();
    await page.waitForTimeout(500);
    await panelShot(page, `listening-${theme}`);
    await page.keyboard.up("Space");
    await page.keyboard.up("Shift");
    await page.keyboard.up(MOD);
    await expect(phase(page, "TRANSCRIBING")).toBeVisible();
    await panelShot(page, `transcribing-${theme}`);
    await expect(phase(page, "DONE")).toBeVisible();
    await panelShot(page, `done-dictation-${theme}`);

    await input.fill("");
    await ask(page, "go to kalvoice");
    await expect(phase(page, "THINKING")).toBeVisible();
    await panelShot(page, `thinking-${theme}`);
    await expect(phase(page, "EXECUTING")).toBeVisible();
    await panelShot(page, `executing-${theme}`);
    await expect(phase(page, "DONE")).toBeVisible();
    await panelShot(page, `done-${theme}`);
    await page.screenshot({ path: file(`kalvoice-page-${theme}-1440`) });

    await ask(page, "plan the release");
    await expect(phase(page, "ERROR")).toBeVisible();
    await panelShot(page, `error-needs-provider-${theme}`);

    await assistant(page).getByRole("button", { name: "Collapse to the orb" }).click();
    await panelShot(page, `orb-${theme}`);
  });

  test(`@screenshots KalVoice permission, settings and consent in ${theme} theme`, async ({ page }) => {
    await start(page, theme, "?scenario=kalvoice-approvals");
    await expand(page);
    await ask(page, "stop all threads");
    await expect(phase(page, "WAITING FOR PERMISSION")).toBeVisible();
    await panelShot(page, `waiting-for-permission-${theme}`);
    await assistant(page)
      .getByRole("button", { name: /Close the assistant/ })
      .click();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator("#kalvoice").scrollIntoViewIfNeeded();
    await page.screenshot({ path: file(`settings-${theme}-1440`) });
    await page.locator("#kalvoice").screenshot({ path: file(`settings-section-${theme}`) });
    const small = page.getByRole("listitem").filter({ hasText: "English (more accurate)" });
    await small.getByRole("button", { name: "Download" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.screenshot({ path: file(`consent-${theme}-1440`) });
  });
}
