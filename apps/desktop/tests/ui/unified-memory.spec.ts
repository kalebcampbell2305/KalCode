import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("project memory supports editing, search, preferences and removal", async ({ page }, testInfo) => {
  await page.goto("/?scenario=code");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Unified Memory" }).click();
  await expect(page.getByRole("heading", { name: "Unified Memory", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remember something" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Dashboard owns the workspace shell");
  await page.getByRole("combobox", { name: "Category", exact: true }).selectOption("architecture");
  await page
    .getByRole("textbox", { name: "Knowledge", exact: true })
    .fill(
      "Dashboard.tsx owns the main dashboard shell. Keep provider-specific adapters outside the shell so agents can share the same project model.",
    );
  await page.getByLabel("Related file", { exact: false }).fill("src/Dashboard.tsx");
  await page.getByLabel("Pin important context").check();
  await page.getByRole("button", { name: "Save memory", exact: true }).click();
  await expect(page.getByRole("region", { name: "Memory details" })).toContainText(
    "Dashboard owns the workspace shell",
  );
  await expect(page.getByRole("button", { name: "Pinned", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Keep permanently", exact: true }).click();
  await expect(page.getByRole("button", { name: "Permanent", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Knowledge", exact: true })
    .fill(
      "Dashboard.tsx owns the dashboard shell. Provider adapters remain separate to preserve provider independence.",
    );
  await page.getByRole("button", { name: "Save memory", exact: true }).click();
  await expect(page.getByRole("region", { name: "Memory details" })).toContainText("preserve provider independence");
  await page.getByLabel("Search project memory").fill("no such decision");
  await expect(page.getByText("No matching memories")).toBeVisible();
  await page.getByLabel("Search project memory").fill("provider");
  await expect(page.getByRole("list", { name: "Project memories" })).toContainText("Dashboard owns");
  await page.getByLabel("Search project memory").clear();
  await page.screenshot({ path: testInfo.outputPath("unified-memory-desktop.png") });
  const accessibility = await new AxeBuilder({ page })
    .include('section[aria-label="Unified Memory"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByRole("button", { name: "Memory preferences" }).click();
  await page.getByRole("checkbox", { name: /Automatically remember/ }).uncheck();
  await page.getByRole("checkbox", { name: /Share relevant memory/ }).uncheck();
  await expect(page.getByText(/Agent sharing paused/)).toBeVisible();
  await page.getByRole("button", { name: "Memory preferences" }).click();
  await page.setViewportSize({ width: 760, height: 860 });
  await expect(page.getByRole("region", { name: "Memory details" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("unified-memory-compact.png") });
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Keep memory", exact: true }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Remove memory", exact: true }).click();
  await expect(page.getByText("Start with what matters")).toBeVisible();
});

test("switching projects isolates their memories", async ({ page }) => {
  await page.goto("/?scenario=code");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Unified Memory" }).click();
  const workspace = page.getByLabel("Memory workspace");
  const original = await workspace.inputValue();
  await page.getByRole("button", { name: "Remember something" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Project-only release rule");
  await page
    .getByRole("textbox", { name: "Knowledge", exact: true })
    .fill("Release candidates require a signed build and verified update feed.");
  await page.getByRole("button", { name: "Save memory", exact: true }).click();
  const other = await workspace
    .locator("option")
    .evaluateAll(
      (options, active) =>
        options.map((option) => (option as HTMLOptionElement).value).find((value) => value !== active),
      original,
    );
  expect(other).toBeTruthy();
  await workspace.selectOption(other as string);
  await expect(page.getByText("Start with what matters")).toBeVisible();
  await expect(page.getByText("Project-only release rule")).toHaveCount(0);
  await workspace.selectOption(original);
  await expect(page.getByRole("list", { name: "Project memories" })).toContainText("Project-only release rule");
});
