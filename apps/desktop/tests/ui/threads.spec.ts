import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * Threads surface against the in-memory transport: fixture provider detection (Claude Code
 * installed and signed in, Codex installed without an adapter, Gemini CLI missing), workspaces
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
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  // Without a Threads scenario, threads run in folders opened in Code (Z1).
  if (!scenario) await openFolders(page, "kalcode", "kalcoded.com");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Threads" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toBeVisible();
}

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
    await expect(page.getByRole("region", { name: "Thread list" }).getByText("No threads yet.")).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });

  test("new thread flow creates a thread and streams its work", async ({ page }) => {
    await openThreads(page);
    await page.getByRole("button", { name: "New thread" }).first().click();
    const form = page.getByRole("region", { name: "New thread" });
    await expect(form.getByRole("heading", { name: "New thread" })).toBeVisible();

    // Defaults: first provider, provider's default model, first workspace, Approve.
    await expect(form.getByLabel("Provider")).toHaveValue("claude-code");
    await expect(form.getByLabel("Model")).toHaveValue("");
    await expect(form.getByRole("radio", { name: "Approve" })).toBeChecked();
    await expect(form.getByText("Edits, commands and network access wait for your approval.")).toBeVisible();
    await expect(form.getByRole("button", { name: "Start thread" })).toBeDisabled();

    await form.getByLabel("Model").selectOption("opus");
    await form.getByLabel("Workspace").selectOption({ label: "kalcoded.com" });
    await form.getByLabel("Task").fill("fix the OAuth callback race in the login flow");
    await form.getByLabel("Task").press(`${MOD}+Enter`);

    const row = list(page).getByRole("button", { name: /Fix OAuth Callback Race/ });
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
    await page.getByRole("button", { name: "Dashboard" }).click();
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity.getByText("Thread created")).toBeVisible();
    await expect(activity.getByText("Tool finished").first()).toBeVisible();
  });

  test("only providers that can run threads are offered; the others say why", async ({ page }) => {
    await openThreads(page);
    await page.getByRole("button", { name: "New thread" }).first().click();
    const form = page.getByRole("region", { name: "New thread" });
    await expect(form.getByLabel("Provider").locator("option")).toHaveText(["Claude Code (Personal)"]);
    const others = form.getByRole("list", { name: "Not available for threads" });
    await expect(others.getByRole("listitem")).toHaveCount(2);
    await expect(others.getByRole("listitem").filter({ hasText: "Codex" })).toContainText(
      "Installed, but KalCode can't run threads with it yet",
    );
    await expect(others.getByRole("listitem").filter({ hasText: "Gemini CLI" })).toContainText(
      "KalCode can't run threads with it yet",
    );
  });

  test("an explicit name and permission mode are used", async ({ page }) => {
    await openThreads(page);
    await page.getByRole("button", { name: "New thread" }).first().click();
    const form = page.getByRole("region", { name: "New thread" });
    await expect(form.getByLabel("Model")).toHaveValue("");
    const approve = form.getByRole("radio", { name: "Approve" });
    await approve.focus();
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

  test("without a workspace, New thread points to Code", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Threads" }).click();
    await page.getByRole("button", { name: "New thread" }).first().click();
    await expect(page.getByRole("heading", { name: "No workspaces yet" })).toBeVisible();
    await page.getByRole("button", { name: "Open Code" }).click();
    await expect(page.getByRole("heading", { name: "Open a project folder" })).toBeVisible();
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

  test("stop, resume and archive follow the thread's state", async ({ page }) => {
    await openThreads(page);
    await createThread(page, "slow migration");
    await detail(page).getByRole("button", { name: "Stop" }).click();
    await expect(detail(page).getByText("Stopped", { exact: true })).toBeVisible();
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
    await expect(list(page).getByRole("button", { name: /Slow Migration/ })).toHaveCount(0);
    await page.getByLabel("Show archived").check();
    const archived = list(page).getByRole("button", { name: /Slow Migration/ });
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
    await expect(list(page).getByRole("button", { name: /Session race fix/ })).toBeVisible();

    await detail(page).getByRole("button", { name: "Rename thread" }).click();
    await detail(page).getByLabel("Thread name").fill("Discarded");
    await detail(page).getByLabel("Thread name").press("Escape");
    await expect(detail(page).getByRole("heading", { name: "Session race fix" })).toBeVisible();
    await expect(detail(page).getByRole("button", { name: "Rename thread" })).toBeFocused();
  });

  test("the list shows structured status, activity and pending approvals", async ({ page }) => {
    await openThreads(page, "threads");
    const rows = list(page).getByRole("button");
    await expect(rows).toHaveCount(5);
    const running = rows.filter({ hasText: "Fix OAuth Callback Race" });
    await expect(running.getByText("Running a tool")).toBeVisible();
    await expect(running.getByText("Run npm test")).toBeVisible();
    await expect(running.getByText("Claude Code · kalcode")).toBeVisible();
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
        .getByText("1 approval"),
    ).toHaveCount(0);
  });

  test("failed threads explain why and can be resumed", async ({ page }) => {
    await openThreads(page, "threads");
    await list(page)
      .getByRole("button", { name: /Migrate API to v2/ })
      .click();
    const alert = detail(page).getByRole("alert");
    await expect(alert.getByText("This thread failed")).toBeVisible();
    await expect(alert.getByText("Error code: provider_exited")).toBeVisible();
    await detail(page).getByRole("button", { name: "Resume", exact: true }).click();
    await expect(detail(page).getByRole("alert")).toHaveCount(0);
    await expect(detail(page).getByRole("button", { name: "Stop" })).toBeVisible();
  });

  test("a provider crash fails only that thread", async ({ page }) => {
    await openThreads(page, "threads");
    await createThread(page, "crash test");
    await expect(detail(page).getByRole("alert").getByText("This thread failed")).toBeVisible();
    await expect(
      list(page)
        .getByRole("button", { name: /Fix OAuth Callback Race/ })
        .getByText("Running a tool"),
    ).toBeVisible();
  });

  test("command palette opens the new thread flow and thread search", async ({ page }) => {
    await openThreads(page, "threads");
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Dashboard" }).click();
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
    await expect(list(page).getByRole("button")).toHaveCount(1);
    await expect(list(page).getByRole("button", { name: /Update README/ })).toBeVisible();
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
        .click();
      await expect(detail(page).getByText("Waiting for 1 permission decision")).toBeVisible();
      await expectNoSeriousA11yViolations(page);
      await list(page)
        .getByRole("button", { name: /Migrate API to v2/ })
        .click();
      await expect(detail(page).getByRole("alert")).toBeVisible();
      await expectNoSeriousA11yViolations(page);
      await page.getByRole("button", { name: "New thread" }).first().click();
      await expect(page.getByRole("region", { name: "New thread" }).getByLabel("Task")).toBeVisible();
      await expectNoSeriousA11yViolations(page);
    });
  }
});
