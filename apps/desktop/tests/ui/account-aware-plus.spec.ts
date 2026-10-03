import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Account-aware + launch proof. Every route stays in the launch surface: one account is implicit,
 * several accounts are chosen there, and a missing/signed-out account is recovered in place.
 */
const OUT = new URL("../../qa/screenshots/account-aware-plus/", import.meta.url);
mkdirSync(fileURLToPath(OUT), { recursive: true });

const CODEX_WORK = "0192f3c4-0000-7000-8000-000000000202";

const launcher = (page: Page) => page.getByRole("dialog", { name: "New agent" });
const threadForm = (page: Page) => page.getByRole("region", { name: "New thread" });
const pane = (page: Page) => page.locator("[data-provider-pane]").first();

async function open(page: Page, scenario?: string) {
  await page.goto(scenario ? `/?scenario=${scenario}` : "/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
}

async function openWorkspace(page: Page, folder: string) {
  await page.evaluate((name) => {
    (
      window as unknown as { __kalcodeMemory: { queueFolders: (...folders: string[]) => void } }
    ).__kalcodeMemory.queueFolders(name);
  }, folder);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "Open folder…" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: folder })).toBeVisible();
}

async function openThreads(page: Page) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Threads" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toBeVisible();
}

async function expectNoSeriousA11yViolations(page: Page, selector: string) {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    serious,
    JSON.stringify(
      serious.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => node.target),
      })),
      null,
      2,
    ),
  ).toEqual([]);
}

async function expectSoleAccount(surface: Locator, name: string) {
  await expect(surface.getByRole("combobox", { name: "Account" })).toHaveCount(0);
  await expect(surface.getByText(new RegExp(`^${name}(?: \\u00b7 Default)?$`))).toBeVisible();
}

test("Dashboard Launch an agent routes through Code, implicitly uses sole Claude Personal and opens its exact pane", async ({
  page,
}) => {
  await open(page);
  await openWorkspace(page, "dashboard-plus");
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  const agents = page.getByRole("region", { name: "Agents" });
  await expect(agents.getByRole("heading", { name: "No agents yet" })).toBeVisible();

  await agents.getByRole("button", { name: "Launch an agent" }).click();
  await expect(page.locator("#main")).toHaveAttribute("data-surface", "code");
  const dialog = launcher(page);
  await expect(dialog).toBeVisible();
  // Claude Code's sole account is already chosen; there is no account step to take.
  const claude = dialog.getByRole("group", { name: "Claude Code" });
  await expectSoleAccount(claude, "Personal");
  await expect(claude.getByRole("option")).toHaveCount(1);
  await expect(claude.getByRole("option")).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("button", { name: "Launch Claude Code agent" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Launch Claude Code agent" }).click();

  await expect(pane(page)).toHaveAttribute("aria-label", "New agent, Claude Code agent, account Personal");
  await expect(pane(page).locator("[data-pane-terminal] .xterm-rows")).toContainText("KalCode fake provider");
});

test("Code + immediately offers multiple Codex accounts, signs Work in inline and launches its exact pane", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1040, height: 760 });
  await open(page);
  await openWorkspace(page, "agent-picker");
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  const dialog = launcher(page);
  // Every account of every provider is one list; Codex's two accounts are its own group.
  const accounts = dialog.getByRole("group", { name: "Codex" }).getByRole("option");
  await expect(accounts).toHaveText([/Personal/, /Work.*Signed out/]);
  const work = accounts.filter({ hasText: "Work" });
  await work.click();
  await expect(work).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("button", { name: "Sign in to Work" })).toBeVisible();
  await page.screenshot({ path: fileURLToPath(new URL("agent-picker-1040x760.png", OUT)) });
  await expectNoSeriousA11yViolations(page, '[role="dialog"]');

  await dialog.getByRole("button", { name: "Sign in to Work" }).click();
  await expect(dialog.getByRole("button", { name: "Sign in to Work" })).toHaveCount(0);
  await expect(work).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("option", { selected: true })).toContainText("Work");
  await expect(dialog.getByRole("button", { name: "Launch Codex agent" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Launch Codex agent" }).click();

  await expect(pane(page)).toHaveAttribute("aria-label", "New agent, Codex agent, account Work");
  await expect(pane(page).locator("[data-pane-terminal] .xterm-rows")).toContainText("KalCode fake provider");
});

test("Threads implicitly uses sole Claude Personal, then inline Codex Work sign-in preserves the draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 980, height: 760 });
  await open(page);
  await openWorkspace(page, "thread-picker");
  await openThreads(page);

  await page.getByRole("button", { name: "New thread" }).first().click();
  let form = threadForm(page);
  await expectSoleAccount(form, "Personal");
  await form.getByLabel("Task").fill("Verify the sole account route");
  await form.getByRole("button", { name: "Start thread" }).click();
  let detail = page.getByRole("region", { name: "Thread", exact: true });
  await expect(detail.getByText(/Claude Code.*Personal/).first()).toBeVisible();

  await page.getByRole("button", { name: "New thread" }).first().click();
  form = threadForm(page);
  await form.getByLabel("Provider").selectOption("codex");
  const accounts = form.getByRole("combobox", { name: "Account" });
  await expect(accounts.locator("option")).toHaveText([/Personal.*Default/, /Work.*Signed out/]);
  await accounts.selectOption(CODEX_WORK);
  const draft = "Keep this exact draft while Work signs in";
  await form.getByLabel("Task").fill(draft);
  await expect(form.getByRole("button", { name: "Sign in to Work" })).toBeVisible();
  await accounts.scrollIntoViewIfNeeded();
  await page.screenshot({ path: fileURLToPath(new URL("thread-picker-980x760.png", OUT)) });
  await expectNoSeriousA11yViolations(page, "form");

  await form.getByRole("button", { name: "Sign in to Work" }).click();
  await expect(form.getByRole("button", { name: "Sign in to Work" })).toHaveCount(0);
  await expect(form.getByLabel("Task")).toHaveValue(draft);
  await expect(accounts).toHaveValue(CODEX_WORK);
  await expect(accounts.locator("option:checked")).toHaveText("Work");
  await form.getByRole("button", { name: "Start thread" }).click();
  detail = page.getByRole("region", { name: "Thread", exact: true });
  await expect(detail.getByText(/Codex.*Work/).first()).toBeVisible();
});

