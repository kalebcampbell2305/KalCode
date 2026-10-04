import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * The Agents tab (Agent Fleet) redesign, owner request 2026-10-03: six status groups with real
 * counts, instant search, a card opening its agent's terminal in Code (never Threads), cleanup that
 * keeps hundreds of old failures from burying live agents, and a layout remembered across restarts.
 * `@fleet-shots` writes the visual-review screenshots to apps/desktop/qa/screenshots/fleet/.
 */
const OUT = new URL("../../qa/screenshots/fleet/", import.meta.url);

const board = (page: Page) => page.getByRole("region", { name: "Agents", exact: true });
const cards = (page: Page) => board(page).getByRole("article");
const card = (page: Page, name: string) => board(page).getByRole("article", { name, exact: true });
const chip = (page: Page, label: string) =>
  page.getByRole("group", { name: "Filter agents" }).getByRole("button", { name: new RegExp(`^${label}, \\d+$`) });

async function open(page: Page, scenario: string) {
  await page.goto(`/?scenario=${scenario}`);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(cards(page).first()).toBeVisible();
}

test("six groups with real counts; old failures fold away and never count as needing you", async ({ page }) => {
  await open(page, "fleet");
  await expect(
    page.locator("#main").getByText("147 agents · 10 working · 4 need you · 3 done · 9 idle · 121 failed"),
  ).toBeVisible();
  for (const [label, count] of [
    ["All", 147],
    ["Needs you", 4],
    ["Working", 10],
    ["Done", 3],
    ["Idle", 9],
    ["Failed", 121],
  ] as const) {
    await expect(chip(page, label)).toHaveAccessibleName(`${label}, ${count}`);
  }
  // The sidebar badge counts what needs you, not the failure history.
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Dashboard", exact: true }),
  ).toHaveText("Dashboard4");
  // Groups in board order; folding the live groups shows the history below them.
  for (const name of [
    /^Needs you ?, 4 agents/i,
    /^Working ?, 10 agents/i,
    /^Done ?, 3 agents/i,
    /^Idle ?, 9 agents/i,
  ]) {
    const toggle = board(page).getByRole("button", { name });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  }
  const headings = board(page).getByRole("heading", { level: 2 });
  await expect(headings).toHaveText([/^Needs you/, /^Working/, /^Done/, /^Idle/, /^Failed/]);
  // 121 failed runs start folded: the live agents stay on top.
  const failed = board(page).getByRole("button", { name: /^Failed ?, 121 agents/i });
  await expect(failed).toHaveAttribute("aria-expanded", "false");
  await expect(cards(page)).toHaveCount(0);
  await chip(page, "Failed").click();
  await expect(card(page, "Deploy preview build")).toBeVisible();
});

