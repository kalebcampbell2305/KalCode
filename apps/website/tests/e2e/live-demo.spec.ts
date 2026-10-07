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
    await expect(app(page).getByRole("region", { name: /Pane 1: Dashboard Redesign/ })).toBeVisible();
    const panes = await app(page).locator(".lk-tab").count();
    await app(page).getByRole("button", { name: "New agent" }).click();
    const dialog = app(page).getByRole("dialog", { name: /New agent/ });
    await expect(dialog).toContainText("A real coding agent in its own terminal");
    await dialog.getByRole("radio", { name: /Personal.*Plus/ }).click();
    await dialog.getByRole("button", { name: "One more agent" }).click();
    await dialog.getByRole("button", { name: "Launch 2 Codex agents" }).click();
    await expect(app(page).locator(".lk-tab")).toHaveCount(panes + 2);
    // As in the app, a fresh agent is "New agent" until its first prompt names the task.
    await expect(app(page).getByRole("button", { name: "New agent", exact: true }).first()).toBeVisible();
    // The new agent waits at its own prompt, like a real terminal.
    await expect(
      app(page)
        .getByRole("textbox", { name: /Prompt for New agent/ })
        .first(),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("Needs You jumps to the agent asking for a secret; approving it lets the agent continue", async ({ page }) => {
    await openDemo(page);
    await expect(app(page).getByRole("button", { name: "Permission mode: Bypass" })).toBeVisible();
    await app(page)
      .getByRole("button", { name: /needs you/ })
      .click();
    const ask = app(page).getByRole("group", { name: "Payments Webhook needs approval" });
    await expect(ask).toBeVisible();
    await expect(ask).toContainText("credentials and secrets");
    await app(page).getByRole("button", { name: "Approve once" }).click();
    await expect(app(page).getByRole("group", { name: "Payments Webhook needs approval" })).toHaveCount(0);
  });

  test("page controls never leave the New agent dialog or a popover over a different screen", async ({ page }) => {
    await openDemo(page);
    await app(page).getByRole("button", { name: "New agent" }).click();
    await expect(app(page).getByRole("dialog", { name: /New agent/ })).toBeVisible();
    await page
      .locator('[data-live-do="go:operations"]')
      .first()
      .evaluate((el: HTMLElement) => el.click());
    await expect(app(page).getByRole("heading", { name: /Operations/ })).toBeVisible();
    await expect(app(page).getByRole("dialog", { name: /New agent/ })).toHaveCount(0);
    await page
      .locator('[data-live-do="menu:accounts"]')
      .first()
      .evaluate((el: HTMLElement) => el.click());
    await page
      .locator('[data-live-do="voice:open"]')
      .first()
      .evaluate((el: HTMLElement) => el.click());
    await expect(app(page).getByRole("dialog", { name: "Accounts and usage" })).toHaveCount(0);
    await expect(app(page).getByRole("dialog", { name: "KalVoice" })).toBeVisible();
    // The launch label is never cut off, even for ten agents.
    await app(page).getByRole("button", { name: "Code", exact: true }).first().click();
    await app(page).getByRole("button", { name: "New agent" }).click();
    for (let i = 0; i < 9; i++) await app(page).getByRole("button", { name: "One more agent" }).click();
    const launch = app(page).getByRole("button", { name: "Launch 10 Claude Code agents" });
    await expect(launch).toBeVisible();
    const clipped = await launch.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped).toBe(false);
  });

  test("Smart Close, the quick switcher, Back and the header account picker work like the app", async ({ page }) => {
    const errors = await openDemo(page);
    await app(page).getByRole("button", { name: "Close Dashboard Redesign" }).click();
    const close = app(page).getByRole("alertdialog", { name: "Close active work?" });
    await expect(close).toBeVisible();
    // As in the app since 0.1.9+2168: Stop and Close or Cancel; closing a pane stops its agent.
    await expect(close.getByRole("button", { name: "Keep Running" })).toHaveCount(0);
    await close.getByRole("button", { name: "Cancel" }).click();
    await expect(
      app(page).getByRole("button", { name: "Dashboard Redesign", exact: true, pressed: true }),
    ).toBeVisible();
    await app(page).getByRole("button", { name: "Close Dashboard Tests" }).click();
    await app(page)
      .getByRole("alertdialog", { name: "Close active work?" })
      .getByRole("button", { name: "Stop and Close" })
      .click();
    await expect(app(page).getByRole("complementary", { name: "Agents" })).not.toContainText("Dashboard Tests");
    await app(page).getByRole("button", { name: "Open quick switcher" }).click();
    await page.keyboard.type("dashboard redesign");
    await page.keyboard.press("Enter");
    await expect(
      app(page).getByRole("button", { name: "Dashboard Redesign", exact: true, pressed: true }),
    ).toBeVisible();
    // Code and Activity are the primary places; Operations is one click away in More.
    await app(page).getByRole("navigation", { name: "KalCode" }).getByRole("button", { name: "More" }).click();
    await app(page).getByRole("menu", { name: "More places" }).getByRole("menuitem", { name: "Operations" }).click();
    await app(page).getByRole("button", { name: "Go back" }).click();
    await expect(app(page).locator(".lk-app")).toHaveAttribute("data-surface", "code");
    await app(page).getByRole("button", { name: "Personal. Switch Claude Code account" }).first().click();
    const picker = app(page).getByRole("dialog", { name: "Account & usage" });
    await expect(picker).toContainText("Choose an account for your next coding session.");
    await picker.getByRole("button", { name: /^Work/ }).click();
    await picker.getByRole("button", { name: "Start with Work" }).click();
    // The fresh session starts on Work beside the original, which keeps running (Code Review was already on Work).
    await expect(app(page).getByRole("button", { name: "Work. Switch Claude Code account" }).first()).toBeVisible();
    const agents = app(page).getByRole("complementary", { name: "Agents" });
    await expect(agents).toContainText("Dashboard Redesign");
    await expect(agents).toContainText("Code Review");
    expect(errors).toEqual([]);
  });

  test("Agent Fleet, Live Browser and Operations work from the demo", async ({ page }) => {
    await openDemo(page);
    await app(page)
      .getByRole("navigation", { name: "KalCode" })
      .getByRole("button", { name: /^Activity/ })
      .click();
    // Activity leads with Needs You, as in the app: one line that opens the inbox.
    await expect(app(page).getByRole("region", { name: "Needs you" })).toContainText("blocked on you");
    await expect(app(page).getByRole("region", { name: "Agent Fleet" })).toContainText("Dashboard Redesign");
    await app(page)
      .getByRole("article", { name: /Dashboard Tests/ })
      .getByRole("button", { name: /Open/ })
      .click();
    await expect(app(page).getByRole("button", { name: "Dashboard Tests", exact: true, pressed: true })).toBeVisible();
    await app(page).getByRole("button", { name: "Add to pane 1" }).click();
    await app(page).getByRole("menuitem", { name: "Browser" }).click();
    await expect(app(page).getByText("localhost:3000").first()).toBeVisible();
    // Code and Activity are the primary places; Operations is one click away in More.
    await app(page).getByRole("navigation", { name: "KalCode" }).getByRole("button", { name: "More" }).click();
    await app(page).getByRole("menu", { name: "More places" }).getByRole("menuitem", { name: "Operations" }).click();
    for (const tab of ["Runs", "Queue", "Services", "Environments", "Activity"]) {
      await app(page).getByRole("tab", { name: tab }).click();
      await expect(app(page).getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    }
  });

  test("Code leads the navigation and opens workspace context without leaving Code", async ({ page }) => {
    const errors = await openDemo(page);
    const navigation = app(page).getByRole("navigation", { name: "KalCode" }).first();
    await expect(navigation.getByRole("button").first()).toHaveAccessibleName("Code");

    await app(page).getByRole("button", { name: "Context" }).click();
    const menu = app(page).getByRole("menu", { name: "Beside your code" });
    await expect(menu.getByRole("menuitem", { name: "Browser" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Runs, services & tests" }).click();

    await expect(app(page).locator(".lk-app")).toHaveAttribute("data-surface", "code");
    await expect(app(page).getByRole("region", { name: /Runs & services/ })).toBeVisible();
    for (const tab of ["Runs", "Services", "Tests"]) {
      await app(page)
        .getByRole("tab", { name: new RegExp(`^${tab}`) })
        .click();
      await expect(app(page).getByRole("tab", { name: new RegExp(`^${tab}`) })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    }
    await app(page).getByRole("button", { name: "Context" }).click();
    await app(page).getByRole("menu", { name: "Beside your code" }).getByRole("menuitem", { name: "Browser" }).click();
    await expect(app(page).getByRole("button", { name: "Browser", pressed: true })).toBeVisible();
    await expect(app(page).locator(".lk-app")).toHaveAttribute("data-surface", "code");
    expect(errors).toEqual([]);
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
      await app(page).getByRole("button", { name: "Context" }).click();
      expect(await scan()).toEqual([]);
      await app(page).getByRole("menuitem", { name: "Runs, services & tests" }).click();
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
      .getByRole("button", { name: /Dashboard Tests/ })
      .click();
    await expect(app(page).getByRole("log", { name: "Dashboard Tests terminal" })).toBeVisible();
    await app(page).getByRole("button", { name: "Context" }).click();
    await app(page).getByRole("menuitem", { name: "Runs, services & tests" }).click();
    await expect(app(page).getByRole("tab", { name: /^Runs/ })).toBeVisible();
    await expect(app(page).locator(".lk-app")).toHaveAttribute("data-surface", "code");
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    // The tour moves focus around the demo; the app must never scroll sideways inside its frame.
    await page.getByRole("button", { name: /Take the 2-minute tour/ }).click();
    const card = app(page).locator("[data-tour-card]");
    await expect(card).toContainText("Welcome to KalCode");
    for (let i = 0; i < 20 && (await card.getByRole("button", { name: /Start|Next/ }).count()) > 0; i++) {
      await card.getByRole("button", { name: /Start|Next/ }).click();
    }
    await expect(card).toContainText("Ready to build?");
    const shifted = await page.evaluate(() =>
      [...document.querySelectorAll("[data-live-app], [data-live-app] *")].some(
        (el) => el.scrollLeft > 0 && !el.matches(".lk-mstrip, .lk-frame__strip, .lk-tabs, .lk-table-wrap"),
      ),
    );
    expect(shifted).toBe(false);
    expect(errors).toEqual([]);
  });
});
