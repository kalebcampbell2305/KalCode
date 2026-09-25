import { expect, type Locator, type Page, test } from "@playwright/test";

/** PermissionModes: modes change what the agent may do; the approval card follows. */
const STAGE_URL = process.env.STAGE_URL ?? "/";

async function open(page: Page): Promise<Locator> {
  await page.goto(STAGE_URL);
  const block = page.getByTestId("permission-modes");
  test.skip((await block.count()) === 0, `PermissionModes is not on ${STAGE_URL}`);
  await block.scrollIntoViewIfNeeded();
  await expect(block).toHaveAttribute("data-kc-bound", "true");
  return block;
}

test.describe("PermissionModes", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("modes are a radio group with roving focus; selecting changes authority", async ({ page }) => {
    const block = await open(page);
    const approve = block.getByTestId("mode-approve");
    await expect(approve).toHaveAttribute("aria-checked", "true");
    await approve.focus();
    await page.keyboard.press("ArrowRight");
    const auto = block.getByTestId("mode-auto");
    await expect(auto).toBeFocused();
    await expect(auto).toHaveAttribute("aria-checked", "true");
    await expect(block.getByTestId("permissions-full")).toHaveAttribute("data-mode", "auto");
    await expect(block.getByTestId("live-permission-modes")).toContainText("Auto mode selected");
  });

  test("Bypass allows the install without asking; Plan denies it", async ({ page }) => {
    const block = await open(page);
    const card = block.getByTestId("approval-zod");
    await block.getByTestId("mode-bypass").click();
    await expect(card).toHaveAttribute("data-state", "mode-allow");
    await expect(card).toContainText("runs without asking");
    await block.getByTestId("mode-plan").click();
    await expect(card).toHaveAttribute("data-state", "mode-deny");
    await block.getByTestId("mode-approve").click();
    await expect(card).toHaveAttribute("data-state", "pending");
  });

  test("hovering a mode previews it and leaving restores the selection", async ({ page }) => {
    const block = await open(page);
    const panel = block.getByTestId("permissions-full");
    await block.getByTestId("mode-bypass").hover();
    await expect(panel).toHaveAttribute("data-mode", "bypass");
    await page.mouse.move(2, 2);
    await expect(panel).toHaveAttribute("data-mode", "approve");
  });

  test("decisions resolve the card and Ask again resets it", async ({ page }) => {
    const block = await open(page);
    const card = block.getByTestId("approval-zod");
    const buttons = card.locator(".kc-approval__actions button");
    await expect(buttons).toHaveText(["Deny", "Allow for thread", "Approve once"]);
    await buttons.nth(2).click();
    await expect(card).toHaveAttribute("data-state", "approved");
    await expect(block.getByTestId("approval-reset")).toBeFocused();
    await block.getByTestId("approval-reset").click();
    await expect(card).toHaveAttribute("data-state", "pending");
    await buttons.nth(0).click();
    await expect(card).toHaveAttribute("data-state", "denied");
  });

  test("Custom is marked Planned", async ({ page }) => {
    const block = await open(page);
    await expect(block.getByTestId("mode-custom")).toContainText("Planned");
  });
});
