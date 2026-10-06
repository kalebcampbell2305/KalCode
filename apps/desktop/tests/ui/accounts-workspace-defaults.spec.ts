import { expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11yViolations as expectA11y } from "./a11y.ts";
import { goTo } from "./nav.ts";

/**
 * Switch accounts, lane 3, against the in-memory transport: Providers → Accounts shows what uses
 * each account and connects another account per provider; New thread starts from the active
 * workspace's remembered account and only "Remember these accounts for this workspace" writes one.
 * Set KALCODE_SHOT_DIR to also save review screenshots there.
 */
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const SHOT_DIR = process.env.KALCODE_SHOT_DIR;

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  await page.screenshot({ path: `${SHOT_DIR.replace(/[\\/]$/, "")}/${name}.png`, fullPage: false });
}

async function palette(page: Page, text: string) {
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

async function openFolders(page: Page, ...names: string[]) {
  await page.evaluate((list) => {
    (window as unknown as { __kalcodeMemory: { queueFolders: (...f: string[]) => void } }).__kalcodeMemory.queueFolders(
      ...list,
    );
  }, names);
  for (const name of names) {
    await palette(page, "Open folder");
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  }
}

async function switchWorkspace(page: Page, name: string) {
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type(`Switch to ${name}`);
  // Similar project names can both match; choose the intended workspace explicitly.
  await page
    .getByRole("option")
    .filter({ has: page.getByText(name, { exact: true }) })
    .click();
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
}

async function openAccounts(page: Page) {
  await goTo(page, "Providers");
  await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await expect(page.getByRole("region", { name: "Codex · Personal" })).toBeVisible();
}

async function openNewThread(page: Page) {
  await goTo(page, "Threads");
  await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toBeVisible();
  await page.getByRole("button", { name: "New thread" }).first().click();
  const form = page.getByRole("region", { name: "New thread" });
  await expect(form.getByLabel("Account", { exact: true })).toBeVisible();
  return form;
}

/** The value of a labelled row in an account's details. */
const usage = (card: ReturnType<Page["getByRole"]>, term: string) =>
  card.locator("dt", { hasText: term }).locator("xpath=following-sibling::dd[1]");

/** Opens an account row's details (thread use, workspace defaults) unless already open. */
async function openDetails(card: ReturnType<Page["getByRole"]>, name: string) {
  const toggle = card.getByRole("button", { name: `Account details for ${name}` });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

/** Chooses one item from an account row's "More actions" menu. */
async function rowAction(page: Page, card: ReturnType<Page["getByRole"]>, name: string, item: string) {
  await card.getByRole("button", { name: `More actions for ${name}` }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item }).click();
}

/**
 * Closes whatever toasts are still up. They also leave on their own timer, so there may be none
 * left (a slow run outlasts them) or one may go between the count and the click.
 */
async function clearToasts(page: Page) {
  const dismiss = page.getByRole("button", { name: "Dismiss notification" });
  while ((await dismiss.count()) > 0)
    await dismiss
      .first()
      .click({ timeout: 2_000 })
      .catch(() => {});
}

async function expectNoSeriousA11yViolations(page: Page) {
  // Toasts are checked by their own suite; clear them so this checks the account UI.
  await clearToasts(page);
  await expectA11y(page);
}

test.describe("switch accounts: accounts view and workspace defaults", () => {
  test("Accounts shows thread use and workspace defaults, and adds another account per provider", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await openFolders(page, "kalcode", "kalcoded.com");

    // A Codex thread under Personal, remembered for kalcoded.com.
    let form = await openNewThread(page);
    await form.getByLabel("Provider").selectOption("codex");
    await expect(form.getByText("Default account.")).toBeVisible();
    await form.getByRole("checkbox", { name: "Remember these accounts for this workspace" }).check();
    await form.getByLabel("Task").fill("summarize the README");
    await form.getByRole("button", { name: "Start thread" }).click();
    await expect(page.getByText("New Codex threads in kalcoded.com use Personal")).toBeVisible();

    await openAccounts(page);
    const codex = page.getByRole("region", { name: "Codex · Personal" });
    await openDetails(codex, "Personal");
    await expect(usage(codex, "Active threads")).toHaveText(/^1( · 1 running)?$/);
    await expect(usage(codex, "Workspace default in")).toHaveText("kalcoded.com");
    await expect(codex.getByText("Default", { exact: true })).toBeVisible();
    await expect(codex.getByText("Signed in", { exact: true })).toBeVisible();
    const work = page.getByRole("region", { name: "Codex · Work" });
    await openDetails(work, "Work");
    await expect(usage(work, "Active threads")).toHaveText("None");
    await expect(usage(work, "Workspace default in")).toHaveText("None");
    await expect(work.getByRole("button", { name: "Sign in Work" })).toBeVisible();
    await work.getByRole("button", { name: "More actions for Work" }).click();
    await expect(page.getByRole("menu").getByRole("menuitem", { name: "Set Work as default" })).toBeVisible();
    await page.keyboard.press("Escape");

    // Every provider offers another account through the same add-then-official-sign-in flow.
    for (const name of ["Claude Code", "Codex", "Gemini CLI"]) {
      await expect(page.getByRole("button", { name: `Add ${name} account` })).toBeVisible();
    }
    await clearToasts(page);
    await page
      .getByRole("region", { name: "Codex", exact: true })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shot(page, "sa-lane3-accounts-view");
    await page.getByRole("button", { name: "Add Gemini CLI account" }).click();
    await page.getByLabel("Name for the new Gemini CLI account").fill("Work");
    await page.getByRole("button", { name: "Add and sign in" }).click();
    const geminiWork = page.getByRole("region", { name: "Gemini CLI · Work" });
    await expect(geminiWork.getByText("Signed in", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Gemini CLI · Personal" })).toBeVisible();
    await expect(page.locator("[data-provider-pane]")).toHaveCount(0);
    await expectNoSeriousA11yViolations(page);

    // Existing threads keep their account when the default changes.
    await work.getByRole("button", { name: "Sign in Work" }).click();
    await expect(work.getByText("Signed in", { exact: true })).toBeVisible();
    await rowAction(page, work, "Work", "Set Work as default");
    await expect(work.getByText("Default", { exact: true })).toBeVisible();
    await expect(usage(codex, "Active threads")).toHaveText(/^1( · 1 running)?$/);
    // kalcoded.com still remembers Personal: its New thread keeps Personal, not the new default.
    form = await openNewThread(page);
    await form.getByLabel("Provider").selectOption("codex");
    await expect(form.getByLabel("Account", { exact: true })).toHaveValue("0192f3c4-0000-7000-8000-000000000201");
    await expect(form.getByText("Workspace default for kalcoded.com.")).toBeVisible();
  });

  test("New thread follows the active workspace A → B → A; Remember writes only when checked", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await openFolders(page, "kalcode", "kalcoded.com");
    await openAccounts(page);
    // The toolbar's Add account adds the account, then runs Claude Code's own sign-in for it.
    await page.getByRole("button", { name: "Add account", exact: true }).click();
    await page.getByLabel("Provider", { exact: true }).selectOption("claude-code");
    await page.getByLabel("Name for the new Claude Code account").fill("Work");
    await page.getByRole("button", { name: "Add and sign in" }).click();
    await expect(
      page.getByRole("region", { name: "Claude Code · Work" }).getByText("Signed in", { exact: true }),
    ).toBeVisible();

    // kalcoded.com is active (opened last). Unchecked: the pick is used for this thread only.
    let form = await openNewThread(page);
    await expect(form.getByLabel("Workspace", { exact: true })).toHaveValue(/.+/);
    await expect(form.getByLabel("Workspace", { exact: true }).locator("option:checked")).toHaveText("kalcoded.com");
    await form.getByLabel("Account", { exact: true }).selectOption({ label: "Work" });
    await expect(form.getByText("Chosen for this thread.")).toBeVisible();
    await form.getByLabel("Task").fill("first pass");
    await form.getByRole("button", { name: "Start thread" }).click();
    await expect(page.getByRole("region", { name: "Thread", exact: true })).toBeVisible();

    form = await openNewThread(page);
    await expect(form.getByLabel("Account", { exact: true }).locator("option:checked")).toHaveText(
      "Personal · Default",
    );
    await expect(form.getByText("Default account.")).toBeVisible();

    // Checked: the choice becomes kalcoded.com's Claude Code account.
    await form.getByLabel("Account", { exact: true }).selectOption({ label: "Work" });
    const remember = form.getByRole("checkbox", { name: "Remember these accounts for this workspace" });
    await remember.check();
    await expect(form.getByText("New Claude Code threads in kalcoded.com will start with Work.")).toBeVisible();
    await form.getByLabel("Task").fill("second pass");
    await shot(page, "sa-lane3-new-thread-remember");
    await form.getByRole("button", { name: "Start thread" }).click();
    await expect(page.getByText("New Claude Code threads in kalcoded.com use Work")).toBeVisible();

    // A → B → A: each workspace's New thread starts from its own account.
    form = await openNewThread(page);
    await expect(form.getByLabel("Account", { exact: true }).locator("option:checked")).toHaveText("Work");
    await expect(form.getByText("Workspace default for kalcoded.com.")).toBeVisible();

    await switchWorkspace(page, "kalcode");
    form = await openNewThread(page);
    await expect(form.getByLabel("Workspace", { exact: true }).locator("option:checked")).toHaveText("kalcode");
    await expect(form.getByLabel("Account", { exact: true }).locator("option:checked")).toHaveText(
      "Personal · Default",
    );
    await expect(form.getByText("Default account.")).toBeVisible();

    await switchWorkspace(page, "kalcoded.com");
    form = await openNewThread(page);
    await expect(form.getByLabel("Workspace", { exact: true }).locator("option:checked")).toHaveText("kalcoded.com");
    await expect(form.getByLabel("Account", { exact: true }).locator("option:checked")).toHaveText("Work");
    await expect(form.getByText("Workspace default for kalcoded.com.")).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    // The Accounts view agrees: two threads on Work, remembered by kalcoded.com only.
    await openAccounts(page);
    const work = page.getByRole("region", { name: "Claude Code · Work" });
    await openDetails(work, "Work");
    await expect(usage(work, "Active threads")).toHaveText(/^2( · [12] running)?$/);
    await expect(usage(work, "Workspace default in")).toHaveText("kalcoded.com");
    const personal = page.getByRole("region", { name: "Claude Code · Personal" });
    await openDetails(personal, "Personal");
    await expect(usage(personal, "Workspace default in")).toHaveText("None");
  });
});
