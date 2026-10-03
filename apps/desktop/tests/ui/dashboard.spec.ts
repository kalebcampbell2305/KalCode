import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * The live Dashboard (Z7-W3) against the in-memory transport's Dashboard scenarios
 * (src/ipc/memory/dashboard.ts). Without a scenario the transport mirrors a fresh native install.
 */

type Scenario =
  | "default"
  | "busy"
  | "empty"
  | "archived"
  | "approvals-flood"
  | "errors"
  | "loading"
  | "dash-1"
  | "dash-6"
  | "dash-20"
  | "dash-50";

async function open(page: Page, scenario: Scenario = "default", extra = "") {
  const query = [scenario === "default" ? "" : `scenario=${scenario}`, extra].filter(Boolean).join("&");
  await page.goto(query ? `/?${query}` : "/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
}

const main = (page: Page) => page.locator("#main");
const board = (page: Page) => page.getByRole("region", { name: "Agents", exact: true });
const card = (page: Page, name: string) => board(page).getByRole("article", { name, exact: true });
const cards = (page: Page) => board(page).getByRole("article");
const chips = (page: Page) => page.getByRole("group", { name: "Filter agents" });
const chip = (page: Page, label: string) => chips(page).getByRole("button", { name: new RegExp(`^${label}, \\d+$`) });
const dock = (page: Page) => page.getByRole("complementary", { name: "Widgets" });

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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("radiogroup", { name: "Theme" })
    .getByRole("radio", { name: theme === "light" ? "Light" : "Dark" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
}

test.describe("a fresh session", () => {
  test("says so honestly and never shows sample data", async ({ page }) => {
    await open(page);
    await expect(board(page).getByRole("heading", { name: "No agents yet" })).toBeVisible();
    await expect(chips(page)).toHaveCount(0);
    await expect(dock(page).getByText("Nothing is waiting for your approval.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Terminals" }).getByText("No terminals are running.")).toBeVisible();
    await expect(main(page).getByText("Refactor auth middleware")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Activity" }).getByText("KalCode started")).toBeVisible();
  });
});

test.describe("counts, filters, search and grouping", () => {
  test("the summary and chip counts come from real runtime state", async ({ page }) => {
    await open(page, "busy");
    await expect(main(page).getByText("13 agents · 3 working · 4 waiting for you · 2 done · 4 idle")).toBeVisible();
    await expect(chip(page, "All")).toHaveAccessibleName("All, 13");
    await expect(chip(page, "Waiting for you")).toHaveAccessibleName("Waiting for you, 4");
    await expect(chip(page, "Working")).toHaveAccessibleName("Working, 3");
    await expect(chip(page, "Done")).toHaveAccessibleName("Done, 2");
    await expect(chip(page, "Idle")).toHaveAccessibleName("Idle, 4");
    await expect(cards(page)).toHaveCount(13);
  });

  test("chips filter instantly and say what they show", async ({ page }) => {
    await open(page, "busy");
    await chip(page, "Working").click();
    await expect(chip(page, "Working")).toHaveAttribute("aria-pressed", "true");
    await expect(cards(page)).toHaveCount(3);
    await expect(card(page, "Fix flaky checkout test")).toBeVisible();
    await chip(page, "Waiting for you").click();
    await expect(cards(page)).toHaveCount(4);
    // FAILED needs attention, so it is waiting for you.
    await expect(card(page, "Deploy preview build")).toBeVisible();
    await chip(page, "Done").click();
    await expect(cards(page)).toHaveCount(2);
    await chip(page, "Idle").click();
    await expect(cards(page)).toHaveCount(4);
    await expect(board(page).getByText("Showing 4 idle.")).toBeAttached();
    await chip(page, "All").click();
    await expect(cards(page)).toHaveCount(13);
  });

  test("search narrows by name, workspace, branch and activity; Escape clears it", async ({ page }) => {
    await open(page, "busy");
    const search = page.getByRole("searchbox", { name: "Search agents" });
    await search.fill("atlas");
    await expect(cards(page)).toHaveCount(5);
    await search.fill("chore/deps");
    await expect(cards(page)).toHaveCount(1);
    await search.fill("nothing like this");
    await expect(board(page).getByText("No agents match “nothing like this”.")).toBeVisible();
    await search.press("Escape");
    await expect(cards(page)).toHaveCount(13);
  });

  test("groups by status, project and provider — never by agent or mission (not built yet)", async ({ page }) => {
    await open(page, "busy");
    const groupBy = page.getByRole("radiogroup", { name: "Group by" });
    await expect(groupBy.getByRole("radio")).toHaveText(["Status", "Project", "Provider"]);
    const headings = board(page).getByRole("heading", { level: 2 });
    await expect(headings).toHaveText([/^Needs you/, /^Working/, /^Done/, /^Idle/]);
    await groupBy.getByRole("radio", { name: "Project" }).click();
    await expect(headings).toHaveText([/^kalcode/, /^atlas-api/, /^field-notes/]);
    await groupBy.getByRole("radio", { name: "Provider" }).click();
    await expect(headings).toHaveCount(3);
    await expect(board(page).getByRole("heading", { level: 2, name: /Gemini CLI/ })).toBeVisible();
    // Collapsing a group keeps its heading and hides its cards.
    await board(page)
      .getByRole("button", { name: /^Gemini CLI/ })
      .click();
    await expect(board(page).getByRole("button", { name: /^Gemini CLI/ })).toHaveAttribute("aria-expanded", "false");
    await expect(card(page, "Deploy preview build")).toHaveCount(0);
    // The grouping is remembered.
    await page.reload();
    await expect(
      page.getByRole("radiogroup", { name: "Group by" }).getByRole("radio", { name: "Provider" }),
    ).toBeChecked();
  });
});

test.describe("cards", () => {
  test("show provider, name, workspace, branch, activity, status, mode and last activity", async ({ page }) => {
    await open(page, "busy");
    const fix = card(page, "Fix flaky checkout test");
    // Agent Fleet call sign: the provider plus a letter.
    await expect(fix.getByText(/^Codex [A-Z]+$/)).toBeVisible();
    await expect(fix.getByText("gpt-5-codex")).toBeVisible();
    await expect(fix.getByText("atlas-api")).toBeVisible();
    await expect(fix.getByText("fix/checkout-flake")).toBeVisible();
    await expect(fix.getByText("Running pnpm test checkout --repeat 20")).toBeVisible();
    await expect(fix.getByText("Working", { exact: true })).toBeVisible();
    await expect(fix.getByText("Permission mode Auto")).toBeVisible();
    await expect(fix.locator('time[data-kind="last-activity"]')).toHaveText(/just now|minute/);
    await expect(fix.locator('time[data-kind="started"]')).toHaveText("Started 18 min ago");
  });

  test("show the provider account each agent runs on, in words", async ({ page }) => {
    await open(page, "busy");
    const fix = card(page, "Fix flaky checkout test");
    await expect(fix.getByTitle("Account: Work")).toHaveText("account Work");
    await expect(fix.getByTitle("Account: Work")).toBeVisible();
    const auth = card(page, "Refactor auth middleware");
    await expect(auth.getByTitle("Account: Personal")).toBeVisible();
    await expect(auth.getByTitle("Account: Work")).toHaveCount(0);
  });

  test("DONE is unmistakable, with its follow-ups", async ({ page }) => {
    await open(page, "busy");
    // (Add light theme tokens is ready to merge in this fixture; see fleet.spec.ts.)
    const done = card(page, "Generate API client");
    await expect(done.getByText("Completed", { exact: true })).toBeVisible();
    await expect(done.getByRole("button", { name: "Open" })).toBeVisible();
    await done.getByRole("button", { name: "More actions for Generate API client" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Open", "Archive"]);
  });

  test("ACTION NEEDED carries the inline approval in the app's order", async ({ page }) => {
    await open(page, "busy");
    const refactor = card(page, "Refactor auth middleware");
    await expect(refactor.getByText("Action needed")).toBeVisible();
    const approval = refactor.getByRole("group", { name: "Install zod" });
    await expect(approval.getByText("pnpm add install zod@4.1.0")).toBeVisible();
    await expect(approval.getByRole("button")).toHaveText([
      "Deny",
      "Allow for workspace",
      "Allow for thread",
      "Approve once",
    ]);
    // Remote-consequential: only Deny and Approve once.
    await expect(
      card(page, "Bump dependencies")
        .getByRole("group", { name: /Push chore/ })
        .getByRole("button"),
    ).toHaveText(["Deny", "Approve once"]);
    await approval.getByRole("button", { name: "Approve once" }).click();
    await expect(refactor.getByText("Installing zod@4.1.0")).toBeVisible();
    await expect(refactor.getByText("Working", { exact: true })).toBeVisible();
    await expect(chip(page, "Waiting for you")).toHaveAccessibleName("Waiting for you, 3");
  });

  test("an approval that arrives live turns its card into ACTION NEEDED", async ({ page }) => {
    await open(page, "busy");
    await page.evaluate(() =>
      (
        window as unknown as { __kalcodeMemory: { dashboard: { requestApproval(): void } } }
      ).__kalcodeMemory.dashboard.requestApproval(),
    );
    const migration = card(page, "Write invoices migration");
    await expect(migration.getByRole("group", { name: "Run pnpm prisma migrate dev" })).toBeVisible();
  });

  test("clicking a card opens its agent's terminal in Code, never Threads", async ({ page }) => {
    await open(page, "busy");
    await card(page, "Fix flaky checkout test")
      .getByRole("button", { name: "Fix flaky checkout test", exact: true })
      .click();
    await expect(
      page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toHaveCount(0);
  });

  test("pause, resume, retry and archive go through the thread commands", async ({ page }) => {
    await open(page, "busy");
    const menu = async (name: string, item: string) => {
      await card(page, name)
        .getByRole("button", { name: `More actions for ${name}` })
        .click();
      await page.getByRole("menuitem", { name: item }).click();
    };
    await menu("Review billing pull request", "Pause");
    await expect(card(page, "Review billing pull request").getByText("Paused", { exact: true })).toBeVisible();
    await menu("Profile cold start", "Resume");
    await expect(card(page, "Profile cold start").getByText("Starting", { exact: true })).toBeVisible();
    await card(page, "Deploy preview build").getByRole("button", { name: "Retry" }).click();
    await expect(card(page, "Deploy preview build").getByText("Retrying the failed step")).toBeVisible();
    await menu("Add light theme tokens", "Archive");
    await expect(card(page, "Add light theme tokens")).toHaveCount(0);
    await expect(page.getByTestId("announce-polite")).toHaveText("Add light theme tokens archived");
  });

  test("stopping asks for confirmation; Escape cancels and returns focus", async ({ page }) => {
    await open(page, "busy");
    const fix = card(page, "Fix flaky checkout test");
    const more = fix.getByRole("button", { name: "More actions for Fix flaky checkout test" });
    await more.click();
    await page.getByRole("menuitem", { name: "Stop…" }).click();
    const confirm = fix.getByRole("group", { name: "Stop Fix flaky checkout test?" });
    await expect(confirm.getByRole("button", { name: "Stop agent" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(more).toBeFocused();
    await more.click();
    await page.getByRole("menuitem", { name: "Stop…" }).click();
    await fix.getByRole("button", { name: "Stop agent" }).click();
    await expect(fix.getByText("stopped · resumable")).toBeVisible();
  });
});

test.describe("scale", () => {
  for (const [scenario, count] of [
    ["dash-1", 1],
    ["dash-6", 6],
    ["dash-20", 20],
    ["dash-50", 50],
  ] as const) {
    test(`${count} ${count === 1 ? "agent" : "agents"}: exact counts, readable cards`, async ({ page }) => {
      await open(page, scenario);
      await expect(
        main(page).getByText(new RegExp(`^${count} ${count === 1 ? "agent" : "agents"}( ·|$)`)),
      ).toBeVisible();
      await expect(chip(page, "All")).toHaveAccessibleName(`All, ${count}`);
      // Cards never shrink below a readable width, however many there are.
      const width = await cards(page)
        .first()
        .evaluate((el) => el.getBoundingClientRect().width);
      expect(width).toBeGreaterThanOrEqual(290);
      if (count <= 20) await expect(cards(page)).toHaveCount(count);
    });
  }

  test("50 agents: the board is virtualized, scrolls to the end and search reaches every agent", async ({ page }) => {
    await open(page, "dash-50");
    await expect(board(page).locator("[data-virtualized]")).toHaveCount(1);
    expect(await cards(page).count()).toBeLessThan(50);
    // Rows are measured as they render, so the end moves once or twice while scrolling to it.
    const idle = board(page).getByRole("heading", { level: 2, name: /^Idle/ });
    await expect(async () => {
      // The end of the board (at this width the widget dock sits below it).
      await board(page)
        .locator("[data-virtualized]")
        .evaluate((rows) => {
          const scroller = document.getElementById("main");
          if (scroller) scroller.scrollBy(0, rows.getBoundingClientRect().bottom - scroller.clientHeight);
        });
      await expect(idle).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 10_000 });
    await main(page).evaluate((el) => el.scrollTo(0, 0));
    await page.getByRole("searchbox", { name: "Search agents" }).fill("Add offline banner");
    await expect(cards(page)).toHaveCount(1);
  });
});

test.describe("widgets", () => {
  test("default widgets show, hide, restore, move and resize — and are remembered", async ({ page }) => {
    await open(page, "busy");
    const order = () =>
      dock(page)
        .locator("[data-widget-id]")
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-widget-id")));
    expect(await order()).toEqual([
      "approvals",
      "active-agents",
      "provider-health",
      "activity",
      "terminals",
      "runtime-health",
    ]);
    // At most six widgets show: a hidden one comes back only when there is room.
    await page.getByRole("button", { name: "Provider health options" }).click();
    await page.getByRole("menuitem", { name: "Hide widget" }).click();
    await expect(page.getByRole("region", { name: "Provider health" })).toHaveCount(0);
    await dock(page).getByRole("button", { name: "Customize" }).click();
    await page.getByRole("menuitem", { name: /Show Provider health/ }).click();
    await expect(page.getByRole("region", { name: "Provider health" })).toBeVisible();
    expect((await order()).at(-1)).toBe("provider-health");

    const handle = page.getByRole("button", { name: "Move Activity" });
    await handle.focus();
    await page.keyboard.press("ArrowUp");
    expect(await order()).toEqual([
      "approvals",
      "activity",
      "active-agents",
      "terminals",
      "runtime-health",
      "provider-health",
    ]);
    await expect(handle).toBeFocused();

    const resize = page.getByRole("separator", { name: "Resize Activity" });
    await resize.focus();
    await page.keyboard.press("ArrowDown");
    await expect(resize).toHaveAttribute("aria-valuenow", "384");

    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    expect(await order()).toEqual([
      "approvals",
      "activity",
      "active-agents",
      "terminals",
      "runtime-health",
      "provider-health",
    ]);
    await expect(page.getByRole("separator", { name: "Resize Activity" })).toHaveAttribute("aria-valuenow", "384");
  });

  test("provider health is read-only: it never starts a detection", async ({ page }) => {
    await open(page, "busy");
    const health = page.getByRole("region", { name: "Provider health" });
    await expect(health.getByText("Not checked yet")).toHaveCount(3);
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Provider detected")).toHaveCount(0);
  });

  test("provider health shows each provider's health and links to the Health tab", async ({ page }) => {
    await open(page);
    // Detection runs on the Providers page; the widget only reads the health snapshot.
    await page.getByRole("button", { name: "Providers" }).click();
    await expect(page.getByRole("button", { name: "Check again" })).not.toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("tab", { name: "Accounts" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Dashboard" }).click();

    const health = page.getByRole("region", { name: "Provider health" });
    const row = (id: string) => health.locator(`[data-provider-health="${id}"]`);
    await expect(row("claude-code")).toContainText("Claude Code");
    await expect(row("claude-code")).toContainText("Healthy · 2 sessions");
    await expect(row("claude-code")).toHaveAttribute("data-health-state", "healthy");
    await expect(row("codex")).toContainText("Degraded · 2 failures in the last hour");
    await expect(row("gemini-cli")).toContainText("Healthy · 1 session");
    await expect(health.getByText(/rate limit|quota/i)).toHaveCount(0);

    await health.getByRole("button", { name: "Health details" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Health" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("region", { name: "Provider health" }).locator("#health-codex")).toHaveAttribute(
      "data-health-state",
      "degraded",
    );
    // A later plain visit opens the default tab again.
    await page.getByRole("button", { name: "Dashboard" }).click();
    await page.getByRole("button", { name: "Providers" }).click();
    await expect(page.getByRole("tab", { name: "Accounts" })).toHaveAttribute("aria-selected", "true");
  });

  test("provider health shows sign-in, install and reported rate-limit states in words", async ({ page }) => {
    const visit = async (scenario: string) => {
      await page.goto(`/?scenario=${scenario}`);
      await page.getByRole("button", { name: "Providers" }).click();
      await expect(page.getByRole("button", { name: "Check again" })).not.toHaveAttribute("aria-busy", "true");
      await page.getByRole("button", { name: "Dashboard" }).click();
      return page.getByRole("region", { name: "Provider health" });
    };
    let health = await visit("providers-signed-out");
    await expect(health.locator('[data-provider-health="codex"]')).toContainText("Signed out");
    await expect(health.locator('[data-provider-health="gemini-cli"]')).toContainText("Not installed");
    health = await visit("providers-backoff");
    await expect(health.locator('[data-provider-health="codex"]')).toContainText("Backing off · rate limit reported");
    // The widget follows provider events without a reload.
    await page.evaluate(() => {
      (
        window as unknown as {
          __kalcodeMemory: { health: { observe: (id: string, patch: Record<string, unknown>) => void } };
        }
      ).__kalcodeMemory.health.observe("codex", { backoff: null, failuresSinceSuccess: 0, recentFailures: 0 });
    });
    await expect(health.locator('[data-provider-health="codex"]')).toContainText("Healthy");
    await expectNoSeriousA11yViolations(page);
  });
});

test.describe("KalVoice filters the Dashboard", () => {
  for (const [said, chipLabel, count] of [
    ["show only agents that are working", "Working", 3],
    ["show everything waiting for me", "Waiting for you", 4],
    ["show completed work", "Done", 2],
  ] as const) {
    test(`“${said}”`, async ({ page }) => {
      await open(page, "busy", `transcript=${encodeURIComponent(said)}`);
      await expect(page.getByRole("region", { name: "KalVoice widget" })).toBeVisible();
      await page.keyboard.down("F8");
      await page.waitForTimeout(300);
      await page.keyboard.up("F8");
      await expect(chip(page, chipLabel)).toHaveAttribute("aria-pressed", "true");
      await expect(cards(page)).toHaveCount(count);
    });
  }
});

test.describe("states", () => {
  test("errors: the board explains its failure and recovers on retry", async ({ page }) => {
    await open(page, "errors");
    await expect(board(page).getByRole("heading", { name: "Agents couldn't load" })).toBeVisible();
    await page.evaluate(() =>
      (
        window as unknown as { __kalcodeMemory: { dashboard: { recover(): void } } }
      ).__kalcodeMemory.dashboard.recover(),
    );
    // The board also re-reads threads once by itself when its event history arrives. When that read
    // lands after recover(), the board is already back and "Try again" detaches mid-click, so press it
    // while it is still offered and require the recovered board either way.
    await expect(async () => {
      const retry = board(page).getByRole("button", { name: "Try again" });
      if (await retry.isVisible()) await retry.click({ timeout: 2_000 });
      await expect(cards(page)).toHaveCount(13, { timeout: 2_000 });
    }).toPass();
  });

  test("loading: skeletons are announced as busy", async ({ page }) => {
    await open(page, "loading");
    await expect(board(page).getByRole("status").filter({ hasText: "Loading agents" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  test("empty: guides the person to start work", async ({ page }) => {
    await open(page, "empty");
    await expect(board(page).getByRole("heading", { name: "No agents yet" })).toBeVisible();
    // Agents are coding terminals: the one action launches one from Code (never a Thread).
    await expect(board(page).getByRole("button")).toHaveText(["Launch an agent"]);
    await expect(board(page).getByText(/A CLI you type into a plain terminal isn't tracked here/)).toBeVisible();
    await board(page).getByRole("button", { name: "Launch an agent" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("archived only: says so, shows the archived sessions read-only and restores one", async ({ page }) => {
    await open(page, "archived");
    await expect(board(page).getByRole("heading", { name: "All 3 agents are archived" })).toBeVisible();
    await expect(board(page).getByRole("heading", { name: "No agents yet" })).toHaveCount(0);
    await expect(cards(page)).toHaveCount(0);
    const toggle = board(page).getByRole("button", { name: "Show archived" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const archived = board(page).getByRole("region", { name: /^Archived/ });
    await expect(archived.getByRole("article")).toHaveCount(3);
    const deploy = archived.getByRole("article", { name: "Deploy preview build" });
    await expect(deploy.getByText("Archived", { exact: true })).toBeVisible();
    // Read-only: the only action is Unarchive.
    await expect(deploy.getByRole("button")).toHaveText(["Unarchive"]);
    await expectNoSeriousA11yViolations(page);

    await deploy.getByRole("button", { name: "Unarchive Deploy preview build" }).click();
    await expect(chip(page, "All")).toHaveAccessibleName("All, 1");
    await expect(chip(page, "Waiting for you")).toHaveAccessibleName("Waiting for you, 1");
    await expect(board(page).getByRole("heading", { name: /agents are archived/ })).toHaveCount(0);
    await expect(archived.getByRole("article")).toHaveCount(2);
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Thread restored")).toBeVisible();
  });
});

test.describe("sidebar", () => {
  test("the Dashboard item counts what needs you, from the same list", async ({ page }) => {
    await open(page, "busy");
    const nav = page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Dashboard", exact: true });
    await expect(chip(page, "Waiting for you")).toHaveAccessibleName("Waiting for you, 4");
    await expect(nav).toHaveText("Dashboard4");
    await expect(nav).toHaveAccessibleDescription("4 sessions need you");
    // Pausing the thread that waits for permission leaves three.
    await card(page, "Refactor auth middleware")
      .getByRole("button", { name: "More actions for Refactor auth middleware" })
      .click();
    await page.getByRole("menuitem", { name: "Pause" }).click();
    await expect(nav).toHaveText("Dashboard3");
    await expect(nav).toHaveAccessibleDescription("3 sessions need you");
  });

  test("the Dashboard item shows no count when nothing needs you", async ({ page }) => {
    await open(page, "empty");
    const nav = page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Dashboard", exact: true });
    await expect(board(page).getByRole("heading", { name: "No agents yet" })).toBeVisible();
    await expect(nav).toHaveText("Dashboard");
    await expect(nav).not.toHaveAttribute("aria-describedby");
  });
});

test.describe("accessibility", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const scenario of ["default", "busy", "empty", "errors", "dash-50"] as const) {
      test(`${scenario} passes axe in ${theme} theme`, async ({ page }) => {
        await open(page, scenario);
        await setTheme(page, theme);
        if (scenario === "busy" || scenario === "dash-50") await expect(cards(page).first()).toBeVisible();
        await expect(
          page.getByRole("region", { name: "Activity" }).getByText("KalCode started").first(),
        ).toBeAttached();
        await expectNoSeriousA11yViolations(page);
        if (scenario === "busy") {
          // A pending stop confirmation and a filtered, grouped board.
          await card(page, "Fix flaky checkout test")
            .getByRole("button", { name: "More actions for Fix flaky checkout test" })
            .click();
          await page.getByRole("menuitem", { name: "Stop…" }).click();
          await chip(page, "Waiting for you").click();
          await page.getByRole("radiogroup", { name: "Group by" }).getByRole("radio", { name: "Project" }).click();
          await expectNoSeriousA11yViolations(page);
        }
      });
    }
  }

  test("keyboard order: chips, search, grouping, then the first card", async ({ page }) => {
    await open(page, "busy");
    await chip(page, "All").focus();
    for (let i = 0; i < 4; i += 1) await page.keyboard.press("Tab");
    await expect(chip(page, "Idle")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("searchbox", { name: "Search agents" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("radio", { name: "Status" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(board(page).getByRole("button", { name: /^Needs you/ })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      card(page, "Refactor auth middleware").getByRole("button", { name: "Refactor auth middleware", exact: true }),
    ).toBeFocused();
  });
});
