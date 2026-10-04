import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * Terminal Organization in Code against the in-memory runtime: purpose names, status badges from
 * the related-process scan and terminal records, the Terminal Stack (groups, pins, finished work),
 * the quick bar and What's Happening.
 */

type Memory = {
  __kalcodeMemory: {
    setTerminalWork: (terminalId: string, names: string[]) => void;
    operations: { lastAction(): string | null };
  };
};

async function openCode(page: Page) {
  await page.goto("/?scenario=code");
  const heading = page.getByRole("heading", { level: 1, name: "kalcode-site" });
  if (!(await heading.isVisible())) {
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  }
  await expect(heading).toBeVisible();
}

const stack = (page: Page) => page.getByRole("complementary", { name: "Terminal stack" });
const strip = (page: Page) => page.getByRole("group", { name: "What's happening" });

async function showStack(page: Page) {
  if (await stack(page).isVisible()) return;
  await page.getByRole("button", { name: /^Show the terminal stack/ }).click();
  await expect(stack(page)).toBeVisible();
}

/** The id of the first terminal tab's terminal. */
async function firstTerminalId(page: Page): Promise<string> {
  const key = await page
    .locator('[role="tab"][data-content-key^="terminal:"]')
    .first()
    .getAttribute("data-content-key");
  expect(key).toBeTruthy();
  return (key as string).slice("terminal:".length);
}

async function setWork(page: Page, terminalId: string, names: string[]) {
  await page.evaluate(({ id, list }) => (window as unknown as Memory).__kalcodeMemory.setTerminalWork(id, list), {
    id: terminalId,
    list: names,
  });
}

async function expectNoSeriousA11yViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
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

