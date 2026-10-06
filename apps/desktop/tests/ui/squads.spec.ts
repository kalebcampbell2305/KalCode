import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { goTo } from "./nav.ts";

const ORION = {
  squadId: "00000000-0000-4000-8000-00000000a001",
  launchId: "00000000-0000-4000-8000-00000000a003",
} as const;

test("Squads unify reusable mixed-provider teams, canonical fixture status, handoff, hierarchy, and Code focus", async ({
  page,
}, testInfo) => {
  await page.goto("/?scenario=account-ready-max");
  await goTo(page, "Operations");
  await page.getByRole("tab", { name: "Squads", exact: true }).click();

  await expect(page.getByRole("heading", { level: 2, name: "Squads" })).toBeVisible();
  const active = page.locator(`[data-squad-launch-id="${ORION.launchId}"]`);
  await expect(active.getByRole("heading", { name: "Orion Release Crew" })).toBeVisible();
  await expect(active.getByText("Ship the updater reliability pass")).toBeVisible();

  const lead = active.locator('[data-squad-member-key="lead"]');
  const tests = active.locator('[data-squad-member-key="tests"]');
  const review = active.locator('[data-squad-member-key="review"]');
  await expect(lead).toContainText("Updater implementation");
  await expect(lead).toContainText("Working");
  await expect(lead).toContainText("Codex");
  await expect(lead).toContainText("Personal");
  await expect(tests).toContainText("Updater test authority");
  await expect(tests).toContainText("Needs you");
  await expect(tests).toContainText("Review the updater recovery test decision.");
  await expect(review).toContainText("Release review");
  await expect(review).toContainText("Done");

  const saved = page.locator(`[data-squad-id="${ORION.squadId}"]`);
  await expect(saved).toContainText("Claude Code");
  await expect(saved).toContainText("Codex");
  await expect(saved).toContainText("resolve those paths in the merge train");
  await expect(page.getByText("Orion updater release", { exact: true })).toBeVisible();

  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(
    axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
  ).toEqual([]);

  await page.locator("[data-operations-view]").evaluate((element) => element.scrollTo({ top: 0 }));
  const shot = testInfo.outputPath("squads-orion-1360x860.png");
  await page.screenshot({ path: shot });
  await testInfo.attach("Squads Orion rendered review", { path: shot, contentType: "image/png" });

  // Manager takeover changes only the launch relationship; the worker and its real terminal stay.
  await review.getByRole("button", { name: "Reassign manager for Release review" }).click();
  await review.getByRole("combobox", { name: "Manager for Release review" }).selectOption("");
  await review.getByRole("button", { name: "Reassign manager for Release review" }).click();
  const manager = review.getByRole("combobox", { name: "Manager for Release review" });
  await expect(manager).toHaveValue("");
  await manager.selectOption("");
  await expect(review).toContainText("Done");

  // The shared handoff action opens the existing governed Handoff flow with this canonical agent.
  await lead.getByRole("button", { name: "Hand off" }).click();
  await expect(page.getByRole("dialog", { name: "Hand off" })).toBeVisible();
  await page.keyboard.press("Escape");

  // The memory transport fixture projects a Recipe launch into three more canonical coding agents.
  const recipe = page.getByText("Orion updater release", { exact: true }).locator("../..");
  await recipe.getByRole("button", { name: "Launch" }).click();
  await expect(page.locator("[data-squad-launch-id]")).toHaveCount(2);

  // Opening a member targets its exact canonical coding agent and focuses Code. Native E2E proves
  // these identities are backed by provider PTYs; this UI test verifies the fixture's six-agent stack.
  await active.locator('[data-squad-member-key="lead"]').getByRole("button", { name: "Open terminal" }).click();
  await expect(page.getByRole("main", { name: "Code" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Agents 6/ })).toBeVisible();
  await expect(page.locator("[data-provider-pane]:visible")).toHaveCount(1);
  await expect(page.locator("[data-provider-pane]:visible")).toHaveAttribute("aria-label", /Updater implementation/);
});

test("Squad editor responds immediately and stays clear for a large team at a narrow size", async ({
  page,
}, testInfo) => {
  await page.goto("/?scenario=account-ready-max");
  await goTo(page, "Operations");
  await page.getByRole("tab", { name: "Squads", exact: true }).click();

  await page.getByRole("button", { name: "New squad" }).click();
  await expect(page.getByRole("dialog", { name: "New squad" })).toBeVisible();
  const editor = page.getByRole("dialog");
  await expect(editor.getByRole("button", { name: "Save squad" })).toBeEnabled();

  await editor.getByLabel("Squad name").fill("Atlas Eight");
  await expect(editor.getByRole("button", { name: "Use managers" })).toHaveCount(0);
  for (let index = 0; index < 6; index += 1) {
    await editor.getByRole("button", { name: "Add member" }).click();
  }
  await editor.getByRole("button", { name: "Use managers" }).click();
  await expect(editor.getByText("8 real terminals on every launch")).toBeVisible();

  const largeShot = testInfo.outputPath("squads-editor-large-1360x860.png");
  await page.screenshot({ path: largeShot });
  await testInfo.attach("Squad editor large team", { path: largeShot, contentType: "image/png" });

  await page.setViewportSize({ width: 900, height: 760 });
  await editor.getByLabel("Squad name").fill("");
  await editor.getByRole("button", { name: "Save squad" }).click();
  await expect(editor.getByRole("alert")).toHaveText("Name the squad.");

  const narrowShot = testInfo.outputPath("squads-editor-narrow-error-900x760.png");
  await page.screenshot({ path: narrowShot });
  await testInfo.attach("Squad editor narrow validation", { path: narrowShot, contentType: "image/png" });

  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(
    axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
  ).toEqual([]);
});