test("empty-account + flows add and sign in without leaving either agent or thread launch", async ({ page }) => {
  await open(page, "provider-accounts-empty");
  await openWorkspace(page, "empty-account-plus");

  await page.getByRole("button", { name: "New agent", exact: true }).click();
  let surface = launcher(page);
  await expect(surface.getByText("No Claude Code account added yet")).toBeVisible();
  await expect(surface.getByRole("button", { name: "Launch Claude Code agent" })).toBeDisabled();
  await surface.getByLabel("Account name").fill("Studio");
  await surface.getByRole("button", { name: "Add Claude Code account" }).click();
  await expect(surface.getByText(/^Studio(?: · Default)?$/)).toBeVisible();
  await expect(surface.getByRole("button", { name: "Launch Claude Code agent" })).toBeEnabled();
  await surface.getByRole("button", { name: "Launch Claude Code agent" }).click();
  await expect(pane(page)).toHaveAttribute("aria-label", "New agent, Claude Code agent, account Studio");

  await openThreads(page);
  await page.getByRole("button", { name: "New thread" }).first().click();
  surface = threadForm(page);
  await surface.getByLabel("Provider").selectOption("codex");
  await expect(surface.getByText("No Codex account added yet")).toBeVisible();
  const draft = "Keep this while adding the first Codex account";
  await surface.getByLabel("Task").fill(draft);
  await surface.getByLabel("Account name").fill("Client");
  await surface.getByRole("button", { name: "Add Codex account" }).click();
  await expect(surface.getByLabel("Task")).toHaveValue(draft);
  await expect(surface.getByText(/^Client(?: · Default)?$/)).toBeVisible();
  await expect(surface.getByRole("button", { name: "Start thread" })).toBeEnabled();
  await surface.getByRole("button", { name: "Start thread" }).click();
  await expect(
    page
      .getByRole("region", { name: "Thread", exact: true })
      .getByText(/Codex.*Client/)
      .first(),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toHaveCount(0);
});
