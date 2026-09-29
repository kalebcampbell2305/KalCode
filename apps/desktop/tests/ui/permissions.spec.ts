import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * Booting the app (Vite module load, the in-memory runtime, the account gate, first render) can
 * take longer than the default 5 s assertion timeout under `--workers=4` on a loaded machine. The
 * boot gets its own bounded budget; every assertion after it keeps the default timeout.
 */
const APP_READY_TIMEOUT = 30_000;

async function open(page: Page, scenario?: string) {
  await page.goto(scenario ? `/?scenario=${scenario}` : "/");
  // Ready: the shell replaced the boot screen and rendered the Dashboard.
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible({
    timeout: APP_READY_TIMEOUT,
  });
}

async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    serious,
    JSON.stringify(
      serious.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
      null,
      2,
    ),
  ).toEqual([]);
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("radiogroup", { name: "Theme" })
    .getByRole("radio", { name: theme === "light" ? "Light" : "Dark" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

const approvalsButton = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Approvals/ });

test.describe("approvals", () => {
  test("the sidebar shows how many approvals are waiting", async ({ page }) => {
    await open(page);
    await expect(approvalsButton(page)).toHaveAccessibleName("Approvals, none waiting");
    await approvalsButton(page).click();
    const panel = page.getByRole("dialog", { name: "Approvals" });
    await expect(panel.getByRole("heading", { name: "You're all caught up" })).toBeVisible();

    await page.goto("/?scenario=approvals");
    await expect(approvalsButton(page)).toHaveAccessibleName("Approvals, 4 waiting");
  });

  test("each prompt shows provider, thread, action, workspace and mode", async ({ page }) => {
    await open(page, "approvals");
    await approvalsButton(page).click();
    const panel = page.getByRole("dialog", { name: "Approvals" });
    const prompt = panel.getByRole("region", { name: "Install zod@4 with npm" });
    await expect(prompt).toBeVisible();
    await expect(prompt.getByText("npm install zod@4", { exact: true })).toBeVisible();
    await expect(prompt.getByText("Claude Code")).toBeVisible();
    await expect(prompt.getByText("Fix the login bug")).toBeVisible();
    await expect(prompt.getByText("kalcode", { exact: true })).toBeVisible();
    await expect(prompt.getByText("Approve", { exact: true })).toBeVisible();
    await expect(
      prompt.getByRole("list", { name: "Permissions this needs" }).getByText("Installing packages"),
    ).toBeVisible();
    for (const name of ["Deny", "Approve once", "Allow for thread", "Allow for workspace"]) {
      await expect(prompt.getByRole("button", { name, exact: true })).toBeVisible();
    }
    await expect(prompt.getByText("only installing zod@4 with npm").first()).toBeVisible();

    // Remote-consequential requests can only be approved once.
    const push = panel.getByRole("region", { name: "Push main to origin" });
    await expect(push.getByRole("button", { name: "Approve once" })).toBeVisible();
    await expect(push.getByRole("button", { name: "Allow for thread" })).toHaveCount(0);
    await expect(push.getByRole("button", { name: "Allow for workspace" })).toHaveCount(0);

    // A Bypass thread is labelled as such, and a deploy still asks.
    const deploy = panel.getByRole("region", { name: "Deploy the website with Wrangler" });
    await expect(deploy.getByText("Bypass", { exact: true })).toBeVisible();
    await expect(
      deploy.getByRole("list", { name: "Permissions this needs" }).getByText("Deploying or publishing"),
    ).toBeVisible();
  });

  test("approving and denying record the answer and update the count", async ({ page }) => {
    await open(page, "approvals");
    await approvalsButton(page).click();
    const panel = page.getByRole("dialog", { name: "Approvals" });
    await panel
      .getByRole("region", { name: "Install zod@4 with npm" })
      .getByRole("button", { name: "Approve once" })
      .click();
    await expect(panel.getByRole("region", { name: "Install zod@4 with npm" })).toHaveCount(0);
    await expect(panel.getByText("3 requests are waiting.")).toBeVisible();

    await panel.getByRole("region", { name: "Push main to origin" }).getByRole("button", { name: "Deny" }).click();
    await expect(panel.getByText("2 requests are waiting.")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(approvalsButton(page)).toHaveAccessibleName("Approvals, 2 waiting");
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Approved", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Denied", { exact: true })).toBeVisible();
  });

  test("works from the keyboard and returns focus", async ({ page }) => {
    await open(page, "approvals");
    await approvalsButton(page).focus();
    await page.keyboard.press("Enter");
    const panel = page.getByRole("dialog", { name: "Approvals" });
    await expect(panel).toBeVisible();
    // Nothing that approves is focused by default.
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
    expect(focused).not.toMatch(/Approve|Allow/);
    const deny = panel
      .getByRole("region", { name: "Deploy the website with Wrangler" })
      .getByRole("button", { name: "Deny" });
    for (let i = 0; i < 12 && !(await deny.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press("Tab");
    }
    await expect(deny).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("region", { name: "Deploy the website with Wrangler" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(approvalsButton(page)).toBeFocused();
    await expect(approvalsButton(page)).toHaveAccessibleName("Approvals, 3 waiting");
  });

  test("a new request is announced to screen readers", async ({ page }) => {
    await open(page);
    await expect(approvalsButton(page)).toHaveAccessibleName("Approvals, none waiting");
    await page.evaluate(() => {
      (
        window as unknown as { __kalcodeMemory: { permissions: { requestApproval: (k: string) => void } } }
      ).__kalcodeMemory.permissions.requestApproval("push");
    });
    await expect(page.getByRole("alert")).toContainText("Approval needed");
    await expect(page.getByRole("alert")).toContainText("Push main to origin");
    await expect(approvalsButton(page)).toHaveAccessibleName("Approvals, 1 waiting");
  });

  test("collapsed sidebar keeps the count in the accessible name", async ({ page }) => {
    await open(page, "approvals");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(approvalsButton(page)).toHaveAccessibleName("Approvals, 4 waiting");
  });
});

test.describe("permission settings", () => {
  test("default mode changes and describes itself", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const section = page.getByRole("region", { name: "Permissions" });
    const modes = section.getByRole("radiogroup", { name: "Default mode for new threads" });
    await expect(modes.getByRole("radio", { name: "Approve" })).toBeChecked();
    await modes.getByRole("radio", { name: "Plan" }).click();
    await expect(modes.getByRole("radio", { name: "Plan" })).toBeChecked();
    await expect(section.getByText("Read and plan only.")).toBeVisible();
    await modes.getByRole("radio", { name: "Custom" }).click();
    const profile = section.getByRole("radiogroup", { name: "Custom profile" });
    await expect(profile.getByRole("radio", { name: "Code Reviewer" })).toBeChecked();
    await profile.getByRole("radio", { name: "Local Builder" }).click();
    await expect(profile.getByRole("radio", { name: "Local Builder" })).toBeChecked();
    await page.getByRole("button", { name: "Dashboard" }).click();
    await expect(
      page.getByRole("region", { name: "Activity" }).getByText("Permission mode changed").first(),
    ).toBeVisible();
  });

  test("Bypass needs explicit confirmation and stays visible while on", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const section = page.getByRole("region", { name: "Permissions" });
    const modes = section.getByRole("radiogroup", { name: "Default mode for new threads" });
    await modes.getByRole("radio", { name: "Bypass" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Save Bypass as your default?" });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Turn on Bypass" });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("button", { name: "Keep current mode" }).click();
    await expect(modes.getByRole("radio", { name: "Approve" })).toBeChecked();

    await modes.getByRole("radio", { name: "Bypass" }).click();
    await dialog.getByRole("checkbox").check();
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(modes.getByRole("radio", { name: "Bypass" })).toBeChecked();
    // Threads can't start in Bypass, so the saved default says so and the sidebar raises no alarm.
    await expect(section.getByText("Bypass is your saved default")).toBeVisible();
    await expect(section.getByText(/New threads start in Approve/).first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /Bypass/ })).toHaveCount(
      0,
    );

    await section.getByRole("button", { name: "Switch to Approve" }).click();
    await expect(modes.getByRole("radio", { name: "Approve" })).toBeChecked();
    await expect(section.getByText("Bypass is your saved default")).toHaveCount(0);
  });

  test("profiles show what each mode allows", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const section = page.getByRole("region", { name: "Permissions" });
    await section.getByText("Code Reviewer", { exact: true }).click();
    const table = section.getByRole("table", { name: "Code Reviewer rules" });
    const push = table.getByRole("row", { name: /Pushing to a Git remote/ });
    await expect(push.getByText("Never")).toBeVisible();
    await section.getByText("Bypass", { exact: true }).last().click();
    const bypass = section.getByRole("table", { name: "Bypass rules" });
    await expect(bypass.getByRole("row", { name: /Deploying or publishing/ }).getByText("Asks")).toBeVisible();
  });
});

test.describe("permission accessibility", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`approvals panel, settings and Bypass dialog pass axe in ${theme} theme`, async ({ page }) => {
      await open(page, "approvals");
      await setTheme(page, theme);
      const section = page.getByRole("region", { name: "Permissions" });
      await section.getByText("Code Reviewer", { exact: true }).click();
      await expectNoSeriousA11yViolations(page);

      await section
        .getByRole("radiogroup", { name: "Default mode for new threads" })
        .getByRole("radio", { name: "Bypass" })
        .click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await expectNoSeriousA11yViolations(page);
      await page.getByRole("button", { name: "Keep current mode" }).click();

      await approvalsButton(page).click();
      await expect(page.getByRole("dialog", { name: "Approvals" }).getByRole("region").first()).toBeVisible();
      await expectNoSeriousA11yViolations(page);
    });
  }
});
