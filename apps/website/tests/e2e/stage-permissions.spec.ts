import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * PermissionModes as 0.1.9+1738 ships them (apps/desktop permissions labels.ts DEFAULT_MODE_CHOICES,
 * crates/permissions policy.rs `baseline`): Bypass is the default, Plan is read-only, and
 * credentials and secrets ask in both. A native radio group, no script.
 */
const STAGE_URL = process.env.STAGE_URL ?? "/";

async function open(page: Page): Promise<Locator> {
  await page.goto(STAGE_URL);
  const block = page.getByTestId("permission-modes").first();
  test.skip((await block.count()) === 0, `PermissionModes is not on ${STAGE_URL}`);
  await block.scrollIntoViewIfNeeded();
  return block;
}

/** The visible outcome for an action row. */
function outcome(block: Locator, action: string): Locator {
  return block.getByRole("row", { name: new RegExp(`^${action}`) }).locator("td:visible");
}

test.describe("PermissionModes", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("offers Bypass (the default) and Plan as a radio group", async ({ page }) => {
    const block = await open(page);
    const radios = block.getByRole("radio");
    await expect(radios).toHaveCount(2);
    const bypass = block.getByRole("radio", { name: /Bypass/ });
    await expect(bypass).toBeChecked();
    await expect(block.getByTestId("mode-bypass")).toContainText("Default");
    await expect(block.getByTestId("mode-plan")).toContainText("Read-only");
    await expect(block.locator("fieldset")).not.toContainText(/Approve|Auto|Custom|Planned/);
    // Arrow keys move the selection, as in any native radio group.
    await bypass.focus();
    await page.keyboard.press("ArrowRight");
    await expect(block.getByRole("radio", { name: /Plan/ })).toBeChecked();
  });

  test("Bypass runs everything except credentials and secrets; Plan is read-only", async ({ page }) => {
    const block = await open(page);
    for (const action of ["Edit files", "Commands, tests and builds", "Git commits and pushes", "Dev servers"]) {
      await expect(outcome(block, action)).toHaveText("Runs");
    }
    await expect(outcome(block, "Credentials and secrets")).toHaveText("Asks you");
    await expect(block).toContainText("Only access to credentials and secrets still asks.");

    await block.getByTestId("mode-plan").click();
    await expect(outcome(block, "Read files, Git history and logs")).toHaveText("Runs");
    for (const action of ["Edit files", "Commands, tests and builds", "Git commits and pushes", "Dev servers"]) {
      await expect(outcome(block, action)).toHaveText("Refused");
    }
    await expect(outcome(block, "Credentials and secrets")).toHaveText("Asks you");
    await expect(block).toContainText("Read and plan only.");
  });

  test("the Needs You moment is a secret request, never a package install", async ({ page }) => {
    const block = await open(page);
    await expect(block).toContainText("Needs you");
    await expect(block).toContainText("Wants to read STRIPE_SECRET_KEY in .env.local");
    await expect(block).toContainText("Credentials and secrets always ask.");
    await expect(block).not.toContainText(/pnpm add|Installing packages/);
    await expect(block.getByTestId("stage-label")).toContainText(
      "Product preview · sample data · every mode on every plan",
    );
  });
});
