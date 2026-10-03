import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * The live KalCode demo on the home page: Try KalCode reaches it with no account, a launched agent
 * is a new terminal pane (never a thread), Needs You jumps to the blocked agent, the tour ends in the
 * account and download actions, phones get the one-pane layout, and nothing breaks CSP or axe.
 */
const app = (page: Page) => page.locator("[data-live-app]");

async function openDemo(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("/");
  await page
    .getByRole("link", { name: /Try KalCode/ })
    .first()
    .click();
  await expect(page.locator("[data-live]")).toHaveAttribute("data-live", "ready");
  return errors;
}

test.describe("live demo (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Try KalCode opens the demo; launching agents adds coding terminals in Code", async ({ page }) => {
    const errors = await openDemo(page);
    await expect(app(page).getByRole("region", { name: /Pane 1: Claude A/ })).toBeVisible();
    const panes = await app(page).locator(".lk-tab").count();
    await app(page).getByRole("button", { name: "New agent" }).click();
    const dialog = app(page).getByRole("dialog", { name: /New agent/ });
    await expect(dialog).toContainText("A real coding agent in its own terminal");
    await dialog.getByRole("radio", { name: /Personal.*Plus/ }).click();
    await dialog.getByRole("button", { name: "One more agent" }).click();
    await dialog.getByRole("button", { name: "Launch 2 Codex agents" }).click();
    await expect(app(page).locator(".lk-tab")).toHaveCount(panes + 2);
    await expect(app(page).getByRole("button", { name: "Codex B · Personal", exact: true })).toBeVisible();
    // The new agent waits at its own prompt, like a real terminal.
    await expect(
      app(page)
        .getByRole("textbox", { name: /Prompt for Codex/ })
        .first(),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("Needs You jumps to the blocked agent; approving it lets the agent continue", async ({ page }) => {
    await openDemo(page);
    await app(page)
      .getByRole("button", { name: /needs you/ })
      .click();
    await expect(app(page).getByRole("group", { name: "Claude C needs approval" })).toBeVisible();
    await app(page).getByRole("button", { name: "Approve once" }).click();
    await expect(app(page).getByRole("group", { name: "Claude C needs approval" })).toHaveCount(0);
  });

  test("Agent Fleet, Live Browser and Operations work from the demo", async ({ page }) => {
    await openDemo(page);
    await app(page).getByRole("button", { name: "Dashboard" }).first().click();
    await expect(app(page).getByRole("region", { name: "Agent Fleet" })).toContainText("Claude A");
    await app(page)
      .getByRole("article", { name: /Codex A/ })
      .getByRole("button", { name: /Open/ })
      .click();
    await expect(app(page).getByRole("button", { name: "Codex A · Personal", exact: true, pressed: true })).toBeVisible();
    await app(page).getByRole("button", { name: "Add to pane 1" }).click();
    await app(page).getByRole("menuitem", { name: "Browser" }).click();
    await expect(app(page).getByText("localhost:3000").first()).toBeVisible();
    await app(page).getByRole("button", { name: "Operations" }).first().click();
    for (const tab of ["Runs", "Queue", "Services", "Environments", "Activity"]) {
      await app(page).getByRole("tab", { name: tab }).click();
      await expect(app(page).getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    }
  });

  test("the tour walks every step and ends on Download and Create account", async ({ page }) => {
    await openDemo(page);
    await page.getByRole("button", { name: /Take the 2-minute tour/ }).click();
    const card = app(page).locator("[data-tour-card]");
    await expect(card).toContainText("Welcome to KalCode");
    for (let i = 0; i < 20 && (await card.getByRole("button", { name: /Start|Next/ }).count()) > 0; i++) {
      await card.getByRole("button", { name: /Start|Next/ }).click();
    }
    await expect(card).toContainText("Ready to build?");
    await expect(card.getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/account");
    await expect(card.getByRole("link", { name: /Download/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
  });

  test("the command palette runs a command from the keyboard", async ({ page }) => {
    await openDemo(page);
    await app(page)
      .getByRole("button", { name: /Search or run a command/ })
      .click();
    await page.keyboard.type("operations");
    await page.keyboard.press("Enter");
    await expect(app(page).getByRole("heading", { name: /Operations/ })).toBeVisible();
  });

  for (const motion of ["no-preference", "reduce"] as const) {
    test(`no serious axe violations in the demo (motion ${motion})`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: motion });
      await openDemo(page);
      await page.waitForTimeout(800);
      const scan = async () =>
        (await new AxeBuilder({ page }).include("[data-live]").analyze()).violations.filter((v) =>
          ["serious", "critical"].includes(v.impact ?? ""),
        );
      expect(await scan()).toEqual([]);
      await app(page).getByRole("button", { name: "New agent" }).click();
      expect(await scan()).toEqual([]);
    });
  }
});

test.describe("live demo (phone)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("phones get one pane at a time, a pane strip and a bottom tab bar", async ({ page }) => {
    const errors = await openDemo(page);
    await expect(app(page).locator(".lk-app")).toHaveAttribute("data-mobile", "true");
    await expect(app(page).getByRole("navigation", { name: "KalCode" })).toBeVisible();
    await app(page)
      .getByRole("group", { name: "Panes" })
      .getByRole("button", { name: /Codex A/ })
      .click();
    await expect(app(page).getByRole("log", { name: "Codex A terminal" })).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  });
});
