import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("account center opens in place with each account's real usage, never an invented one", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Account and usage center" }).click();
  const center = page.getByRole("dialog", { name: "Accounts & usage" });
  await expect(center).toBeVisible();
  for (const provider of ["Claude Code", "Codex", "Gemini CLI"]) {
    await expect(center.getByRole("heading", { name: provider, exact: true })).toBeVisible();
  }
  // Canonical per-account usage: real windows, resets and plan where the provider reports them.
  const claude = center.getByRole("region", { name: "Claude Code · Personal", exact: true });
  await expect(claude.getByText("Max 20x", { exact: true })).toBeVisible();
  const windows = claude.getByRole("list", { name: "Personal usage" });
  await expect(windows.getByRole("listitem")).toHaveCount(2);
  await expect(windows).toContainText("5-hour64% left");
  await expect(windows).toContainText("Weekly42% left");
  await expect(windows).toContainText(/Resets in 2h 1[34]m/);
  const codex = center.getByRole("region", { name: "Codex · Personal", exact: true });
  await expect(codex).toContainText("56% left");
  // No number where the provider reports none; a signed-out account offers Sign in in its row.
  const gemini = center.getByRole("region", { name: "Gemini CLI · Personal", exact: true });
  await expect(gemini.getByText("Usage unavailable", { exact: true })).toBeVisible();
  await expect(gemini).not.toContainText(/\d+% left/);
  const work = center.getByRole("region", { name: "Codex · Work", exact: true });
  await expect(work).not.toContainText(/\d+% left/);
  await expect(work.getByRole("button", { name: "Sign in Work" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true, level: 1 })).toBeVisible();
  const violations = (await new AxeBuilder({ page }).include("[data-account-center]").analyze()).violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(violations).toEqual([]);
  await page.screenshot({ path: "qa/screenshots/account-center-dark.png" });
  await page.keyboard.press("Escape");
  await expect(center).toBeHidden();
  await expect(page.getByRole("button", { name: "Account and usage center" })).toBeFocused();
});

test("rename, details and default stay in the center and update canonical accounts", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Account and usage center" }).click();
  const center = page.getByRole("dialog", { name: "Accounts & usage" });
  const account = center.getByRole("region", { name: "Codex · Work", exact: true });
  await account.getByRole("button", { name: "Account details" }).click();
  await expect(account).toContainText("Plan not reported");
  await account.getByRole("button", { name: "Rename account" }).click();
  await account.getByRole("textbox", { name: "Account nickname" }).fill("Codex Studio");
  await account.getByRole("button", { name: "Save name" }).click();
  const renamed = center.getByRole("region", { name: "Codex · Codex Studio", exact: true });
  await expect(renamed).toBeVisible();
  await renamed.getByRole("button", { name: "Set default" }).click();
  await expect(renamed.getByText("Default", { exact: true })).toBeVisible();
  await expect(center).toBeVisible();
});

test("switching selects the next agent while the current terminal keeps its real account", async ({ page }) => {
  await page.goto("/?scenario=code");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New agent" })
    .getByRole("button", { name: "Launch Claude Code agent" })
    .click();
  await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
  const chip = page.getByRole("button", { name: "Account and usage center" });
  await expect(chip).toContainText("Personal");
  await chip.click();
  const center = page.getByRole("dialog", { name: "Accounts & usage" });
  await expect(center).toContainText("This terminal is using: Claude Code · Personal");
  await center.getByRole("button", { name: "Add account", exact: true }).click();
  await center.getByRole("combobox", { name: "Provider" }).selectOption("claude-code");
  await center.getByRole("textbox", { name: "Account nickname" }).fill("Studio");
  await center.getByRole("button", { name: "Add and sign in" }).click();
  const studio = center.getByRole("region", { name: "Claude Code · Studio", exact: true });
  await expect(studio.getByText("Ready", { exact: true })).toBeVisible();
  await studio.getByRole("button", { name: "Account details" }).click();
  await studio.getByRole("button", { name: "Switch active account" }).click();
  await expect(center).toContainText("New agents: Claude Code · Studio");
  await expect(center).toContainText("This terminal is using: Claude Code · Personal");
  await expect(chip).toContainText("Personal");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  const launcher = page.getByRole("dialog", { name: "New agent" });
  await expect(launcher.getByRole("option", { selected: true })).toContainText("Studio");
  await launcher.getByRole("button", { name: "Launch Claude Code agent" }).click();
  await expect(page.locator("[data-provider-pane]")).toHaveCount(2);
  await expect(chip).toContainText("Studio");
  await chip.click();
  await expect(center).toContainText("This terminal is using: Claude Code · Studio");
  await page.screenshot({ path: "qa/screenshots/account-center-context.png" });
  await page.keyboard.press("Escape");
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Dashboard", exact: true })
    .click();
  await chip.click();
  await expect(center).not.toContainText("This terminal is using");
});

test("sign-in, sign-out and refresh use the existing account without creating a terminal", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Account and usage center" }).click();
  const center = page.getByRole("dialog", { name: "Accounts & usage" });
  const work = center.getByRole("region", { name: "Codex · Work", exact: true });
  // Sign in is right in the signed-out row: one click, no details to open first.
  await work.getByRole("button", { name: "Sign in Work" }).click();
  await expect(work.getByText("Ready", { exact: true })).toBeVisible();
  await expect(work.getByRole("button", { name: "Sign in Work" })).toHaveCount(0);
  // Signed in, the row fills with the account's real usage in place.
  await expect(work.getByRole("list", { name: "Work usage" })).toContainText("8% left");
  await work.getByRole("button", { name: "Account details" }).click();
  await work.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(work.getByText("Signed out", { exact: true })).toBeVisible();
  await center.getByRole("button", { name: "Refresh usage" }).click();
  await expect(center.getByRole("status")).toContainText("Account information refreshed.");
  await expect(work.getByText("Signed out", { exact: true })).toBeVisible();
  await expect(page.locator("[data-provider-pane]")).toHaveCount(0);
});

test("compact light center stays on screen with accessible actions", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light", exact: true }).click();
  const chip = page.getByRole("button", { name: "Account and usage center" });
  const bounds = await chip.boundingBox();
  expect(bounds && bounds.x + bounds.width).toBeLessThanOrEqual(960);
  await chip.click();
  const center = page.getByRole("dialog", { name: "Accounts & usage" });
  await center
    .getByRole("region", { name: "Claude Code · Personal", exact: true })
    .getByRole("button", { name: "Account details" })
    .click();
  await expect(center.getByRole("button", { name: "Add account", exact: true })).toBeInViewport();
  const violations = (await new AxeBuilder({ page }).include("[data-account-center]").analyze()).violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(violations).toEqual([]);
  await page.screenshot({ path: "qa/screenshots/account-center-light-compact.png" });
});
