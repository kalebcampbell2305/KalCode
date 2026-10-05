import { expect, type Page, test } from "@playwright/test";

/**
 * Agent outcomes beside the work: a finished coding agent's Code pane says what its work amounted
 * to, stage by stage, from observed state only. AGENT done never implies tested, merged or shipped.
 */

const pane = (page: Page) => page.locator("[data-provider-pane]").first();

async function launchAgent(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __kalcodeMemory: { queueFolders: (...f: string[]) => void } }).__kalcodeMemory.queueFolders(
      "outcome-site",
    );
  });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "Open folder…" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "outcome-site" })).toBeVisible();
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  // One click may launch straight away; otherwise the launcher asks once.
  const dialog = page.getByRole("dialog", { name: "New agent" });
  await expect(pane(page).or(dialog)).toBeVisible();
  if (await dialog.isVisible()) await dialog.getByRole("button", { name: "Launch Claude Code agent" }).click();
  await expect(pane(page)).toBeVisible();
  await expect(pane(page).locator("[data-pane-status]")).toHaveText(/^(READY|IDLE)$/);
  return (await pane(page).getAttribute("data-provider-pane")) as string;
}

test("a finished agent's pane shows its outcome without claiming more than it knows", async ({ page }) => {
  const threadId = await launchAgent(page);
  // A fresh agent has nothing to report beyond its state: no strip.
  await expect(pane(page).getByRole("button", { name: /^Outcome of/ })).toHaveCount(0);

  await page.evaluate(
    (id) =>
      (
        window as unknown as { __kalcodeMemory: { panes: { finish: (id: string, files: number) => void } } }
      ).__kalcodeMemory.panes.finish(id, 6),
    threadId,
  );
  const strip = pane(page).getByRole("button", { name: /^Outcome of/ });
  await expect(strip).toHaveAccessibleName(/Agent: DONE, Changed: 6 files/);
  await expect(strip).toContainText("6 files");
  await expect(strip).not.toContainText(/passed|merge|released|shipped/i);

  const terminal = pane(page).locator("[data-pane-terminal]");
  const before = await terminal.boundingBox();
  await strip.click();
  await expect(strip).toHaveAttribute("aria-expanded", "true");
  const list = pane(page).locator("[data-outcome-list]");
  await expect(list).toContainText("DONE");
  await expect(list).toContainText("No test run recorded");
  await expect(list).toContainText("No separate branch");
  // The full outcome floats over the terminal: the real terminal keeps its size.
  expect(await terminal.boundingBox()).toEqual(before);
  await strip.click();
  await expect(list).toHaveCount(0);
});
