import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * Switch accounts on the Threads surface against the in-memory transport: the header's account
 * menu, the Rebind dialog and the list label. The memory transport's rebind follows native
 * (refuses busy threads, other providers' accounts and signed-out accounts; emits
 * `thread.account_changed`). Review screenshots: pnpm test:ui --grep @screenshots
 */
const OUT = new URL("../../qa/screenshots/", import.meta.url);

const list = (page: Page) => page.getByRole("list", { name: "Threads" });
const detail = (page: Page) => page.getByRole("region", { name: "Thread", exact: true });
const accountButton = (page: Page, label: string) =>
  detail(page).getByRole("button", { name: new RegExp(`^${label}, Gemini CLI account`) });

async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    serious,
    JSON.stringify(
      serious.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
      null,
      2,
    ),
  ).toEqual([]);
}

/** Adds "Gemini B", then starts a Gemini thread on Personal and waits for its turn to finish. */
async function geminiThreadWithTwoAccounts(page: Page) {
  await page.goto("/?scenario=threads");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  const primary = page.getByRole("navigation", { name: "Primary" });

  await primary.getByRole("button", { name: "Providers" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  const add = page.getByRole("region", { name: "Add provider account" });
  await add.getByLabel("Provider").selectOption("gemini-cli");
  await add.getByLabel("Account name").fill("Gemini B");
  await add.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByRole("region", { name: "Gemini CLI account Gemini B" })).toBeVisible();

  await primary.getByRole("button", { name: "Threads" }).click();
  await page.getByRole("button", { name: "New thread" }).first().click();
  const form = page.getByRole("region", { name: "New thread" });
  await form.getByLabel("Provider").selectOption("gemini-cli");
  await form.getByLabel("Account").selectOption({ label: "Personal (default)" });
  await form.getByLabel("Task").fill("tighten the release notes wording");
  await form.getByLabel("Name").fill("Release notes pass");
  await form.getByRole("button", { name: "Start thread" }).click();
  await expect(detail(page).getByRole("heading", { name: "Release notes pass" })).toBeVisible();
  await expect(detail(page).getByText("Ready", { exact: true })).toBeVisible({ timeout: 15_000 });
}

test.describe("thread accounts", () => {
  test("switching a thread's account always asks first, then rebinds future messages", async ({ page }) => {
    await geminiThreadWithTwoAccounts(page);
    const row = list(page).getByRole("button", { name: /Release notes pass/ });
    await expect(row).toContainText("Gemini CLI · Personal · ");
    await expect(
      detail(page)
        .locator("dd")
        .filter({ hasText: /^Gemini CLI · Personal$/ }),
    ).toBeVisible();

    // The menu opens from the keyboard and names the thread's account as Active, in text.
    await accountButton(page, "Personal").focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Switch account" });
    await expect(menu).toBeVisible();
    const personal = menu.getByRole("menuitemradio", { name: /Personal/ });
    const geminiB = menu.getByRole("menuitemradio", { name: /Gemini B/ });
    await expect(personal).toHaveAttribute("aria-checked", "true");
    await expect(personal).toContainText("Active");
    await expect(geminiB).toHaveAttribute("aria-checked", "false");
    await expect(menu.getByRole("menuitem", { name: "Connect another Gemini CLI account" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Manage provider accounts" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    // Choosing Gemini B opens the Rebind dialog, focused on Cancel. Cancel changes nothing.
    await geminiB.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog", { name: "Rebind thread?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("This thread currently belongs to Personal.")).toBeVisible();
    await expect(dialog.getByText("Switch future messages to Gemini B?")).toBeVisible();
    await expect(
      dialog.getByText("Past conversation history remains unchanged. Only future provider requests use Gemini B."),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expectNoSeriousA11yViolations(page);
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(accountButton(page, "Personal")).toBeFocused();

    // Confirming rebinds; the header and the list follow.
    await accountButton(page, "Personal").click();
    await menu.getByRole("menuitemradio", { name: /Gemini B/ }).click();
    await dialog.getByRole("button", { name: "Switch to Gemini B" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(accountButton(page, "Gemini B")).toBeVisible();
    await expect(page.getByText("Switched to Gemini B")).toBeVisible();
    await expect(row).toContainText("Gemini CLI · Gemini B · ");

    // The past conversation is still there.
    await expect(
      page
        .getByRole("list", { name: "Conversation" })
        .getByText("tighten the release notes wording", { exact: false })
        .first(),
    ).toBeVisible();
  });

  test("Manage provider accounts opens Providers → Accounts", async ({ page }) => {
    await geminiThreadWithTwoAccounts(page);
    await accountButton(page, "Personal").click();
    await page
      .getByRole("menu", { name: "Switch account" })
      .getByRole("menuitem", { name: "Manage provider accounts" })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Accounts", selected: true })).toBeVisible();
  });

  test("@screenshots account menu and Rebind dialog", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const path = (name: string) => new URL(`${name}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    await geminiThreadWithTwoAccounts(page);
    await accountButton(page, "Personal").click();
    const menu = page.getByRole("menu", { name: "Switch account" });
    await expect(menu).toBeVisible();
    await page.waitForTimeout(150);
    await page.screenshot({ path: path("threads-account-menu") });
    await menu.getByRole("menuitemradio", { name: /Gemini B/ }).click();
    await expect(page.getByRole("alertdialog", { name: "Rebind thread?" })).toBeVisible();
    await page.waitForTimeout(150);
    await page.screenshot({ path: path("threads-rebind-dialog") });
  });
});