test("the quick bar keeps the Code actions in one compact row", async ({ page }) => {
  await openCode(page);
  const actions = page.locator("#code-actions");
  for (const name of ["New agent", "New terminal", "Browser", "Widgets", "Run Tests", "Focus"]) {
    await expect(actions.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(actions.getByRole("button", { name: "KalTidy: Stop idle terminals" })).toBeVisible();
  // The order the owner asked for: + Agent, + Terminal, Browser, Widgets, Run Tests, KalTidy, Focus.
  const xOf = async (name: string) => (await actions.getByRole("button", { name, exact: true }).boundingBox())?.x ?? -1;
  const order = await Promise.all(
    ["New agent", "New terminal", "Browser", "Widgets", "Run Tests", "KalTidy: Stop idle terminals", "Focus"].map(xOf),
  );
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // One row, never a second status bar.
  const header = await page.locator("#code-actions").boundingBox();
  expect(header?.height ?? 99).toBeLessThanOrEqual(46);
});

test("What's Happening says only what it observed, and each part opens it", async ({ page }) => {
  await openCode(page);
  const happening = strip(page);
  // The scenario's queued test task, its live dev server and its Git summary.
  await expect(happening).toContainText("tests queued");
  await expect(happening).toContainText("localhost:3000");
  await expect(happening.getByRole("button", { name: /feature\/oauth-race/ })).toBeVisible();
  // No agent is working and nothing needs you, so those parts are absent rather than "0".
  await expect(happening).not.toContainText("agents working");
  await expect(happening).not.toContainText("needs you");

  await happening.getByRole("button", { name: "localhost:3000" }).click();
  await expect(page.getByRole("tab", { name: "Browser", exact: true })).toBeVisible();

  await happening.getByRole("button", { name: "tests queued" }).click();
  const context = page.getByRole("region", { name: "Workspace context for kalcode-site" });
  await expect(context.getByRole("tab", { name: /Tests/ })).toHaveAttribute("aria-selected", "true");
});

test("terminal badges follow the real process tree and exit codes", async ({ page }) => {
  await openCode(page);
  await showStack(page);
  const id = await firstTerminalId(page);
  const title = (await page.locator(`[role="tab"][data-content-key="terminal:${id}"]`).getAttribute("title")) ?? "";
  const name = title.split(" — ")[0] ?? "";
  const item = stack(page)
    .getByRole("button", { name: new RegExp(`^${name.replace(/[()]/g, "\\$&")},`) })
    .first();

  // A shell at its prompt is Ready.
  await expect(item).toHaveAccessibleName(/Ready: At its prompt/, { timeout: 15_000 });
  // A command under the shell is Working (from the process scan, not a timer).
  await setWork(page, id, ["node.exe"]);
  await expect(item).toHaveAccessibleName(/Working: Running node/, { timeout: 15_000 });
  await setWork(page, id, []);
  await expect(item).toHaveAccessibleName(/Ready/, { timeout: 15_000 });

  // A shell that exits with a code is Failed, never Done.
  await page.locator(`[role="tab"][data-content-key="terminal:${id}"]`).click();
  await page.keyboard.type("exit 3");
  await page.keyboard.press("Enter");
  await expect(item).toHaveAccessibleName(/Failed: Exit code 3/);
});

test("the stack keeps active work visible, collapses finished work unless pinned, and remembers groups", async ({
  page,
}) => {
  await openCode(page);
  await showStack(page);
  // Two more terminals; the first one ends normally.
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  const id = await firstTerminalId(page);
  await page.locator(`[role="tab"][data-content-key="terminal:${id}"]`).click();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  // Focus another terminal: the ended one is no longer focused, so it folds into Finished.
  await page.locator('[role="tab"][data-content-key^="terminal:"]').last().click();
  const terminals = stack(page).getByRole("region", { name: "Terminals group" });
  const finished = terminals.getByRole("button", { name: /^Finished · 1/ });
  await expect(finished).toBeVisible();
  await expect(finished).toHaveAttribute("aria-expanded", "false");
  await finished.click();
  const done = terminals.getByRole("button", { name: /Done: Exited normally/ });
  await expect(done).toBeVisible();

  // Pinned work never folds; nothing is ever removed.
  await terminals
    .getByRole("button", { name: /^More for / })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await finished.click();
  await expect(terminals.getByRole("button", { name: /pinned/ })).toBeVisible();

  // Moving an item to another group, and a new group, both stay after a reload.
  const firstMenu = terminals.getByRole("button", { name: /^More for / }).first();
  await firstMenu.click();
  await page.getByRole("menuitemradio", { name: "Tests" }).click();
  const testsGroup = stack(page).getByRole("region", { name: "Tests group" });
  await expect(testsGroup.getByRole("listitem")).toHaveCount(1);
  await stack(page).getByRole("button", { name: "New group" }).click();
  await stack(page).getByRole("textbox", { name: "Group name" }).fill("Docs");
  await page.keyboard.press("Enter");
  await expect(stack(page).getByRole("region", { name: "Docs group" })).toBeVisible();
  await testsGroup.getByRole("button", { name: /^Tests/ }).click();
  await expect(testsGroup.getByRole("button", { name: /^Tests/ })).toHaveAttribute("aria-expanded", "false");

  // Another workspace has its own organization; coming back restores this one's (remembered per
  // workspace). api-server's terminals ended when KalCode closed: Idle, never Done or Failed.
  await page.getByRole("heading", { level: 1, name: "kalcode-site" }).getByRole("button").click();
  await page.getByRole("menuitemradio", { name: /api-server/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "api-server" })).toBeVisible();
  await showStack(page);
  await expect(stack(page).getByRole("region", { name: "Docs group" })).toHaveCount(0);
  // The focused one stays visible; any others fold under Finished.
  for (const toggle of await stack(page)
    .getByRole("button", { name: /^Finished · / })
    .all())
    await toggle.click();
  await expect(
    stack(page)
      .getByRole("button", { name: /Idle: Ended when KalCode closed/ })
      .first(),
  ).toBeVisible();
  await page.getByRole("heading", { level: 1, name: "api-server" }).getByRole("button").click();
  await page.getByRole("menuitemradio", { name: /kalcode-site/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
  await expect(stack(page)).toBeVisible();
  await expect(stack(page).getByRole("region", { name: "Docs group" })).toBeVisible();
  await expect(
    stack(page)
      .getByRole("region", { name: "Tests group" })
      .getByRole("button", { name: /^Tests/ }),
  ).toHaveAttribute("aria-expanded", "false");

  // One stack instead of groups, remembered too.
  await stack(page).getByRole("button", { name: "Show one stack" }).click();
  await expect(stack(page).getByRole("region", { name: "All terminals and agents" })).toBeVisible();
  await expect(stack(page).getByRole("region", { name: "Tests group" })).toHaveCount(0);
});

test("Run Tests queues the workspace's test task through Operations; Focus toggles", async ({ page }) => {
  await openCode(page);
  await page.getByRole("button", { name: "Run Tests", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Memory).__kalcodeMemory.operations.lastAction()))
    .toBe("enqueue");
  const context = page.getByRole("region", { name: "Workspace context for kalcode-site" });
  await expect(context.getByRole("tab", { name: /Tests/ })).toHaveAttribute("aria-selected", "true");

  const focus = page.getByRole("button", { name: "Focus", exact: true });
  await focus.click();
  await expect(focus).toHaveAttribute("aria-pressed", "true");
  await focus.click();
  await expect(focus).toHaveAttribute("aria-pressed", "false");
});

for (const theme of ["dark", "light"] as const) {
  test(`stack, quick bar and What's Happening pass axe in ${theme} theme`, async ({ page }, testInfo) => {
    await openCode(page);
    if (theme === "light") {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "Code", exact: true })
        .click();
    }
    await page.getByRole("button", { name: "New terminal", exact: true }).click();
    await page.getByRole("button", { name: "New terminal", exact: true }).click();
    await page.getByRole("button", { name: "New terminal", exact: true }).click();
    // A busy workspace (four or more items) shows the stack without being asked.
    await expect(stack(page)).toBeVisible();
    await setWork(page, await firstTerminalId(page), ["node.exe"]);
    await expect(stack(page).getByRole("button", { name: /Working: Running node/ })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: testInfo.outputPath(`code-organization-${theme}.png`) });
    await expectNoSeriousA11yViolations(page, '[aria-label="Terminal stack"]');
    await expectNoSeriousA11yViolations(page, "#code-actions");
    await expectNoSeriousA11yViolations(page, "fieldset");
  });
}

test("a narrow canvas folds the stack and the extra quick actions, never the workspace title", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openCode(page);
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Widgets", exact: true })).toBeVisible();
  await expect(stack(page)).toBeHidden();
  // The rail opens the stack over the canvas instead of taking the panes' width; Escape closes it.
  const rail = page.getByRole("button", { name: /^Show the terminal stack/ });
  await expect(rail).toBeVisible();
  await rail.click();
  await expect(stack(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("code-organization-narrow-overlay.png") });
  await stack(page).getByRole("button", { name: "Hide the stack" }).focus();
  await page.keyboard.press("Escape");
  await expect(stack(page)).toBeHidden();
  const body = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(body).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("code-organization-narrow.png") });
});
