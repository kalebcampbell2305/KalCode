import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Dashboard behaviour against the in-memory transport's Dashboard scenarios
 * (src/ipc/memory/dashboard.ts). Without a scenario the transport mirrors today's native build,
 * where the approval commands (Z4) do not exist yet.
 */

type Scenario = "default" | "busy" | "empty" | "approvals-flood" | "errors" | "loading";

async function open(page: Page, scenario: Scenario = "default") {
  await page.goto(scenario === "default" ? "/" : `/?scenario=${scenario}`);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
}

const main = (page: Page) => page.locator("#main");
const approvals = (page: Page) => page.getByRole("region", { name: /Needs approval/ });
const approvalItems = (page: Page) => approvals(page).getByRole("article");
const threads = (page: Page) => page.getByRole("region", { name: "Threads" });
const recent = (page: Page) => page.getByRole("region", { name: "Recent completions and failures" });
const summary = (page: Page) => page.getByRole("navigation", { name: "Summary" });
const row = (scope: Locator, name: string) => scope.getByRole("listitem").filter({ hasText: name });

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
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("radiogroup", { name: "Theme" })
    .getByRole("radio", { name: theme === "light" ? "Light" : "Dark" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.getByRole("button", { name: "Dashboard" }).click();
}

test.describe("dashboard in a build without approvals", () => {
  test("says so honestly and never shows sample data", async ({ page }) => {
    await open(page);
    await expect(main(page).getByText("No threads are open.")).toBeVisible();
    await expect(approvals(page)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Terminals" }).getByText("No terminals are running.")).toBeVisible();
    await expect(main(page).getByText("Refactor auth middleware")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Activity" }).getByText("KalCode started")).toBeVisible();
  });
});

test.describe("dashboard with running work", () => {
  test("answers what is running, who runs it and what needs approval", async ({ page }) => {
    await open(page, "busy");
    await expect(
      main(page).getByText("2 approvals need you, 1 thread is waiting for your reply and 1 thread failed."),
    ).toBeVisible();
    await expect(summary(page).getByRole("button", { name: "3 Working" })).toBeVisible();
    await expect(summary(page).getByRole("button", { name: "2 Need approval" })).toBeVisible();
    await expect(summary(page).getByRole("button", { name: "1 Failed" })).toBeVisible();
    await expect(summary(page).getByRole("button", { name: "3 Terminals" })).toBeVisible();

    await expect(approvalItems(page)).toHaveCount(2);
    const push = approvalItems(page).filter({ hasText: "Push chore/deps to origin" });
    await expect(push.getByText("Leaves this machine", { exact: true })).toBeVisible();
    await expect(push.getByRole("definition").filter({ hasText: "Bump dependencies" })).toBeVisible();
    await expect(push.getByRole("definition").filter({ hasText: "Claude Code" })).toBeVisible();
    await expect(push.getByRole("definition").filter({ hasText: "kalcode" })).toBeVisible();
    await expect(push.getByRole("definition").filter({ hasText: /^Auto$/ })).toBeVisible();

    const flaky = row(threads(page), "Fix flaky checkout test");
    await expect(flaky.getByText("Running command")).toBeVisible();
    await expect(flaky.getByText("Running pnpm test checkout --repeat 20")).toBeVisible();
    await expect(flaky.getByText("Codex")).toBeVisible();
    await expect(flaky.getByText("gpt-5-codex")).toBeVisible();
    await expect(flaky.getByText("fix/checkout-flake")).toBeVisible();
    await expect(flaky.getByText("2 files changed")).toBeVisible();
    await expect(flaky.getByText("Auto mode")).toBeVisible();
    await expect(flaky.getByText("18 min")).toBeVisible();

    await expect(threads(page).getByRole("heading", { name: /Needs you/ })).toBeVisible();
    await expect(row(recent(page), "Deploy preview build").getByText("Gemini CLI exited unexpectedly")).toBeVisible();
    await expect(page.getByRole("region", { name: "Terminals" }).getByText("Git Bash")).toBeVisible();
    // Thread events in the activity feed name their thread.
    await expect(
      page.getByRole("region", { name: "Activity" }).getByRole("listitem").filter({ hasText: "Tool requested" }),
    ).toContainText("Fix flaky checkout test");
  });

  test("offers only the actions valid for each thread's state", async ({ page }) => {
    await open(page, "busy");
    const expectActions = async (scope: Locator, name: string, present: string[], absent: string[]) => {
      const item = row(scope, name);
      for (const action of present) await expect(item.getByRole("button", { name: `${action} ${name}` })).toBeVisible();
      for (const action of absent) await expect(item.getByRole("button", { name: `${action} ${name}` })).toHaveCount(0);
    };
    await expectActions(
      threads(page),
      "Fix flaky checkout test",
      ["Open", "Pause", "Stop"],
      ["Resume", "Retry", "Archive"],
    );
    await expectActions(threads(page), "Update onboarding copy", ["Open", "Stop"], ["Pause", "Resume", "Archive"]);
    await expectActions(threads(page), "Profile cold start", ["Open", "Resume", "Stop"], ["Pause", "Archive"]);
    await expectActions(threads(page), "Draft release notes", ["Open", "Stop", "Archive"], ["Pause", "Resume"]);
    await expectActions(
      recent(page),
      "Deploy preview build",
      ["Open", "Retry", "Archive"],
      ["Stop", "Pause", "Resume"],
    );
    await expectActions(recent(page), "Add light theme tokens", ["Open", "Archive"], ["Stop", "Retry", "Resume"]);
    await expectActions(recent(page), "Migrate logger to structured output", ["Open", "Resume", "Archive"], ["Stop"]);
  });

  test("approving once removes the request and the thread moves on", async ({ page }) => {
    await open(page, "busy");
    const push = approvalItems(page).filter({ hasText: "Push chore/deps to origin" });
    await push.getByRole("button", { name: "Approve once" }).click();
    await expect(approvalItems(page)).toHaveCount(1);
    await expect(summary(page).getByRole("button", { name: "1 Needs approval" })).toBeVisible();
    const bump = row(threads(page), "Bump dependencies");
    await expect(bump.getByText("Using a tool")).toBeVisible();
    await expect(bump.getByText("Running git push")).toBeVisible();
    await expect(page.getByTestId("announce-polite")).toHaveText("Approved once: Push chore/deps to origin");
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Approved", { exact: true })).toBeVisible();
  });

  test("approvals are decided from the keyboard and focus stays in the queue", async ({ page }) => {
    await open(page, "busy");
    const first = approvalItems(page).first();
    await expect(first).toContainText("Push chore/deps to origin");
    await first.focus();
    await expect(first.locator("[id$='-keys']")).toBeVisible();
    await page.keyboard.press("d");
    await expect(approvalItems(page)).toHaveCount(1);
    const next = approvalItems(page).first();
    await expect(next).toContainText("Install zod");
    await expect(next).toBeFocused();
    await expect(page.getByTestId("announce-polite")).toHaveText("Denied: Push chore/deps to origin");

    await page.keyboard.press("t");
    await expect(approvals(page).getByText("Nothing is waiting for your approval.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Needs approval" })).toBeFocused();
    await expect(row(threads(page), "Refactor auth middleware").getByText("Installing zod@4.1.0")).toBeVisible();
  });

  test("letters typed on a focused button never decide", async ({ page }) => {
    await open(page, "busy");
    const first = approvalItems(page).first();
    await first.getByRole("button", { name: "Deny" }).focus();
    await page.keyboard.press("a");
    await expect(approvalItems(page)).toHaveCount(2);
  });

  test("an approval that arrives live is shown and announced", async ({ page }) => {
    await open(page, "busy");
    await expect(approvalItems(page)).toHaveCount(2);
    await page.evaluate(() => {
      (
        window as unknown as { __kalcodeMemory: { dashboard: { requestApproval(): void } } }
      ).__kalcodeMemory.dashboard.requestApproval();
    });
    await expect(approvalItems(page)).toHaveCount(3);
    const arrived = approvalItems(page).filter({ hasText: "Run pnpm prisma migrate dev" });
    await expect(arrived).toHaveAttribute("data-arrived", "true");
    await expect(page.getByTestId("announce-urgent")).toHaveText("New approval request: Run pnpm prisma migrate dev");
    await expect(row(threads(page), "Write invoices migration").getByText("Needs approval")).toBeVisible();
  });

  test("stopping asks for confirmation; Escape cancels and returns focus", async ({ page }) => {
    await open(page, "busy");
    const flaky = row(threads(page), "Fix flaky checkout test");
    await flaky.getByRole("button", { name: "Stop Fix flaky checkout test" }).click();
    await expect(flaky.getByText("Stop this thread?")).toBeVisible();
    await expect(flaky.getByRole("button", { name: "Stop thread" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(flaky.getByText("Stop this thread?")).toHaveCount(0);
    await expect(flaky.getByRole("button", { name: "Stop Fix flaky checkout test" })).toBeFocused();

    await flaky.getByRole("button", { name: "Stop Fix flaky checkout test" }).click();
    await flaky.getByRole("button", { name: "Stop thread" }).click();
    const stopped = row(recent(page), "Fix flaky checkout test");
    await expect(stopped.getByText("Stopped", { exact: true })).toBeVisible();
    await expect(stopped.getByRole("button", { name: "Resume Fix flaky checkout test" })).toBeVisible();
    await expect(row(threads(page), "Fix flaky checkout test")).toHaveCount(0);
  });

  test("pause, resume, retry and archive go through the thread commands", async ({ page }) => {
    await open(page, "busy");
    await row(threads(page), "Review billing pull request")
      .getByRole("button", { name: "Pause Review billing pull request" })
      .click();
    await expect(row(threads(page), "Review billing pull request").getByText("Paused", { exact: true })).toBeVisible();

    await row(threads(page), "Profile cold start").getByRole("button", { name: "Resume Profile cold start" }).click();
    await expect(row(threads(page), "Profile cold start").getByText("Starting")).toBeVisible();

    await row(recent(page), "Deploy preview build").getByRole("button", { name: "Retry Deploy preview build" }).click();
    const retried = row(threads(page), "Deploy preview build");
    await expect(retried.getByText("Starting")).toBeVisible();
    await expect(retried.getByText("Retrying the failed step")).toBeVisible();
    await expect(summary(page).getByRole("button", { name: "0 Failed" })).toBeVisible();

    await row(recent(page), "Add light theme tokens")
      .getByRole("button", { name: "Archive Add light theme tokens" })
      .click();
    await expect(row(recent(page), "Add light theme tokens")).toHaveCount(0);
    await expect(row(threads(page), "Add light theme tokens")).toHaveCount(0);
    await expect(page.getByTestId("announce-polite")).toHaveText("Add light theme tokens archived");
  });

  test("Open goes to the Threads surface", async ({ page }) => {
    await open(page, "busy");
    await row(threads(page), "Fix flaky checkout test")
      .getByRole("button", { name: "Open Fix flaky checkout test" })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toBeVisible();
  });

  test("summary counts move focus to the section that explains them", async ({ page }) => {
    await open(page, "busy");
    await summary(page).getByRole("button", { name: "2 Need approval" }).click();
    await expect(page.getByRole("heading", { name: "Needs approval" })).toBeFocused();
    await summary(page).getByRole("button", { name: "1 Failed" }).click();
    await expect(page.getByRole("heading", { name: "Recent completions and failures" })).toBeFocused();
  });

  test("a flood of approvals stays readable", async ({ page }) => {
    await open(page, "approvals-flood");
    await expect(approvals(page).getByRole("heading", { name: "Needs approval 9" })).toBeVisible();
    await expect(approvalItems(page)).toHaveCount(5);
    await approvals(page).getByRole("button", { name: "Show 4 more" }).click();
    await expect(approvalItems(page)).toHaveCount(9);
    await expect(
      approvalItems(page)
        .filter({ hasText: "Deploy atlas-api to production" })
        .getByText("Leaves this machine", { exact: true }),
    ).toBeVisible();
  });
});

test.describe("dashboard states", () => {
  test("empty: guides the user to start a thread", async ({ page }) => {
    await open(page, "empty");
    await expect(main(page).getByText("No threads are open.")).toBeVisible();
    await expect(approvals(page).getByText("Nothing is waiting for your approval.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Terminals" }).getByText("No terminals are running.")).toBeVisible();
    await expect(recent(page)).toHaveCount(0);
    await main(page).getByRole("button", { name: "Go to Threads" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toBeVisible();
  });

  test("errors: each source explains its failure and recovers on retry", async ({ page }) => {
    await open(page, "errors");
    await expect(threads(page).getByRole("heading", { name: "Threads couldn't load" })).toBeVisible();
    await expect(threads(page).getByText("Error code: database/database_busy")).toBeVisible();
    await expect(approvals(page).getByRole("heading", { name: "Approval requests couldn't load" })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Terminals" }).getByText("Your terminals keep running."),
    ).toBeVisible();
    await page.evaluate(() => {
      (
        window as unknown as { __kalcodeMemory: { dashboard: { recover(): void } } }
      ).__kalcodeMemory.dashboard.recover();
    });
    await threads(page).getByRole("button", { name: "Try again" }).click();
    await expect(row(threads(page), "Fix flaky checkout test")).toBeVisible();
    await approvals(page).getByRole("button", { name: "Try again" }).click();
    await expect(approvalItems(page)).toHaveCount(2);
  });

  test("loading: skeletons are announced as busy", async ({ page }) => {
    await open(page, "loading");
    await expect(threads(page).getByRole("status").filter({ hasText: "Loading threads" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(approvals(page).getByRole("status").filter({ hasText: "Loading approval requests" })).toBeAttached();
    await expect(main(page).getByRole("status").filter({ hasText: "Loading summary" })).toBeAttached();
  });
});

test.describe("dashboard accessibility", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const scenario of ["default", "busy", "approvals-flood", "empty", "errors", "loading"] as const) {
      test(`${scenario} passes axe in ${theme} theme`, async ({ page }) => {
        await open(page, scenario);
        await setTheme(page, theme);
        if (scenario === "busy" || scenario === "approvals-flood")
          await expect(approvalItems(page).first()).toBeVisible();
        if (scenario === "errors")
          await expect(threads(page).getByRole("heading", { name: "Threads couldn't load" })).toBeVisible();
        await expect(page.getByRole("region", { name: "Activity" }).getByText("KalCode started")).toBeVisible();
        await expectNoSeriousA11yViolations(page);
        if (scenario === "busy") {
          // Focused request (shortcut hints visible) and a pending stop confirmation.
          await approvalItems(page).first().focus();
          await row(threads(page), "Fix flaky checkout test")
            .getByRole("button", { name: "Stop Fix flaky checkout test" })
            .click();
          await expectNoSeriousA11yViolations(page);
        }
      });
    }
  }

  test("keyboard order: summary, approvals, then threads", async ({ page }) => {
    await open(page, "busy");
    await summary(page).getByRole("button", { name: "3 Terminals" }).focus();
    await page.keyboard.press("Tab");
    await expect(approvalItems(page).first()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(approvalItems(page).first().getByRole("button", { name: "Deny" })).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(approvalItems(page).first().getByRole("button", { name: "Approve once" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(approvalItems(page).nth(1)).toBeFocused();
  });
});
