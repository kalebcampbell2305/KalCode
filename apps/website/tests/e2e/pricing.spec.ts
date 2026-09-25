import { formatKalVoiceAllowance, PLANS } from "@kalcode/protocol/plans";
import { expect, test } from "@playwright/test";

test.describe("pricing", () => {
  test("shows every plan's price and KalVoice Requests from the plan catalog", async ({ page }) => {
    await page.goto("/pricing");
    const table = page.getByRole("table");
    for (const plan of PLANS) {
      const header = table.getByRole("columnheader", { name: new RegExp(plan.name) });
      await expect(header).toContainText(`$${plan.price.amountUsd}`);
      await expect(table).toContainText(formatKalVoiceAllowance(plan.limits));
    }
    await expect(page.getByText("Every plan includes", { exact: true })).toBeVisible();
    for (const item of ["All providers", "All permission modes", "Unlimited on-device dictation"]) {
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

  test("never lists a private tier or sells anything", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.locator("main")).not.toContainText("OWNER");
    await expect(page.locator("main")).toContainText("nothing is for sale today");
  });
});
