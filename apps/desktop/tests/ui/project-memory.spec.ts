import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const shots = process.env.KALCODE_SHOTS_DIR;

async function shot(page: Page, name: string, testInfo: { outputPath: (name: string) => string }) {
  await page.screenshot({ path: shots ? `${shots}/${name}` : testInfo.outputPath(name) });
}

async function openPopover(page: Page) {
  await page.getByRole("button", { name: "Project memory" }).first().click();
  const popover = page.getByRole("dialog", { name: "Project memory" });
  await expect(popover).toBeVisible();
  return popover;
}

async function remember(page: Page, title: string, knowledge: string, pin: boolean) {
  await page.getByRole("button", { name: "Remember something" }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByRole("textbox", { name: "Knowledge", exact: true }).fill(knowledge);
  if (pin) await page.getByLabel("Pin important context").check();
  await page.getByRole("button", { name: "Save memory", exact: true }).click();
  await expect(page.getByRole("region", { name: "Memory details" })).toContainText(title);
}

test("Code shows the project's memory, filters it inline and opens Unified Memory to edit", async ({
  page,
}, testInfo) => {
  await page.goto("/?scenario=code");

  // Empty project: the popover opens at once and says what memory is for.
  let popover = await openPopover(page);
  await expect(popover.getByText("Nothing remembered yet")).toBeVisible();
  await expect(popover.getByText("No notes yet")).toBeVisible();
  await expect(popover.getByRole("searchbox")).toHaveCount(0);
  await expect(popover.getByRole("button", { name: "Open Unified Memory" })).toBeFocused();
  await shot(page, "project-memory-empty.png", testInfo);

  // Editing lives in Unified Memory; the popover leads there.
  await popover.getByRole("button", { name: "Open Unified Memory" }).click();
  await expect(page.getByRole("heading", { name: "Unified Memory", exact: true })).toBeVisible();
  await remember(
    page,
    "Billing webhooks go through the queue",
    "Stripe events are enqueued by api/webhooks.ts; never process them inline.",
    true,
  );
  await remember(page, "Use pnpm, never npm", "The workspace uses pnpm workspaces and a frozen lockfile.", false);

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  popover = await openPopover(page);
  await expect(popover.getByText("2 notes · 1 pinned")).toBeVisible();
  const notes = popover.getByRole("list", { name: "Project memory notes" });
  await expect(notes.getByRole("listitem")).toHaveCount(2);
  // Pinned first.
  await expect(notes.getByRole("listitem").first()).toContainText("Billing webhooks go through the queue");
  // Free plan: no claim that agents receive it.
  await expect(popover.getByText(/included with Pro/)).toBeVisible();
  // The filter has focus when the popover opens.
  await expect(popover.getByRole("searchbox", { name: "Filter project memory" })).toBeFocused();
  await shot(page, "project-memory-notes.png", testInfo);

  const accessibility = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await page.keyboard.type("pnpm lockfile");
  await expect(notes.getByRole("listitem")).toHaveCount(1);
  await expect(notes).toContainText("Use pnpm, never npm");
  await page.keyboard.press("Control+A");
  await page.keyboard.type("graphql");
  await expect(popover.getByText("No notes match “graphql”.")).toBeVisible();
  await shot(page, "project-memory-no-match.png", testInfo);

  // Escape closes it and clears the filter for next time.
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  popover = await openPopover(page);
  await expect(popover.getByRole("searchbox", { name: "Filter project memory" })).toHaveValue("");
});
