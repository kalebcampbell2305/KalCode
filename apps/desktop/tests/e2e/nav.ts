import { expect, type Page } from "@playwright/test";

/** Places that stay in the Primary sidebar itself; every other surface is in its More menu. */
const IN_SIDEBAR = new Set(["Code", "Activity", "Settings", "Home", "Project"]);

/**
 * Opens a place from the Primary sidebar: Code, Activity and Settings directly, every other surface
 * (Operations, KalVoice, Threads, Unified Memory, Providers, Browser) through the More menu.
 */
export async function goTo(page: Page, name: string): Promise<void> {
  const primary = page.getByRole("navigation", { name: "Primary" });
  if (IN_SIDEBAR.has(name)) {
    await primary.getByRole("button", { name, exact: true }).click();
    return;
  }
  await primary.getByRole("button", { name: /^More places/ }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

/** The sidebar's Needs you button (the one attention inbox). */
export function needsYouButton(page: Page) {
  return page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Needs you/ });
}

/** How many approvals Needs you lists (opens the inbox, counts, closes it). */
export async function expectApprovalItems(page: Page, count: number): Promise<void> {
  const inbox = page.getByRole("dialog", { name: "Needs you" });
  await needsYouButton(page).click();
  await expect(inbox.locator('li[data-kind="approval"]')).toHaveCount(count);
  await page.keyboard.press("Escape");
  await expect(inbox).toHaveCount(0);
}
