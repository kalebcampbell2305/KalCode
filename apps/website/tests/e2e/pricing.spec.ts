import { formatKalVoiceAllowance, PLANS } from "@kalcode/protocol/plans";
import { expect, test } from "@playwright/test";

test.describe("pricing", () => {
  test("shows every plan's price and KalVoice Requests from the plan catalog", async ({ page }) => {
    await page.goto("/pricing");
    const table = page.getByRole("table");
    for (const [index, plan] of PLANS.entries()) {
      const header = table.getByRole("columnheader").nth(index);
      await expect(header).toContainText(plan.name);
      await expect(header).toContainText(`$${plan.price.amountUsd}`);
      await expect(table).toContainText(formatKalVoiceAllowance(plan.limits));
    }
    await expect(table.getByRole("columnheader", { name: /MAX 2X/ })).toContainText("$50");
    await expect(table.getByRole("row", { name: /KalVoice Requests a month/ })).toContainText("10,000");
    await expect(page.getByText("Every plan includes", { exact: true })).toBeVisible();
    for (const item of ["All providers", "Plan, Approve and Auto modes", "Unlimited on-device dictation"]) {
      await expect(page.getByRole("listitem").filter({ hasText: item })).toBeVisible();
    }
    // Aligned plan headers: every price sits on the same line.
    const tops = await page
      .locator(".ladder__price")
      .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
  });

  test("the FAQ is a keyboard-operable accordion", async ({ page }) => {
    await page.goto("/pricing");
    const question = page.getByText("Does dictation count?");
    const answer = page.getByText("KalVoice dictation runs on your device and is unlimited on every plan.");
    await expect(answer).toBeHidden();
    await question.focus();
    await page.keyboard.press("Enter");
    await expect(answer).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(answer).toBeHidden();
  });

  test("never lists a private tier and sends buyers to their account", async ({ page }) => {
    await page.goto("/pricing");
    const main = page.locator("main");
    await expect(main).not.toContainText("OWNER");
    await expect(main).toContainText("Paid plans are open");
    await expect(main).not.toContainText("nothing is for sale today");
    await expect(main.getByRole("link", { name: /Choose a plan in your account/ })).toHaveAttribute("href", "/account");
  });

  test("uses KalVoice Requests and keeps dictation and connected-provider inference outside the meter", async ({
    page,
  }) => {
    await page.goto("/pricing");
    const main = page.locator("main");
    await expect(main).not.toContainText(/\btokens?\b/i);
    await expect(main).toContainText("Unlimited on-device dictation");
    await expect(main).toContainText("your usage is billed by each provider");
  });
});
