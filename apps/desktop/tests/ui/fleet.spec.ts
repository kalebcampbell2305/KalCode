import { expect, type Page, test } from "@playwright/test";
import { goTo } from "./nav.ts";

/**
 * Agent Fleet: the Dashboard's coding-agent cards with call signs, each agent's own worktree and
 * branch, READY TO MERGE from Git facts, and a card opening the agent's terminal in Code. Chat
 * threads are not agents and stay in Threads.
 */
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const card = (page: Page, name: string) => page.getByRole("article", { name });

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

/** Opens a place from the sidebar (Code and Activity directly, other surfaces through More). */
const nav = (page: Page, name: string) => goTo(page, name);

test("a finished agent is ready to merge only when its worktree facts all agree", async ({ page }) => {
  await page.goto("/?scenario=busy");
  const ready = card(page, "Add light theme tokens");
  await expect(ready).toContainText("Ready to merge");
  await expect(ready).toContainText("3 commits ahead of main");
  // The task is the card title; provider and account remain separate details.
  await ready.getByRole("button", { name: "Show details for Add light theme tokens" }).click();
  await expect(ready.getByText("Claude Code", { exact: true })).toBeVisible();
  await expect(ready).toContainText("feat/light-tokens");

  const conflicted = card(page, "Generate API client");
  // The outcome strip keeps merge separate from the agent being done.
  const outcome = conflicted.getByRole("button", { name: /^Outcome of Generate API client/ });
  await expect(outcome).toContainText("Would conflict");
  await outcome.click();
  await expect(conflicted.locator("[data-outcome-list]")).toContainText("With main");
  await expect(conflicted).not.toContainText("Ready to merge ");
});

test("agents editing the same files in one project see each other early, and the chip opens the other", async ({
  page,
}) => {
  await page.goto("/?scenario=busy");
  const checkout = card(page, "Fix flaky checkout test");
  const invoices = card(page, "Write invoices migration");
  const toInvoices = checkout.getByRole("button", { name: /^Overlaps with Write invoices migration · 1 file/ });
  await expect(toInvoices).toContainText("1 file");
  await expect(invoices.getByRole("button", { name: /^Overlaps with Fix flaky checkout test · 1 file/ })).toBeVisible();
  // Different projects and agents without shared files never overlap.
  await expect(card(page, "Refactor auth middleware").getByRole("list", { name: "Overlapping edits" })).toHaveCount(0);

  // The files are named, then the chip opens the other agent's terminal in Code.
  await toInvoices.hover();
  await expect(page.getByRole("tooltip")).toContainText("apps/web/checkout/cart.ts");
  await toInvoices.click();
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

test("a new thread runs in its own worktree by default and is not an agent in the Fleet", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await openFolders(page, "kalcode");
  await nav(page, "Threads");
  await page.getByRole("main").getByRole("button", { name: "New thread" }).first().click();
  const form = page.getByRole("region", { name: "New thread" });
  const isolate = form.getByRole("checkbox", { name: "Run in its own worktree" });
  await expect(isolate).toBeChecked();
  await form.getByLabel("Task").fill("tidy the release checklist");
  await form.getByRole("button", { name: "Start thread" }).click();
  await expect(page.getByRole("region", { name: "Thread", exact: true })).toBeVisible();

  await nav(page, "Activity");
  await expect(page.getByRole("heading", { name: "No agents yet" })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
});

test("a folder outside Git can't give a thread its own worktree", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await openFolders(page, "design-notes");
  await nav(page, "Threads");
  await page.getByRole("main").getByRole("button", { name: "New thread" }).first().click();
  const form = page.getByRole("region", { name: "New thread" });
  await expect(form.getByRole("checkbox", { name: "Run in its own worktree" })).toBeDisabled();
  await expect(form).toContainText("isn't a Git repository, so the thread works in the folder itself");
});

test("launching two agents from Code fills the Fleet, and a card opens its terminal", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await openFolders(page, "kalcode");
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  const launcher = page.getByRole("dialog", { name: "New agent" });
  await launcher.getByRole("button", { name: "One more agent" }).click();
  await launcher.getByRole("button", { name: "Launch 2 Claude Code agents" }).click();
  await expect(launcher).toHaveCount(0);
  await expect(page.locator("[data-provider-pane]")).toHaveCount(2);

  await nav(page, "Activity");
  await expect(page.getByRole("article")).toHaveCount(2);
  await page.getByRole("article").first().getByRole("heading").getByRole("button").click();
  await expect(page.getByRole("heading", { level: 1, name: "kalcode" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toHaveCount(0);
  await expect(page.locator("[data-provider-pane]")).toHaveCount(2);
});

test("KalCode commits an isolated agent's leftover changes on its branch when asked", async ({ page }) => {
  await page.goto("/?scenario=busy");
  const failed = card(page, "Deploy preview build");
  // Agents still working, or waiting on an approval or a reply, offer no commit.
  await expect(card(page, "Write invoices migration").getByRole("button", { name: /^Commit / })).toHaveCount(0);
  await expect(card(page, "Refactor auth middleware").getByRole("button", { name: /^Commit / })).toHaveCount(0);

  await failed.getByRole("button", { name: "Commit 5 changes from Deploy preview build" }).click();
  const form = failed.getByRole("form", { name: "Commit Deploy preview build's changes" });
  const message = form.getByLabel(/Commit message/);
  await expect(message).toHaveValue("Deploy preview build");
  await expect(message).toBeFocused();
  await message.fill("Preview build: retry-safe deploy script");
  await form.getByRole("button", { name: "Commit", exact: true }).click();

  await expect(page.getByText("Committed to release/preview")).toBeVisible();
  await expect(form).toHaveCount(0);
  await expect(failed.getByRole("button", { name: /^Commit / })).toHaveCount(0);
  await expect(failed).toContainText("commits ahead 1");
});