test("search is instant across account, provider, workspace, task and status", async ({ page }) => {
  await open(page, "fleet");
  const search = page.getByRole("searchbox", { name: "Search agents" });
  await search.fill("Codex B");
  await expect(cards(page).first()).toBeVisible();
  for (const name of await cards(page).locator("[title^='Account:']").allTextContents()) {
    expect(name).toBe("account Codex B");
  }
  // Status and workspace together: only failed agents in field-notes.
  await search.fill("failed field-notes");
  await expect(cards(page).first()).toBeVisible();
  for (const group of await cards(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-group")))) {
    expect(group).toBe("failed");
  }
  await expect(card(page, "Fix flaky checkout test")).toHaveCount(0);
  await search.fill("checkout working");
  await expect(card(page, "Fix flaky checkout test")).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
});

test("clicking a card opens the agent's terminal in Code, never Threads", async ({ page }) => {
  await open(page, "fleet");
  await card(page, "Fix flaky checkout test").locator("p").first().click();
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toHaveCount(0);
  await expect(page.getByText("Open in Threads")).toHaveCount(0);
});

test("cleanup: the card X, Clear failed, and Close all asks once", async ({ page }) => {
  await open(page, "fleet");
  // One-click clear on a finished card.
  await chip(page, "Done").click();
  const done = card(page, "Generate API client");
  await done.getByRole("button", { name: "Clear Generate API client" }).click();
  await expect(done).toHaveCount(0);
  await expect(chip(page, "Done")).toHaveAccessibleName("Done, 2");

  // Clear failed from the group header: every failed agent goes at once.
  await chip(page, "Failed").click();
  await board(page).getByRole("button", { name: "Clear failed" }).click();
  // The outcome, not the transient summary toast: it leaves 4.5 s after the archives finish, and
  // on a slow machine the board's catch-up through 121 archive events can outlast it.
  await expect(chip(page, "Failed")).toHaveAccessibleName("Failed, 0", { timeout: 20_000 });
  await expect(chip(page, "All")).toHaveAccessibleName("All, 25");
  await chip(page, "All").click();

  // Close all. With KalTidy's canonical cleanup (#152) the Fleet hands off to KalTidy's one
  // confirmation, which closes the current workspace's terminals and agents; without it, the
  // Fleet asks its own single confirmation and closes every agent.
  await board(page).getByRole("button", { name: "Clean up" }).click();
  const item = page.getByRole("menuitem", { name: /^Close all (agents|terminals and agents)…$/ });
  const canonical = ((await item.textContent()) ?? "").includes("terminals");
  await item.click();
  if (canonical) {
    // This scenario has no open workspace: KalTidy says so and closes nothing.
    await expect(page.getByText("Open a workspace first.")).toBeVisible();
    await expect(chip(page, "All")).toHaveAccessibleName("All, 25");
    return;
  }
  const confirm = board(page).getByRole("group", { name: "Close all agents?" });
  await expect(confirm).toContainText("Active agents, builds, tests, and running processes will be stopped.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(chip(page, "All")).toHaveAccessibleName("All, 25");
  await board(page).getByRole("button", { name: "Clean up" }).click();
  await page.getByRole("menuitem", { name: "Close all agents…" }).click();
  await board(page)
    .getByRole("group", { name: "Close all agents?" })
    .getByRole("button", { name: "Close all" })
    .click();
  await expect(board(page).getByRole("heading", { name: /agents are archived/ })).toBeVisible({ timeout: 15_000 });
});

test("the layout is remembered: panel width, folded groups and expanded cards", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page, "fleet");
  const splitter = page.getByRole("separator", { name: "Resize the Agents panel" });
  await expect(splitter).toBeVisible();
  const before = await board(page).evaluate((el) => el.getBoundingClientRect().width);
  await splitter.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => board(page).evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(before + 60);
  const widened = await board(page).evaluate((el) => el.getBoundingClientRect().width);

  await board(page)
    .getByRole("button", { name: /^Needs you ?, 4 agents/i })
    .click();
  await card(page, "Fix flaky checkout test")
    .getByRole("button", { name: "Show details for Fix flaky checkout test" })
    .click();
  await expect(card(page, "Fix flaky checkout test").getByText("Permission mode Auto")).toBeVisible();

  await page.reload();
  await expect(cards(page).first()).toBeVisible();
  expect(Math.abs((await board(page).evaluate((el) => el.getBoundingClientRect().width)) - widened)).toBeLessThan(2);
  await expect(board(page).getByRole("button", { name: /^Needs you ?, 4 agents/i })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(
    card(page, "Fix flaky checkout test").getByRole("button", { name: "Hide details for Fix flaky checkout test" }),
  ).toHaveAttribute("aria-expanded", "true");
});

for (const size of [
  { width: 1280, height: 800 },
  { width: 1680, height: 1050 },
  { width: 1920, height: 1080 },
] as const) {
  test(`@fleet-shots Agents tab at ${size.width}x${size.height}, dark`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const shot = (name: string) => new URL(`${name}-${size.width}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme: "dark" });
    await open(page, "fleet");
    await expect(page.getByRole("region", { name: "Activity" }).getByText("KalCode started").first()).toBeAttached();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot("fleet-overview") });
    await card(page, "Fix flaky checkout test")
      .getByRole("button", { name: "Show details for Fix flaky checkout test" })
      .click();
    await chip(page, "Failed").click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot("fleet-failed") });
    await chip(page, "All").click();
    await board(page).getByRole("button", { name: "Clean up" }).click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: shot("fleet-cleanup-menu") });
    await page.keyboard.press("Escape");
    await page.getByRole("searchbox", { name: "Search agents" }).fill("claude");
    await page.waitForTimeout(250);
    await page.screenshot({ path: shot("fleet-search") });
  });
}
