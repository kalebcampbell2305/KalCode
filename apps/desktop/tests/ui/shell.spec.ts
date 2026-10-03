import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function open(page: Page, scenario?: string) {
  await page.goto(scenario ? `/?scenario=${scenario}` : "/");
  // Wait for boot to finish so keyboard shortcuts are registered.
  await expect(
    page.getByRole("heading", { level: 1, name: scenario === "startup-error" ? /./ : "Dashboard" }).first(),
  ).toBeVisible();
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

test.describe("dashboard", () => {
  test("shows runtime health and live activity from the event log", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Agents", exact: true })).toContainText("No agents yet");
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity.getByText("KalCode started")).toBeVisible();
    await expect(activity.getByText("Local database created")).toBeVisible();
    const runtime = page.getByRole("region", { name: "Runtime health" });
    await expect(runtime.getByText("Running", { exact: true })).toBeVisible();
    await expect(runtime.getByText("Not checked yet")).toBeVisible();
  });

  test("credential store check updates health and activity", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Check credential store" }).click();
    await expect(page.getByRole("status").getByText("Credential store verified").first()).toBeVisible();
    const runtime = page.getByRole("region", { name: "Runtime health" });
    await expect(runtime.getByText("Verified", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Credential store verified")).toBeVisible();
  });

  test("credential store failure is explained", async ({ page }) => {
    await open(page, "keychain-failure");
    await page.getByRole("button", { name: "Check credential store" }).click();
    await expect(page.getByText("Your system credential store refused access").first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Runtime health" }).getByText("Check failed")).toBeVisible();
  });
});

test.describe("settings", () => {
  test("theme, motion and density apply immediately and are recorded", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

    await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.getByRole("radiogroup", { name: "Density" }).getByRole("radio", { name: "Compact" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");

    await page.getByRole("radiogroup", { name: "Motion" }).getByRole("radio", { name: "Reduced" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");

    await page.getByRole("button", { name: "Dashboard" }).click();
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Settings changed").first()).toBeVisible();
  });

  test("theme control supports arrow-key navigation", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Settings" }).click();
    const dark = page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Dark" });
    await dark.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("diagnostics show sanitized paths", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Settings" }).click();
    const diagnostics = page.getByRole("region", { name: "Diagnostics" });
    await expect(diagnostics.getByText("~\\AppData\\Roaming\\com.kalcode.desktop", { exact: true })).toBeVisible();
    await expect(diagnostics.getByText("0.1.0 (development)")).toBeVisible();
  });
});

test.describe("navigation and commands", () => {
  test("command palette opens with the keyboard and runs commands", async ({ page }) => {
    await open(page);
    await page.keyboard.press(`${MOD}+k`);
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await page.keyboard.type("light theme");
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type("settings");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  test("an explicitly named command outranks weaker fuzzy matches", async ({ page }) => {
    await open(page, "threads");
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Threads" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toBeVisible();

    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type("use dark theme");
    const darkTheme = page.locator('[cmdk-item][data-value="Use dark theme"]');
    await expect(darkTheme).toBeVisible();
    await expect(darkTheme).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toBeVisible();
  });

  test("sidebar collapses with the keyboard and keeps accessible names", async ({ page }) => {
    await open(page);
    await page.keyboard.press(`${MOD}+b`);
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Dashboard" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  });

  test("gated surfaces explain that they are not available yet", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
    await expect(page.getByText("Not available in this build")).toBeVisible();
    await expect(page.getByText("Nothing on this page runs yet.")).toBeVisible();
  });

  test("skip link moves focus to the main content", async ({ page }) => {
    await open(page);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
  });
});

test.describe("startup failure", () => {
  test("explains the problem and what is safe", async ({ page }) => {
    await open(page, "startup-error");
    await expect(page.getByRole("heading", { name: "KalCode couldn't start" })).toBeVisible();
    await expect(page.getByText("created by a newer version of KalCode")).toBeVisible();
    await expect(page.getByText("your data has not been changed", { exact: false })).toBeVisible();
    await expect(page.getByText("Error code: database/schema_too_new")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open data folder" })).toBeVisible();
  });
});

test.describe("accessibility", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`dashboard, settings, gated and startup screens pass axe in ${theme} theme`, async ({ page }) => {
      await open(page);
      if (theme === "light") {
        await page.getByRole("button", { name: "Settings" }).click();
        await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
        await page.getByRole("button", { name: "Dashboard" }).click();
      }
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("region", { name: "Activity" }).getByText("KalCode started")).toBeVisible();
      await expectNoSeriousA11yViolations(page);

      await page.getByRole("button", { name: "Settings" }).click();
      await expect(page.getByRole("region", { name: "Diagnostics" }).getByText("Recorded events")).toBeVisible();
      await expectNoSeriousA11yViolations(page);

      await page.getByRole("button", { name: "KalVoice" }).click();
      await expectNoSeriousA11yViolations(page);

      await page.keyboard.press(`${MOD}+k`);
      await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
      await expectNoSeriousA11yViolations(page);
    });
  }

  test("startup error screen passes axe", async ({ page }) => {
    await open(page, "startup-error");
    await expect(page.getByRole("heading", { name: "KalCode couldn't start" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});
