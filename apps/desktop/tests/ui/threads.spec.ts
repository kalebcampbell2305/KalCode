import { expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./a11y.ts";
import { expectApprovalItems, goTo } from "./nav.ts";

/** A row, not the favorite (pin/star) button beside it, whose label repeats the row's name (#235). */
const NOT_FAVORITE = ":not([data-favorite-action])";

/**
 * Threads surface against the in-memory transport: fixture provider detection (Claude Code and
 * Codex installed and signed in, Gemini CLI installed with sign-in unknown), workspaces
 * opened through Z1's fake folder picker, and a scripted fake provider session (see
 * src/ipc/memory/threads.ts).
 */
const MOD = process.platform === "darwin" ? "Meta" : "Control";

/** Opens project folders through the command palette and the fake native folder picker. */
async function openFolders(page: Page, ...names: string[]) {
  await page.evaluate((list) => {
    (window as unknown as { __kalcodeMemory: { queueFolders: (...f: string[]) => void } }).__kalcodeMemory.queueFolders(
      ...list,
    );
  }, names);
  for (const name of names) {
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type("Open folder");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  }
}

async function openThreads(page: Page, scenario?: string) {
  await page.goto(scenario ? `/?scenario=${scenario}` : "/");
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  // Without a Threads scenario, threads run in folders opened in Code (Z1).
  if (!scenario) await openFolders(page, "kalcode", "kalcoded.com");
  await goTo(page, "Threads");
  await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toBeVisible();
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type(`use ${theme} theme`);
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

const list = (page: Page) => page.getByRole("list", { name: "Threads" });
const detail = (page: Page) => page.getByRole("region", { name: "Thread", exact: true });
const conversation = (page: Page) => page.getByRole("list", { name: "Conversation" });

async function createThread(page: Page, task: string) {
  await page.getByRole("button", { name: "New thread" }).first().click();
  await page.getByLabel("Task").fill(task);
  await page.getByRole("button", { name: "Start thread" }).click();
  await expect(detail(page)).toBeVisible();
}

test.describe("threads", () => {
  test("empty state explains threads and offers to create one", async ({ page }) => {
    await openThreads(page);
    await expect(page.getByRole("heading", { name: "No threads yet" })).toBeVisible();
    // Said once, in the detail pane; the list only says where threads will appear.
    await expect(page.getByText(/No threads yet/)).toHaveCount(1);
    await expect(
      page.getByRole("region", { name: "Thread list" }).getByText("Threads you start appear here."),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });

  test("new thread flow creates a thread and streams its work", async ({ page }) => {
    await openThreads(page);
    await page.getByRole("button", { name: "New thread" }).first().click();
    const form = page.getByRole("region", { name: "New thread" });
    await expect(form.getByRole("heading", { name: "New thread" })).toBeVisible();

    // Defaults: first provider, its sole account and default model, first workspace, Bypass (no approvals).
    await expect(form.getByLabel("Provider")).toHaveValue("claude-code");
    await expect(form.getByRole("combobox", { name: "Account" })).toHaveCount(0);
    await expect(form.getByText(/^Personal(?: · Default)?$/)).toBeVisible();
    await expect(form.getByLabel("Model")).toHaveValue("");
    await expect(form.getByRole("radio", { name: "Bypass" })).toBeChecked();
    await expect(form.getByText(/No approval prompts/)).toBeVisible();
    await expect(form.getByRole("button", { name: "Start thread" })).toBeDisabled();

    await form.getByLabel("Model").selectOption("opus");
    await form.getByLabel("Workspace", { exact: true }).selectOption({ label: "kalcoded.com" });
    await form.getByLabel("Task").fill("fix the OAuth callback race in the login flow");
    await form.getByLabel("Task").press(`${MOD}+Enter`);

    const row = list(page)
      .getByRole("button", { name: /Fix OAuth Callback Race/ })
      .and(page.locator(NOT_FAVORITE));
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(detail(page).getByRole("heading", { name: "Fix OAuth Callback Race" })).toBeVisible();
    await expect(detail(page).getByText("Claude Code · opus · Personal")).toBeVisible();
    await expect(detail(page).getByText("kalcoded.com", { exact: true })).toBeVisible();

    // Live deltas stream in, then the stored message, the tool call and the final reply.
    await expect(conversation(page).getByText("Writing")).toBeVisible();
    const toolRow = conversation(page).getByRole("listitem").filter({ hasText: "Run npm test" });
    await expect(toolRow.getByText("Done")).toBeVisible();
    await expect(toolRow.getByText("42 tests passed")).toBeVisible();
    await expect(conversation(page).getByText("Done. The change is in place and all 42 tests pass.")).toBeVisible();
    await expect(detail(page).getByText("Ready", { exact: true })).toBeVisible();
    await expect(conversation(page).getByText("Writing")).toHaveCount(0);

    // Every step was recorded in the event log.
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity.getByText("Thread created")).toBeVisible();
    await expect(activity.getByText("Tool finished").first()).toBeVisible();
  });

  test("new thread offers Codex and Gemini CLI with their own models and mode notes", async ({ page }) => {
    await openThreads(page);
    await page.getByRole("button", { name: "New thread" }).first().click();
    const form = page.getByRole("region", { name: "New thread" });
    await expect(form.getByLabel("Provider").locator("option")).toHaveText(["Claude Code", "Codex", "Gemini CLI"]);
    // Cursor runs only as a coding terminal in Code, never as a thread.
    const others = form.getByRole("list", { name: "Not available for threads" });
    await expect(others.getByRole("listitem")).toHaveCount(1);
    await expect(others.getByRole("listitem").filter({ hasText: "Cursor" })).toContainText(
      "Use a Cursor coding terminal in Code",
    );

    // Codex lists no models up front: only the provider's default.
    await form.getByLabel("Provider").selectOption("codex");
    await expect(form.getByLabel("Account", { exact: true }).locator("option")).toHaveText([
      "Personal · Default",
      "Work · Signed out",
    ]);
    await expect(form.getByLabel("Account", { exact: true })).toHaveValue("0192f3c4-0000-7000-8000-000000000201");
    await expect(form.getByLabel("Model").locator("option")).toHaveText(["Provider default"]);
    await expect(form.getByText(/With Codex: Uses Codex's explicit danger-full-access sandbox/)).toBeVisible();

    await form.getByLabel("Provider").selectOption("gemini-cli");
    await expect(form.getByLabel("Model").locator("option")).toHaveText([
      "Provider default",
      "Auto (default)",
      "Pro",
      "Flash",
      "Flash-Lite",
    ]);
    await expect(form.getByText(/With Gemini CLI: Everything runs without approval prompts/)).toBeVisible();

    // A Codex thread runs like any other.
    await form.getByLabel("Provider").selectOption("codex");
    await form.getByLabel("Task").fill("summarize the README");
    await form.getByRole("button", { name: "Start thread" }).click();
    await expect(detail(page)).toBeVisible();
    await expect(
      detail(page)
        .getByText(/^Codex/)
        .first(),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });

  test("only providers that can run threads are offered; the others say why", async ({ page }) => {
    await page.goto("/?scenario=providers-signed-out");
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await openFolders(page, "kalcode");
    await goTo(page, "Threads");
    await page.getByRole("button", { name: "New thread" }).first().click();
    const form = page.getByRole("region", { name: "New thread" });
    await expect(form.getByLabel("Provider").locator("option")).toHaveText(["Claude Code"]);
    const others = form.getByRole("list", { name: "Not available for threads" });
    await expect(others.getByRole("listitem")).toHaveCount(3);
    await expect(others.getByRole("listitem").filter({ hasText: "Codex" })).toContainText(
      "Signed out — run codex login",
    );
    await expect(others.getByRole("listitem").filter({ hasText: "Gemini CLI" })).toContainText("Not installed");
    await expect(others.getByRole("listitem").filter({ hasText: "Cursor" })).toContainText(
      "Use a Cursor coding terminal in Code",
    );
    await expect(others.getByText(/can't run threads with it yet/)).toHaveCount(0);
  });

  test("an explicit name and permission mode are used", async ({ page }) => {
    await openThreads(page);
    await page.getByRole("button", { name: "New thread" }).first().click();
    const form = page.getByRole("region", { name: "New thread" });
    await expect(form.getByLabel("Model")).toHaveValue("");
    const bypass = form.getByRole("radio", { name: "Bypass" });
    await bypass.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(form.getByRole("radio", { name: "Plan" })).toBeChecked();
    await expect(form.getByText("Reads and plans. Nothing is changed.")).toBeVisible();
    await form.getByLabel("Task").fill("Write docs");
    await form.getByLabel("Name").fill("Docs pass");
    await form.getByRole("button", { name: "Start thread" }).click();
    await expect(detail(page).getByRole("heading", { name: "Docs pass" })).toBeVisible();
    await expect(detail(page).getByText("Plan", { exact: true })).toBeVisible();
    await expect(
      detail(page)
        .locator("dd")
        .filter({ hasText: /^Claude Code · Personal$/ }),
    ).toBeVisible();
  });

  test("cancel returns to the list; no usable provider is explained", async ({ page }) => {
    await openThreads(page, "no-providers");
    await page.getByRole("button", { name: "New thread" }).first().click();
    await expect(page.getByRole("heading", { name: "No provider is ready for threads" })).toBeVisible();
    await page.getByRole("button", { name: "Back to threads" }).click();
    await expect(page.getByRole("heading", { name: "No threads yet" })).toBeVisible();

    // Claude Code missing on this machine: the reason is shown, with a way to the Providers page.
    await openThreads(page, "providers-none");
    await page.getByRole("button", { name: "New thread" }).first().click();
    await expect(page.getByRole("heading", { name: "No provider is ready for threads" })).toBeVisible();
    await expect(
      page
        .getByRole("list", { name: "Not available for threads" })
        .getByRole("listitem")
        .filter({ hasText: "Claude Code" }),
    ).toContainText("Not installed");
    await page.getByRole("button", { name: "Go to Providers" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();
  });

  test("offers Codex when its validated managed runtime recovered a missing native CLI", async ({ page }) => {
    await openThreads(page, "providers-managed-runtime");
    await openFolders(page, "kalcode");
    await goTo(page, "Threads");
    await page.getByRole("button", { name: "New thread" }).first().click();
    const form = page.getByRole("region", { name: "New thread" });
    await expect(form.getByRole("combobox", { name: "Provider" }).locator('option[value="codex"]')).toHaveCount(1);
    await form.getByRole("combobox", { name: "Provider" }).selectOption("codex");
    await expect(form.getByRole("combobox", { name: "Provider" })).toHaveValue("codex");
    await expect(
      form.getByRole("list", { name: "Not available for threads" }).getByText("Codex", { exact: true }),
    ).toHaveCount(0);
  });

  test("without a workspace, New thread points to Code", async ({ page }) => {
    await page.goto("/");
    await goTo(page, "Threads");
    await page.getByRole("button", { name: "New thread" }).first().click();
    await expect(page.getByRole("heading", { name: "No workspaces yet" })).toBeVisible();
    await page.getByRole("button", { name: "Open Code" }).click();
    await expect(page.getByRole("heading", { name: "Open a project folder" })).toBeVisible();
  });

  test("without a managed account, one is added and signed in inside the thread form", async ({ page }) => {
    await page.goto("/?scenario=provider-accounts-empty");
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await openFolders(page, "kalcode");
    await goTo(page, "Threads");
    await page.getByRole("button", { name: "New thread" }).first().click();
    const form = page.getByRole("region", { name: "New thread" });
    await expect(form.getByRole("combobox", { name: "Account" })).toHaveCount(0);
    await expect(form.getByText("No Claude Code account added yet")).toBeVisible();
    await form.getByLabel("Task").fill("Do not launch without an isolated account");
    await expect(form.getByRole("button", { name: "Start thread" })).toBeDisabled();
    await form.getByLabel("Account name").fill("Personal");
    await form.getByRole("button", { name: "Add Claude Code account" }).click();
    await expect(form.getByLabel("Task")).toHaveValue("Do not launch without an isolated account");
    await expect(form.getByText(/^Personal(?: · Default)?$/)).toBeVisible();
    await expect(form.getByRole("button", { name: "Start thread" })).toBeEnabled();
    await form.getByRole("button", { name: "Start thread" }).click();
    await expect(
      detail(page)
        .getByText(/Claude Code.*Personal/)
        .first(),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toHaveCount(0);
  });

  test("interrupt stops a slow turn and keeps what was written", async ({ page }) => {
    await openThreads(page);
    await createThread(page, "slow refactor of the parser");
    await expect(conversation(page).getByText("Writing")).toBeVisible();
    await detail(page).getByRole("button", { name: "Interrupt" }).click();
    await expect(detail(page).getByText("Interrupted by you")).toBeVisible();
    await expect(detail(page).getByText("Ready", { exact: true })).toBeVisible();
    await expect(conversation(page).getByText(/^I'll/)).toBeVisible();
    await expect(detail(page).getByRole("button", { name: "Interrupt" })).toHaveCount(0);

    // The session continues.
    await detail(page).getByLabel("Message").fill("carry on");
    await detail(page).getByRole("button", { name: "Send" }).click();
    await expect(conversation(page).getByText("carry on")).toBeVisible();
    await expect(detail(page).getByLabel("Message")).toHaveValue("");
  });

  test("gated context drop stays hidden", async ({ page }) => {
    await openThreads(page, "threads");
    await list(page)
      .getByRole("button", { name: /Write Unit Tests for Parser Module/ })
      .and(page.locator(NOT_FAVORITE))
      .click();
    await expect(detail(page).getByLabel("Message")).toBeVisible();
    await expect(detail(page).getByRole("button", { name: "Add context" })).toHaveCount(0);
  });

  test("context drop previews redactions and sends to the exact selected thread", async ({ page }) => {
    await openThreads(page, "threads-context");
    await list(page)
      .getByRole("button", { name: /Write Unit Tests for Parser Module/ })
      .and(page.locator(NOT_FAVORITE))
      .click();

    const thread = detail(page);
    await thread.getByRole("button", { name: "Add context" }).click();
    await expect(thread.getByRole("button", { name: "Add context" })).toHaveAttribute("aria-expanded", "true");
    await expect(thread.getByRole("button", { name: "Pasted text" })).toHaveAttribute("aria-pressed", "true");
    await thread.getByLabel("Label").fill("Failure output");
    const secret = ["password", "=", "context-drop-regression-value"].join("");
    await thread.getByLabel("Content").fill(`Request failed\n${secret}`);
    await thread.getByRole("button", { name: "Preview context" }).click();

    const tray = thread.getByRole("region", { name: "Context drop" });
    await expect(tray.getByText(/1 item checked for/)).toBeVisible();
    await expect(tray.getByText("password=[REDACTED]", { exact: false })).toBeVisible();
    await expect(tray.getByText("context-drop-regression-value", { exact: false })).toHaveCount(0);
    await expect(tray.getByText("Sending to")).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    await thread.getByLabel("Message").fill("Investigate this failure.");
    await thread.getByRole("button", { name: "Send" }).click();
    await expect(conversation(page).getByText(/Investigate this failure/)).toBeVisible();
    await expect(conversation(page).getByText(/password=\[REDACTED\]/)).toHaveCount(0);
    await expect(conversation(page).getByText("context-drop-regression-value", { exact: false })).toHaveCount(0);
    await expect(tray.getByText("Sending to")).toHaveCount(0);
  });

  test("stop, resume and archive follow the thread's state", async ({ page }) => {
    await openThreads(page);
    await createThread(page, "slow migration");
    await detail(page).getByRole("button", { name: "Stop" }).click();
    await expect(detail(page).getByText("Stopped · resumable", { exact: true })).toBeVisible();
    await expect(detail(page).getByText("Stopped by you")).toBeVisible();
    await expect(detail(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
    await expect(detail(page).getByRole("button", { name: "Resume and send" })).toBeVisible();

    // Resume with a message.
    await detail(page).getByLabel("Message").fill("continue where you left off");
    await detail(page).getByLabel("Message").press(`${MOD}+Enter`);
    await expect(conversation(page).getByText("continue where you left off")).toBeVisible();
    await expect(detail(page).getByRole("button", { name: "Stop" })).toBeVisible();
    await detail(page).getByRole("button", { name: "Stop" }).click();
    await expect(detail(page).getByRole("button", { name: "Archive" })).toBeVisible();

    await detail(page).getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText("Thread archived")).toBeVisible();
    await expect(
      list(page)
        .getByRole("button", { name: /Slow Migration/ })
        .and(page.locator(NOT_FAVORITE)),
    ).toHaveCount(0);
    await page.getByLabel("Show archived").check();
    const archived = list(page)
      .getByRole("button", { name: /Slow Migration/ })
      .and(page.locator(NOT_FAVORITE));
    await expect(archived.getByText("Archived")).toBeVisible();
    await archived.click();
    await expect(detail(page).getByLabel("Message")).toBeDisabled();
    await expect(detail(page).getByText("Archived threads are read-only.")).toBeVisible();
    await expect(detail(page).getByRole("button", { name: "Resume" })).toHaveCount(0);
  });

  test("rename works with the keyboard and can be cancelled", async ({ page }) => {
    await openThreads(page, "threads");
    await expect(detail(page).getByRole("heading", { name: "Fix OAuth Callback Race" })).toBeVisible();
    await detail(page).getByRole("button", { name: "Rename thread" }).click();
    const input = detail(page).getByLabel("Thread name");
    await expect(input).toBeFocused();
    await input.fill("Session race fix");
    await input.press("Enter");
    await expect(detail(page).getByRole("heading", { name: "Session race fix" })).toBeVisible();
    await expect(
      list(page)
        .getByRole("button", { name: /Session race fix/ })
        .and(page.locator(NOT_FAVORITE)),
    ).toBeVisible();

    await detail(page).getByRole("button", { name: "Rename thread" }).click();
    await detail(page).getByLabel("Thread name").fill("Discarded");
    await detail(page).getByLabel("Thread name").press("Escape");
    await expect(detail(page).getByRole("heading", { name: "Session race fix" })).toBeVisible();
    await expect(detail(page).getByRole("button", { name: "Rename thread" })).toBeFocused();
  });

  test("the list shows structured status, activity and pending approvals", async ({ page }) => {
    await openThreads(page, "threads");
    const rows = list(page).getByRole("button").and(page.locator(NOT_FAVORITE));
    await expect(rows).toHaveCount(5);
    const running = rows.filter({ hasText: "Fix OAuth Callback Race" });
    await expect(running.getByText("Running a tool")).toBeVisible();
    await expect(running.getByText("Run npm test")).toBeVisible();
    await expect(running.getByText("Claude Code · Personal · kalcode")).toBeVisible();
    const waiting = rows.filter({ hasText: "Add Dark Mode Toggle" });
    await expect(waiting.getByText("Needs approval")).toBeVisible();
    await expect(waiting.getByText("1 approval")).toBeVisible();
    await expect(rows.filter({ hasText: "Write Unit Tests" }).getByText("1 unread message")).toBeAttached();

    // Arrow keys move between rows.
    await running.focus();
    await page.keyboard.press("ArrowDown");
    await expect(waiting).toBeFocused();
    await page.keyboard.press("End");
    await expect(rows.last()).toBeFocused();
  });

  test("a thread waiting for permission blocks messages until interrupted", async ({ page }) => {
    await openThreads(page, "threads");
    await list(page)
      .getByRole("button", { name: /Add Dark Mode Toggle/ })
      .and(page.locator(NOT_FAVORITE))
      .click();
    await expect(detail(page).getByText("Waiting for 1 permission decision")).toBeVisible();
    await expect(detail(page).getByText("Requested: Run npm install lodash")).toBeVisible();
    await expect(detail(page).getByLabel("Message")).toBeDisabled();
    await detail(page).getByRole("button", { name: "Interrupt" }).click();
    await expect(detail(page).getByText("Ready", { exact: true })).toBeVisible();
    await expect(detail(page).getByLabel("Message")).toBeEnabled();
    await expect(
      list(page)
        .getByRole("button", { name: /Add Dark Mode Toggle/ })
        .and(page.locator(NOT_FAVORITE))
        .getByText("1 approval"),
    ).toHaveCount(0);
  });

  test("a request the thread opens is answered in the thread through the permission engine", async ({ page }) => {
    await openThreads(page);
    await createThread(page, "install lodash for the debounce helper");
    const request = detail(page).getByRole("region", { name: "Run npm install lodash" });
    await expect(detail(page).getByText("Waiting for 1 permission decision")).toBeVisible();
    await expect(request.getByText("npm install lodash", { exact: true })).toBeVisible();
    // Deny first, Approve once (primary) last.
    await expect(request.getByRole("button")).toHaveText([
      "Deny",
      "Allow for workspace",
      "Allow for thread",
      "Approve once",
    ]);
    // The same request is waiting in Needs you.
    await expectApprovalItems(page, 1);

    await request.getByRole("button", { name: "Approve once" }).click();
    const tool = conversation(page).getByRole("listitem").filter({ hasText: "Run npm install lodash" });
    await expect(tool.getByText("added 1 package")).toBeVisible();
    await expect(conversation(page).getByText("Installed lodash and wired up the debounce helper.")).toBeVisible();
    await expect(detail(page).getByText("Ready", { exact: true })).toBeVisible();
    await expect(detail(page).getByText("Waiting for 1 permission decision")).toHaveCount(0);
  });

  test("interrupting a waiting thread expires its request", async ({ page }) => {
    await openThreads(page);
    await createThread(page, "install lodash please");
    await expect(detail(page).getByRole("region", { name: "Run npm install lodash" })).toBeVisible();
    await detail(page).getByRole("button", { name: "Interrupt" }).click();
    await expect(detail(page).getByRole("region", { name: "Run npm install lodash" })).toHaveCount(0);
    await expectApprovalItems(page, 0);
  });

  test("failed threads explain why and can be resumed", async ({ page }) => {
    await openThreads(page, "threads");
    await list(page)
      .getByRole("button", { name: /Migrate API to v2/ })
      .and(page.locator(NOT_FAVORITE))
      .click();
    const alert = detail(page).getByRole("alert");
    await expect(alert.getByText("This thread failed")).toBeVisible();
    await expect(alert.getByText("Error code: provider_exited")).toBeVisible();
    await detail(page).getByRole("button", { name: "Resume", exact: true }).click();
    await expect(detail(page).getByRole("alert")).toHaveCount(0);
    // Resumed and idle: nothing runs, so it is archived rather than stopped.
    await expect(detail(page).getByText("Ready", { exact: true })).toBeVisible();
    await expect(detail(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
    await expect(detail(page).getByRole("button", { name: "Archive" })).toBeVisible();
  });

  test("a provider crash fails only that thread", async ({ page }) => {
    await openThreads(page, "threads");
    await createThread(page, "crash test");
    await expect(detail(page).getByRole("alert").getByText("This thread failed")).toBeVisible();
    await expect(
      list(page)
        .getByRole("button", { name: /Fix OAuth Callback Race/ })
        .and(page.locator(NOT_FAVORITE))
        .getByText("Running a tool"),
    ).toBeVisible();
  });

  test("command palette opens the new thread flow and thread search", async ({ page }) => {
    await openThreads(page, "threads");
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Activity", exact: true })
      .click();
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type("new thread");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "New thread" }).getByLabel("Task")).toBeFocused();

    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type("search threads");
    await page.keyboard.press("Enter");
    const search = page.getByRole("searchbox", { name: "Search threads" });
    await expect(search).toBeFocused();
    await page.keyboard.type("readme");
    await expect(list(page).getByRole("button").and(page.locator(NOT_FAVORITE))).toHaveCount(1);
    await expect(
      list(page)
        .getByRole("button", { name: /Update README/ })
        .and(page.locator(NOT_FAVORITE)),
    ).toBeVisible();
    await search.fill("nothing like this");
    await expect(page.getByText('No threads match "nothing like this".')).toBeVisible();
  });

  for (const theme of ["dark", "light"] as const) {
    test(`accessibility in the ${theme} theme`, async ({ page }) => {
      await openThreads(page, "threads");
      await setTheme(page, theme);
      await expect(detail(page).getByRole("heading", { name: "Fix OAuth Callback Race" })).toBeVisible();
      await expectNoSeriousA11yViolations(page);
      await list(page)
        .getByRole("button", { name: /Add Dark Mode Toggle/ })
        .and(page.locator(NOT_FAVORITE))
        .click();
      await expect(detail(page).getByText("Waiting for 1 permission decision")).toBeVisible();
      await expectNoSeriousA11yViolations(page);
      await list(page)
        .getByRole("button", { name: /Migrate API to v2/ })
        .and(page.locator(NOT_FAVORITE))
        .click();
      await expect(detail(page).getByRole("alert")).toBeVisible();
      await expectNoSeriousA11yViolations(page);
      await page.getByRole("button", { name: "New thread" }).first().click();
      await expect(page.getByRole("region", { name: "New thread" }).getByLabel("Task")).toBeVisible();
      await expectNoSeriousA11yViolations(page);
    });
  }
});
