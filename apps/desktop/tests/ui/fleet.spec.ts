import { expect, type Page, test } from "@playwright/test";

/**
 * Agent Fleet: the Dashboard's agent cards with call signs, each agent's own worktree and branch,
 * READY TO MERGE from Git facts, and a card opening its thread.
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

const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name, exact: true }).click();

test("a finished agent is ready to merge only when its worktree facts all agree", async ({ page }) => {
  await page.goto("/?scenario=busy");
  const ready = card(page, "Add light theme tokens");
  await expect(ready).toContainText("Ready to merge");
  await expect(ready).toContainText("3 commits ahead of main");
  await expect(ready).toContainText("Claude B");
  await expect(ready).toContainText("feat/light-tokens");

  const conflicted = card(page, "Generate API client");
  await expect(conflicted).toContainText("Not ready to merge: Would conflict with main");
  await expect(conflicted).not.toContainText("Ready to merge ");
});

test("a new agent runs in its own worktree and branch by default", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await openFolders(page, "kalcode");
  await nav(page, "Threads");
  await page.getByRole("main").getByRole("button", { name: "New thread" }).first().click();
  const form = page.getByRole("region", { name: "New thread" });
  const isolate = form.getByRole("checkbox", { name: "Run in its own worktree" });
  await expect(isolate).toBeChecked();
  await form.getByLabel("Task").fill("tidy the release checklist");
  await form.getByRole("button", { name: "Start thread" }).click();
  await expect(page.getByRole("region", { name: "Thread", exact: true })).toBeVisible();

  await nav(page, "Dashboard");
  await expect(page.getByRole("article").first()).toContainText(/kal\/tidy-release-checklist-[0-9a-f]{8}/);
});

test("a folder outside Git can't give an agent its own worktree", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await openFolders(page, "design-notes");
  await nav(page, "Threads");
  await page.getByRole("main").getByRole("button", { name: "New thread" }).first().click();
  const form = page.getByRole("region", { name: "New thread" });
  await expect(form.getByRole("checkbox", { name: "Run in its own worktree" })).toBeDisabled();
  await expect(form).toContainText("isn't a Git repository, so the agent works in the folder itself");
});

test("clicking a fleet card opens its thread", async ({ page }) => {
  await page.goto("/?scenario=threads");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await card(page, "Fix OAuth Callback Race")
    .getByRole("heading", { name: "Fix OAuth Callback Race" })
    .getByRole("button")
    .click();
  await expect(page.getByRole("region", { name: "Thread", exact: true })).toContainText("Fix OAuth Callback Race");
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
