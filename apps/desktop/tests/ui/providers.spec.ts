import { expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./a11y.ts";
import { goTo } from "./nav.ts";

/** Opens Providers (Accounts is its default tab), then Setup unless another tab is named. */
async function openProviders(page: Page, scenario?: string, tab: "Setup" | "Accounts" = "Setup") {
  await page.goto(scenario ? `/?scenario=${scenario}` : "/");
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await goTo(page, "Providers");
  await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Accounts" })).toHaveAttribute("aria-selected", "true");
  if (tab === "Setup") await page.getByRole("tab", { name: "Setup" }).click();
}

const section = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test.describe("providers", () => {
  test("first visit detects every provider and shows what was found", async ({ page }) => {
    await openProviders(page);
    await expect(page.getByText("never pays for or proxies your AI usage")).toBeVisible();

    const claude = section(page, "Claude Code");
    await expect(claude.getByText("Installed, version 2.1.282")).toBeVisible();
    // Sign-in is the managed accounts' state: the same one the Accounts tab shows.
    await expect(claude.getByText("Signed in (1 account)", { exact: true })).toBeVisible();
    await expect(claude.getByText("~\\.local\\bin\\claude.exe", { exact: true })).toBeVisible();
    await expect(claude.getByText("Adapter ready")).toBeVisible();
    await expect(claude.getByText("Account default (default), Opus, Sonnet, Haiku, Fable")).toBeVisible();

    const codex = section(page, "Codex");
    await expect(codex.getByText("Installed, version 0.155.1")).toBeVisible();
    await expect(codex.getByText("Signed in (1 account)", { exact: true })).toBeVisible();
    await expect(codex.getByText("Adapter ready", { exact: true })).toBeVisible();
    await expect(codex.getByText("Not listed without starting a session")).toBeVisible();

    const gemini = section(page, "Gemini CLI");
    await expect(gemini.getByText("Installed, version 0.12.0")).toBeVisible();
    await expect(gemini.getByText("Adapter ready", { exact: true })).toBeVisible();
    // No Gemini account is signed in: the state, one Sign in action and why, never a terminal login.
    await expect(gemini.getByText("Not signed in", { exact: true })).toBeVisible();
    await expect(gemini.getByText("Gemini opens Google sign-in in your browser for that account only.")).toBeVisible();
    await expect(gemini.getByText(/in a terminal to sign in to Gemini CLI/)).toHaveCount(0);
    await expect(page.getByText(/^Open Accounts/)).toHaveCount(0);
    await expect(gemini.getByText("Auto (default) (default), Pro, Flash, Flash-Lite")).toBeVisible();
    await expect(gemini.getByText("https://geminicli.com/docs/", { exact: true })).toBeVisible();

    // Setup never fakes a "connected" state; Sign in appears only where no account is signed in.
    await expect(page.getByText("Connected", { exact: true }).filter({ visible: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /sign in|log ?in|connect/i }).filter({ visible: true })).toHaveCount(
      1,
    );

    // Sign in goes straight to the default Gemini account's own browser sign-in, on Accounts.
    await gemini.getByRole("button", { name: "Sign in to Gemini CLI account" }).click();
    await expect(page.getByRole("tab", { name: "Accounts" })).toHaveAttribute("aria-selected", "true");
    const account = page.getByRole("region", { name: "Gemini CLI · Personal" });
    await expect(account.getByText("Signed in", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Setup" }).click();
    await expect(gemini.getByText("Signed in (1 account)", { exact: true })).toBeVisible();
    await expect(gemini.getByRole("button", { name: "Sign in to Gemini CLI account" })).toHaveCount(0);
  });

  test("permission mappings are an accessible table", async ({ page }) => {
    await openProviders(page);
    // The raw flags are reference detail, collapsed under each provider until asked for.
    await expect(page.getByRole("table")).toHaveCount(0);
    for (const name of ["Claude Code", "Codex", "Gemini CLI"]) {
      await section(page, name)
        .locator("summary", { hasText: `Permission modes in ${name}` })
        .click();
    }
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
    await expect(bypass.getByRole("cell").first()).toHaveText(/--permission-mode\s*bypassPermissions/);
    await expect(bypass.getByText("Stricter than requested")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(3);
    await expect(page.getByText("only credential files stay unreadable", { exact: false })).toBeVisible();

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
    ).toHaveText(/--sandbox danger-full-access\s*-c approval_policy='never'/);
    await expect(codex.getByRole("row", { name: /Auto/ }).getByRole("cell").first()).toHaveText(
      /--sandbox workspace-write\s*-c approval_policy='never'/,
    );
    const gemini = page.getByRole("table", { name: /Permission modes in Gemini CLI/ });
    await expect(
      gemini
        .getByRole("row", { name: /Bypass/ })
        .getByRole("cell")
        .first(),
    ).toHaveText("--approval-mode yolo");
  });

  test("managed accounts support local metadata and official browser sign-in flows", async ({ page }) => {
    await openProviders(page, undefined, "Accounts");

    const codex = page.getByRole("region", { name: "Codex", exact: true });
    const personal = page.getByRole("region", { name: "Codex · Personal" });
    const work = page.getByRole("region", { name: "Codex · Work" });
    await expect(codex).toBeVisible();
    await expect(codex.getByText("2 accounts · 1 signed in")).toBeVisible();
    await expect(personal.getByText("Default", { exact: true })).toBeVisible();
    await expect(personal.getByText("Signed in", { exact: true })).toBeVisible();
    await expect(work.getByText("Signed out", { exact: true })).toBeVisible();

    const claude = page.getByRole("region", { name: "Claude Code · Personal" });
    await claude.getByRole("button", { name: "More actions for Personal" }).click();
    await expect(claude.getByText("42% left")).toBeVisible();
    await page.getByRole("menu").getByRole("menuitem", { name: "Sign out Personal" }).click();
    await expect(claude.getByText("Signed out", { exact: true })).toBeVisible();
    // Signed out: no usage number, just the one next step.
    await expect(claude.getByText("Sign in to read usage", { exact: true })).toBeVisible();
    await expect(claude.getByText(/% left/)).toHaveCount(0);
    await claude.getByRole("button", { name: "Sign in Personal" }).click();
    await expect(claude.getByText("Signed in", { exact: true })).toBeVisible();
    await expect(claude.getByText("42% left")).toBeVisible();

    await work.getByRole("button", { name: "Sign in Work" }).click();
    await expect(work.getByText("Signed in", { exact: true })).toBeVisible();
    await work.getByRole("button", { name: "More actions for Work" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Set Work as default" }).click();
    await expect(work.getByText("Default", { exact: true })).toBeVisible();

    await work.getByRole("button", { name: "More actions for Work" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Rename Work" }).click();
    await work.getByLabel("Account name for Work").fill("Work profile");
    await work.getByRole("button", { name: "Save account name" }).click();
    const renamed = page.getByRole("region", { name: "Codex · Work profile" });
    await expect(renamed).toBeVisible();

    await renamed.getByRole("button", { name: "Remove Work profile from KalCode" }).click();
    await expect(renamed.getByText(/doesn't sign out of Codex or delete provider credentials/i)).toBeVisible();
    await renamed.getByRole("button", { name: "Confirm remove Work profile" }).click();
    await expect(page.getByRole("region", { name: "Codex · Work profile" })).toHaveCount(0);

    await page.getByRole("button", { name: "Add account", exact: true }).click();
    await page.getByLabel("Provider", { exact: true }).selectOption("gemini-cli");
    await page.getByLabel("Name for the new Gemini CLI account").fill("Side project");
    await page.getByRole("button", { name: "Add and sign in" }).click();
    await expect(page.getByRole("region", { name: "Gemini CLI · Side project" })).toBeVisible();

    const gemini = page.getByRole("region", { name: "Gemini CLI · Personal" });
    await expect(gemini.getByRole("button", { name: "Sign in Personal" })).toBeVisible();
    await expect(gemini.getByRole("button", { name: /auth pane/i })).toHaveCount(0);
    await expect(page.getByText(/Claude Code, Codex and Gemini use managed account profiles/)).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });

  test("Gemini signs in and out from its account row without a provider pane", async ({ page }) => {
    await openProviders(page, undefined, "Accounts");

    // Adding runs Gemini's own sign-in for the new account only.
    await page.getByRole("button", { name: "Add Gemini CLI account" }).click();
    await page.getByLabel("Name for the new Gemini CLI account").fill("Side project");
    await page.getByRole("button", { name: "Add and sign in" }).click();
    const gemini = page.getByRole("region", { name: "Gemini CLI · Side project" });
    await expect(gemini.getByText("Signed in", { exact: true })).toBeVisible();

    await gemini.getByRole("button", { name: "More actions for Side project" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Sign out Side project" }).click();
    await expect(gemini.getByText("Signed out", { exact: true })).toBeVisible();

    await gemini.getByRole("button", { name: "Sign in Side project" }).click();
    await expect(gemini.getByText("Signed in", { exact: true })).toBeVisible();
    // Sign-in stays on the Providers page: no workspace, thread or pane is opened for it.
    await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();
    await expect(page.locator("[data-provider-pane]")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Gemini CLI · Personal" }).getByText("Signed out", { exact: true }),
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

    await page.getByRole("button", { name: "Activity", exact: true }).click();
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity.getByText("Claude Code 2.1.282")).toBeVisible();
    await expect(activity.getByText("Provider detected").first()).toBeVisible();
    await expect(activity.getByText("Gemini CLI 0.12.0")).toBeVisible();
    await expect(activity.getByText("Codex health: unknown → degraded (recent failures)")).toBeVisible();
    // Unchanged results are not recorded again.
    await expect(activity.getByText("Claude Code 2.1.282")).toHaveCount(1);

    const runtime = page.getByRole("region", { name: "Runtime health" });
    await expect(runtime.getByText("4 of 4 installed")).toBeVisible();
    await expect(runtime.getByText("Claude Code, Codex, Gemini CLI, Cursor")).toBeVisible();
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
      ["Codex", "npm install -g @openai/codex"],
      ["Gemini CLI", "npm install -g @google/gemini-cli@0.61.0"],
    ] as const) {
      const region = section(page, name);
      await expect(region.getByText("Not installed", { exact: true })).toBeVisible();
      // No "Adapter ready" beside "Not installed": the pair reads as a contradiction.
      await expect(region.getByText("Adapter ready", { exact: true })).toHaveCount(0);
      await expect(region.getByText(command, { exact: true })).toBeVisible();
      await expect(region.getByText("Sign-in", { exact: true })).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(page.getByRole("region", { name: "Runtime health" }).getByText("0 of 4 installed")).toBeVisible();
  });

  test("a validated managed runtime stays ready without an install detour", async ({ page }) => {
    await openProviders(page, "providers-managed-runtime");
    const codex = section(page, "Codex");
    await expect(codex.getByText("Ready for threads when signed in.", { exact: true })).toBeVisible();
    await expect(codex.getByText("Global CLI", { exact: true })).toBeVisible();
    await expect(codex.getByText("Not installed", { exact: true })).toBeVisible();
    await expect(codex.getByText("KalCode runtime", { exact: true })).toBeVisible();
    await expect(codex.getByText("Ready, version 0.160.0", { exact: true })).toBeVisible();
    await expect(
      codex.getByText("KalCode is using its last known good Codex runtime for managed accounts."),
    ).toBeVisible();
    await expect(codex.getByRole("button", { name: "Copy install command for Codex" })).toHaveCount(0);
    await expect(codex.getByText("Signed in (1 account)", { exact: true })).toBeVisible();
  });

  test("an outdated CLI explains what to do; sign-in stays the accounts' state", async ({ page }) => {
    await openProviders(page, "providers-outdated");
    const claude = section(page, "Claude Code");
    await expect(claude.getByText("Outdated, version 2.1.100")).toBeVisible();
    await expect(claude.getByText("KalCode needs version 2.1.259 or later to run Claude Code threads.")).toBeVisible();
    // Claude Code signs in only through its managed accounts; a terminal `claude` uses another profile.
    await expect(claude.getByText("Signed in (1 account)", { exact: true })).toBeVisible();
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
    // Gemini can't be asked passively; its connected account is the authoritative answer.
    await expect(gemini.getByText("Signed out", { exact: true })).toBeVisible();
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
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await goTo(page, "Providers");
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
        await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
        if (theme === "light") {
          await page.getByRole("button", { name: "Settings" }).click();
          await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
        }
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await goTo(page, "Providers");
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
        await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
        if (theme === "light") {
          await page.getByRole("button", { name: "Settings" }).click();
          await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
        }
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await goTo(page, "Providers");
        await expect(page.getByRole("button", { name: "Check again" })).not.toHaveAttribute("aria-busy", "true");
        // Accounts (the default tab) with real usage, then Setup.
        await expect(page.getByRole("region", { name: "Claude Code · Personal" })).toBeVisible();
        await expectNoSeriousA11yViolations(page);
        await page.getByRole("tab", { name: "Setup" }).click();
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
