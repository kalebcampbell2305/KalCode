import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

async function openProviders(page: Page, scenario?: string) {
  await page.goto(scenario ? `/?scenario=${scenario}` : "/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "Providers" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();
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

const section = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test.describe("providers", () => {
  test("first visit detects every provider and shows what was found", async ({ page }) => {
    await openProviders(page);
    await expect(page.getByText("never pays for or proxies your AI usage")).toBeVisible();

    const claude = section(page, "Claude Code");
    await expect(claude.getByText("Installed, version 2.1.282")).toBeVisible();
    await expect(claude.getByText("Signed in", { exact: true })).toBeVisible();
    await expect(claude.getByText("Checked with claude auth status.")).toBeVisible();
    await expect(claude.getByText("~\\.local\\bin\\claude.exe", { exact: true })).toBeVisible();
    await expect(claude.getByText("Adapter ready")).toBeVisible();
    await expect(claude.getByText("Account default (default), Opus, Sonnet, Haiku, Fable")).toBeVisible();

    const codex = section(page, "Codex");
    await expect(codex.getByText("Installed, version 0.155.1")).toBeVisible();
    await expect(codex.getByText("Signed in", { exact: true })).toBeVisible();
    await expect(codex.getByText("Detection only", { exact: true })).toBeVisible();
    await expect(codex.getByText("Not listed without starting a session")).toBeVisible();

    const gemini = section(page, "Gemini CLI");
    await expect(gemini.getByText("Not installed", { exact: true })).toBeVisible();
    await expect(gemini.getByText("npm install -g @google/gemini-cli", { exact: true })).toBeVisible();
    await expect(gemini.getByRole("button", { name: "Copy install command for Gemini CLI" })).toBeVisible();
    await expect(gemini.getByText("https://geminicli.com/docs/", { exact: true })).toBeVisible();

    // Never a fake "connected" state, and no sign-in button: users sign in with their own CLI.
    await expect(page.getByText(/connected/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /sign in|log ?in|connect/i })).toHaveCount(0);
  });

  test("permission mappings are an accessible table", async ({ page }) => {
    await openProviders(page);
    const table = page.getByRole("table", { name: /Permission modes in Claude Code/ });
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader")).toHaveText([
      "KalCode mode",
      "Claude Code setting",
      "Fidelity",
      "What happens",
    ]);
    const bypass = table.getByRole("row", { name: /Bypass/ });
    await expect(bypass.getByRole("rowheader")).toHaveText("Bypass");
    await expect(bypass.getByRole("cell").first()).toHaveText(/--permission-mode\s*acceptEdits/);
    await expect(bypass.getByText("Stricter than requested")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(3);
    await expect(page.getByText("bypassPermissions mode is never used", { exact: false })).toBeVisible();
  });

  test("check again shows progress and records detection in the activity feed", async ({ page }) => {
    await openProviders(page);
    const checkAgain = page.getByRole("button", { name: "Check again" });
    await expect(section(page, "Claude Code").getByText("Installed, version 2.1.282")).toBeVisible();
    await expect(checkAgain).toBeEnabled();

    await checkAgain.click();
    await expect(checkAgain).toHaveAttribute("aria-busy", "true");
    await expect(page.getByText("Checking providers…")).toBeVisible();
    await expect(checkAgain).not.toHaveAttribute("aria-busy", "true");
    await expect(page.getByText(/^Checked just now$/)).toBeVisible();

    await page.getByRole("button", { name: "Dashboard" }).click();
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity.getByText("Claude Code 2.1.282")).toBeVisible();
    await expect(activity.getByText("Provider detected").first()).toBeVisible();
    await expect(activity.getByText("Provider not installed")).toBeVisible();
    // Unchanged results are not recorded again.
    await expect(activity.getByText("Claude Code 2.1.282")).toHaveCount(1);

    const runtime = page.getByRole("region", { name: "Runtime health" });
    await expect(runtime.getByText("2 of 3 installed")).toBeVisible();
    await expect(runtime.getByText("Claude Code, Codex")).toBeVisible();
  });

  test("the dashboard does not start detection on its own", async ({ page }) => {
    await page.goto("/");
    const runtime = page.getByRole("region", { name: "Runtime health" });
    await expect(runtime.getByText("Not checked", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Provider detected")).toHaveCount(0);
  });

  test("copying an install command never runs it", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openProviders(page);
    await section(page, "Gemini CLI").getByRole("button", { name: "Copy install command for Gemini CLI" }).click();
    await expect(page.getByText("Install command copied")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("npm install -g @google/gemini-cli");
  });

  test("a failed check is explained and can be retried", async ({ page }) => {
    await openProviders(page, "providers-error");
    const error = page.getByRole("alert").filter({ hasText: "Couldn't check providers" });
    await expect(error).toBeVisible();
    await expect(error.getByText("Checking providers was interrupted.")).toBeVisible();
    await expect(error.getByText("Error code: internal/detection_interrupted")).toBeVisible();
    // Static facts stay available; nothing claims to be installed.
    await expect(section(page, "Claude Code").getByText("Not checked yet")).toBeVisible();
    await expect(page.getByText(/Installed, version/)).toHaveCount(0);
    await error.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Couldn't check providers" })).toBeVisible();
  });

  test("with nothing installed, each provider shows how to install it", async ({ page }) => {
    await openProviders(page, "providers-none");
    for (const [name, command] of [
      ["Claude Code", "irm https://claude.ai/install.ps1 | iex"],
      ["Codex", "npm install -g @openai/codex"],
      ["Gemini CLI", "npm install -g @google/gemini-cli"],
    ] as const) {
      const region = section(page, name);
      await expect(region.getByText("Not installed", { exact: true })).toBeVisible();
      await expect(region.getByText(command, { exact: true })).toBeVisible();
      await expect(region.getByText("Sign-in", { exact: true })).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Dashboard" }).click();
    await expect(page.getByRole("region", { name: "Runtime health" }).getByText("0 of 3 installed")).toBeVisible();
  });

  test("an outdated, signed-out CLI explains what to do", async ({ page }) => {
    await openProviders(page, "providers-outdated");
    const claude = section(page, "Claude Code");
    await expect(claude.getByText("Outdated, version 2.1.100")).toBeVisible();
    await expect(claude.getByText("KalCode needs version 2.1.259 or later to run Claude Code threads.")).toBeVisible();
    await expect(claude.getByText("Signed out", { exact: true })).toBeVisible();
    await expect(claude.getByText("claude auth login", { exact: true })).toBeVisible();
    await expect(claude.getByText(/in a terminal to sign in to Claude Code with your own account/)).toBeVisible();
  });

  for (const theme of ["dark", "light"] as const) {
    test(`providers page passes axe in ${theme} theme`, async ({ page }) => {
      for (const scenario of [undefined, "providers-outdated", "providers-error"]) {
        await page.goto(scenario ? `/?scenario=${scenario}` : "/");
        await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
        if (theme === "light") {
          await page.getByRole("button", { name: "Settings" }).click();
          await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
        }
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await page.getByRole("button", { name: "Providers" }).click();
        await expect(page.getByRole("button", { name: "Check again" })).not.toHaveAttribute("aria-busy", "true");
        await expect(
          section(page, "Claude Code")
            .getByText(/Installed|Outdated|Not checked yet/)
            .first(),
        ).toBeVisible();
        await expectNoSeriousA11yViolations(page);
      }
    });
  }
});
