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
    await expect(codex.getByText("Checked with codex login status.")).toBeVisible();
    await expect(codex.getByText("Adapter ready", { exact: true })).toBeVisible();
    await expect(codex.getByText("Not listed without starting a session")).toBeVisible();

    const gemini = section(page, "Gemini CLI");
    await expect(gemini.getByText("Installed, version 0.12.0")).toBeVisible();
    await expect(gemini.getByText("Adapter ready", { exact: true })).toBeVisible();
    await expect(gemini.getByText("Sign-in status unknown", { exact: true })).toBeVisible();
    await expect(
      gemini.getByText("Gemini CLI has no documented way to check sign-in without starting a session."),
    ).toBeVisible();
    // Gemini signs in only from its managed account card; a terminal `gemini` uses another profile.
    await expect(gemini.getByText(/^Open Accounts, add a Gemini CLI account and choose Sign in\./)).toBeVisible();
    await expect(gemini.getByText(/in a terminal to sign in to Gemini CLI/)).toHaveCount(0);
    await expect(gemini.getByText("Auto (default) (default), Pro, Flash, Flash-Lite")).toBeVisible();
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

    // Codex and Gemini CLI: the flags KalCode passes, never a broader mode.
    const codex = page.getByRole("table", { name: /Permission modes in Codex/ });
    await expect(codex.getByRole("row", { name: /Plan/ }).getByRole("cell").first()).toHaveText(
      /--sandbox read-only\s*--skip-git-repo-check/,
    );
    await expect(
      codex
        .getByRole("row", { name: /Bypass/ })
        .getByRole("cell")
        .first(),
    ).toHaveText(/--sandbox workspace-write\s*-c sandbox_workspace_write\.network_access=false/);
    const gemini = page.getByRole("table", { name: /Permission modes in Gemini CLI/ });
    await expect(
      gemini
        .getByRole("row", { name: /Bypass/ })
        .getByRole("cell")
        .first(),
    ).toHaveText("--approval-mode auto_edit");
  });

  test("managed accounts support local metadata and official browser sign-in flows", async ({ page }) => {
    await openProviders(page);
    await page.getByRole("tab", { name: "Accounts" }).click();

    const codex = page.getByRole("region", { name: /^Codex 2$/ });
    const personal = page.getByRole("region", { name: "Codex account Personal" });
    const work = page.getByRole("region", { name: "Codex account Work" });
    await expect(codex).toBeVisible();
    await expect(personal.getByText("Default", { exact: true })).toBeVisible();
    await expect(personal.getByText("Signed in", { exact: true })).toBeVisible();
    await expect(work.getByText("Signed out", { exact: true })).toBeVisible();

    const claude = page.getByRole("region", { name: "Claude Code account Personal" });
    await claude.getByRole("button", { name: "Sign out Personal" }).click();
    await expect(claude.getByText("Signed out", { exact: true })).toBeVisible();
    await claude.getByRole("button", { name: "Sign in Personal" }).click();
    await expect(claude.getByText("Signed in", { exact: true })).toBeVisible();

    await work.getByRole("button", { name: "Sign in Work" }).click();
    await expect(work.getByText("Signed in", { exact: true })).toBeVisible();
    await work.getByRole("button", { name: "Set Work as default" }).click();
    await expect(work.getByText("Default", { exact: true })).toBeVisible();

    await work.getByRole("button", { name: "Manage Work" }).click();
    await work.getByRole("button", { name: "Rename Work" }).click();
    await work.getByLabel("Account name for Work").fill("Work profile");
    await work.getByRole("button", { name: "Save account name" }).click();
    const renamed = page.getByRole("region", { name: "Codex account Work profile" });
    await expect(renamed).toBeVisible();

    await renamed.getByRole("button", { name: "Remove Work profile from KalCode" }).click();
    await expect(renamed.getByText(/doesn't sign out of Codex or delete provider credentials/i)).toBeVisible();
    await renamed.getByRole("button", { name: "Confirm remove Work profile" }).click();
    await expect(page.getByRole("region", { name: "Codex account Work profile" })).toHaveCount(0);

    const add = page.getByRole("region", { name: "Add provider account" });
    await add.getByLabel("Provider").selectOption("gemini-cli");
    await add.getByLabel("Account name").fill("Side project");
    await add.getByRole("button", { name: "Add account" }).click();
    await expect(page.getByRole("region", { name: "Gemini CLI account Side project" })).toBeVisible();

    const gemini = page.getByRole("region", { name: "Gemini CLI account Personal" });
    await expect(gemini.getByRole("button", { name: "Sign in Personal" })).toBeVisible();
    await expect(gemini.getByRole("button", { name: /auth pane/i })).toHaveCount(0);
    await expect(page.getByText(/Gemini CLI opens Google sign-in in your browser/)).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });

  test("Gemini signs in and out from its account card without a provider pane", async ({ page }) => {
    await openProviders(page);
    await page.getByRole("tab", { name: "Accounts" }).click();

    const add = page.getByRole("region", { name: "Add provider account" });
    await add.getByLabel("Provider").selectOption("gemini-cli");
    await add.getByLabel("Account name").fill("Side project");
    await add.getByRole("button", { name: "Add account" }).click();
    const gemini = page.getByRole("region", { name: "Gemini CLI account Side project" });
    await expect(gemini.getByText("Not checked", { exact: true })).toBeVisible();

    await gemini.getByRole("button", { name: "Sign in Side project" }).click();
    await expect(gemini.getByText("Signed in", { exact: true })).toBeVisible();
    // Sign-in stays on the Providers page: no workspace, thread or pane is opened for it.
    await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();
    await expect(page.locator("[data-provider-pane]")).toHaveCount(0);

    await gemini.getByRole("button", { name: "Sign out Side project" }).click();
    await expect(gemini.getByText("Signed out", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Gemini CLI account Personal" }).getByText("Not checked", { exact: true }),
    ).toBeVisible();
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
    await expect(activity.getByText("Gemini CLI 0.12.0")).toBeVisible();
    await expect(activity.getByText("Codex health: unknown → degraded (recent failures)")).toBeVisible();
    // Unchanged results are not recorded again.
    await expect(activity.getByText("Claude Code 2.1.282")).toHaveCount(1);

    const runtime = page.getByRole("region", { name: "Runtime health" });
    await expect(runtime.getByText("3 of 3 installed")).toBeVisible();
    await expect(runtime.getByText("Claude Code, Codex, Gemini CLI")).toBeVisible();
  });

  test("the dashboard does not start detection on its own", async ({ page }) => {
    await page.goto("/");
    const runtime = page.getByRole("region", { name: "Runtime health" });
    await expect(runtime.getByText("Not checked", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Provider detected")).toHaveCount(0);
  });

  test("copying an install command never runs it", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openProviders(page, "providers-none");
    await section(page, "Gemini CLI").getByRole("button", { name: "Copy install command for Gemini CLI" }).click();
    await expect(page.getByText("Install command copied")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("npm install -g @google/gemini-cli@0.61.0");
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
      ["Codex", "npm install -g @openai/codex@0.158.0"],
      ["Gemini CLI", "npm install -g @google/gemini-cli@0.61.0"],
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
    // Claude Code signs in only from its managed account card; a terminal `claude` uses another profile.
    await expect(claude.getByText(/^Open Accounts, add a Claude Code account and choose Sign in\./)).toBeVisible();
    await expect(claude.getByText(/in a terminal to sign in to Claude Code/)).toHaveCount(0);
  });

  test("health tab shows each provider's state, observations and what to do", async ({ page }) => {
    await openProviders(page);
    await expect(section(page, "Claude Code").getByText("Installed, version 2.1.282")).toBeVisible();
    await page.getByRole("tab", { name: "Health" }).click();
    await expect(page.getByRole("tab", { name: "Health" })).toHaveAttribute("aria-selected", "true");
    const view = page.getByRole("region", { name: "Provider health" });

    const claude = view.locator("#health-claude-code");
    await expect(claude).toHaveAttribute("data-health-state", "healthy");
    await expect(claude.getByRole("heading", { name: "Claude Code" })).toBeVisible();
    await expect(claude.getByText("Healthy", { exact: true })).toBeVisible();
    await expect(claude.getByText("Running · 2 active sessions")).toBeVisible();
    await expect(claude.getByText("Signed in", { exact: true })).toBeVisible();
    await expect(claude.getByText("Version 2.1.282 · needs 2.1.259 or later")).toBeVisible();
    await expect(claude.getByText(/^p50 1\.8 s · p95 4\.2 s/)).toBeVisible();
    await expect(claude.getByText("None in the last hour")).toBeVisible();
    await expect(claude.getByText("None reported")).toBeVisible();
    await expect(claude.getByText("Stable", { exact: true })).toBeVisible();

    const codex = view.locator("#health-codex");
    await expect(codex).toHaveAttribute("data-health-state", "degraded");
    await expect(codex.getByText("Degraded", { exact: true })).toBeVisible();
    await expect(codex.getByText("2 recent Codex sessions failed without a successful turn since.")).toBeVisible();
    await expect(codex.getByText(/^2 failures in the last hour · last: turn_failed, /)).toBeVisible();
    await expect(codex.getByText("None reported")).toBeVisible();
    await expect(codex.getByText("Worsening", { exact: true })).toBeVisible();
    await expect(codex.getByText("Restart the affected thread, or choose Check again.")).toBeVisible();

    const gemini = view.locator("#health-gemini-cli");
    await expect(gemini).toHaveAttribute("data-health-state", "healthy");
    await expect(gemini.getByText("Gemini CLI has no documented way to check sign-in", { exact: true })).toBeVisible();
    await expect(gemini.getByText("Version 0.12.0 · no minimum declared")).toBeVisible();
    await expect(gemini.getByText("Not enough data yet")).toBeVisible();

    // Last 24 hours: a summary, decorative bars and the same numbers as a table.
    await expect(claude.getByText(/^\d+ sessions, 1 failure in the last 24 hours$/)).toBeVisible();
    await claude.getByText("Hourly numbers").click();
    const table = claude.getByRole("table", { name: "Claude Code: sessions and failures per hour, last 24 hours" });
    await expect(table.getByRole("columnheader")).toHaveText(["Hour", "Sessions", "Failures", "First output (p50)"]);
    expect(await table.getByRole("row").count()).toBeGreaterThan(2);

    // KalCode never invents a rate limit or quota.
    await expect(view.getByText(/rate limit reported|quota/i)).toHaveCount(0);
  });

  test("health tab: providers that can't run say why and how to recover", async ({ page }) => {
    await openProviders(page, "providers-none");
    await page.getByRole("tab", { name: "Health" }).click();
    const view = page.getByRole("region", { name: "Provider health" });
    const gemini = view.locator("#health-gemini-cli");
    await expect(gemini).toHaveAttribute("data-health-state", "unavailable");
    await expect(gemini.getByText("Gemini CLI isn't installed.")).toBeVisible();
    await expect(gemini.getByText("npm install -g @google/gemini-cli@0.61.0", { exact: true })).toBeVisible();
    await expect(gemini.getByText("No sessions in the last 15 minutes")).toBeVisible();
    await expect(gemini.getByText("No sessions in the last 24 hours")).toBeVisible();

    await openProviders(page, "providers-signed-out");
    await page.getByRole("tab", { name: "Health" }).click();
    const codex = page.getByRole("region", { name: "Provider health" }).locator("#health-codex");
    await expect(codex).toHaveAttribute("data-health-state", "unavailable");
    await expect(codex.getByText("Signed out", { exact: true })).toBeVisible();
    await expect(codex.getByText("codex login", { exact: true })).toBeVisible();
  });

  test("health tab shows a reported rate limit without inventing numbers", async ({ page }) => {
    await openProviders(page, "providers-backoff");
    await page.getByRole("tab", { name: "Health" }).click();
    const codex = page.getByRole("region", { name: "Provider health" }).locator("#health-codex");
    await expect(codex).toHaveAttribute("data-health-state", "degraded");
    await expect(codex.getByText("Codex reported a rate limit", { exact: true })).toBeVisible();
    await expect(codex.getByText("Codex didn't say when to retry. New work waits.")).toBeVisible();
    await expect(codex.getByText("Expected to recover on its own once Codex's limit clears.")).toBeVisible();
  });

  test("health tab refreshes on provider events and Check again; a failure never blocks the page", async ({ page }) => {
    await openProviders(page);
    await page.getByRole("tab", { name: "Health" }).click();
    const codex = page.getByRole("region", { name: "Provider health" }).locator("#health-codex");
    await expect(codex).toHaveAttribute("data-health-state", "degraded");
    // A session succeeds: the runtime records provider.health_changed and the view follows.
    await page.evaluate(() => {
      (
        window as unknown as {
          __kalcodeMemory: { health: { observe: (id: string, patch: Record<string, unknown>) => void } };
        }
      ).__kalcodeMemory.health.observe("codex", { failuresSinceSuccess: 0, recentFailures: 0, lastFailure: null });
    });
    await expect(codex).toHaveAttribute("data-health-state", "healthy");

    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByRole("button", { name: "Check again" })).not.toHaveAttribute("aria-busy", "true");
    await expect(codex).toHaveAttribute("data-health-state", "healthy");

    await page.goto("/?health=error");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await page.getByRole("button", { name: "Providers" }).click();
    await page.getByRole("tab", { name: "Health" }).click();
    const unknown = page.getByRole("region", { name: "Provider health" }).getByRole("alert");
    await expect(unknown.getByText("Health unknown")).toBeVisible();
    await expect(unknown.getByText(/Threads aren't affected/)).toBeVisible();
    await page.getByRole("tab", { name: "Setup" }).click();
    await expect(section(page, "Claude Code").getByText("Installed, version 2.1.282")).toBeVisible();
  });

  for (const theme of ["dark", "light"] as const) {
    test(`health tab passes axe in ${theme} theme`, async ({ page }) => {
      for (const scenario of [undefined, "providers-none", "providers-backoff"]) {
        await page.goto(scenario ? `/?scenario=${scenario}` : "/");
        await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
        if (theme === "light") {
          await page.getByRole("button", { name: "Settings" }).click();
          await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
        }
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await page.getByRole("button", { name: "Providers" }).click();
        await expect(page.getByRole("button", { name: "Check again" })).not.toHaveAttribute("aria-busy", "true");
        await page.getByRole("tab", { name: "Health" }).click();
        const claude = page.getByRole("region", { name: "Provider health" }).locator("#health-claude-code");
        await expect(claude).not.toHaveAttribute("data-health-state", "unknown");
        if (scenario !== "providers-none") await claude.getByText("Hourly numbers").click();
        await expectNoSeriousA11yViolations(page);
      }
    });
  }

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
