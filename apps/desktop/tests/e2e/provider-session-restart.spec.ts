import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ProviderAccount } from "@kalcode/protocol";
import { expect, type Page } from "@playwright/test";
import {
  ACCOUNT_KALVOICE_FIXTURE_OPT_IN,
  closeGracefully,
  createAccountFixtureDataDir,
  EXE,
  launch,
  RESOURCE_PROVIDER_FIXTURE_OPT_IN,
  type Running,
  removeDir,
  test,
  waitForProviderAdmission,
} from "./harness.ts";
import { goTo } from "./nav.ts";

// Real application restart, SQLite, IPC and PTY; isolated fake provider, no credentials or inference.
test.skip(process.platform !== "win32", "The native restart harness drives Windows WebView2.");
const FAKE = join(dirname(EXE), "kalcode-fake-provider.exe");
test.skip(!existsSync(EXE) || !existsSync(FAKE), "Build the native E2E app and provider helper first.");

function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    ([name, payload]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke(name, payload),
    [command, args] as const,
  ) as Promise<T>;
}

test("connected accounts survive restart, launch without Refresh and isolate genuine expiry", async () => {
  test.setTimeout(240_000);
  const dataDir = createAccountFixtureDataDir();
  const root = mkdtempSync(join(tmpdir(), "kalcode-provider-restart-"));
  const project = join(root, "project");
  const bin = join(root, "bin");
  mkdirSync(project);
  mkdirSync(bin);
  writeFileSync(join(project, "README.md"), "# Isolated restart proof\n");
  copyFileSync(FAKE, join(bin, "claude.exe"));
  copyFileSync(FAKE, join(bin, "codex.exe"));
  const configure = (codexFirstAccountReadDelayMs: number) =>
    writeFileSync(
      join(bin, "fake-provider.json"),
      JSON.stringify({
        versions: { claude: "2.1.282 (Claude Code)", codex: "codex-cli 0.160.0" },
        codexFirstAccountReadDelayMs,
        codexPlan: "pro",
      }),
    );
  configure(0);
  const env = {
    KALCODE_E2E_ACCOUNT_FIXTURE: ACCOUNT_KALVOICE_FIXTURE_OPT_IN,
    KALCODE_E2E_RESOURCE_FIXTURE: RESOURCE_PROVIDER_FIXTURE_OPT_IN,
    KALCODE_E2E_PICK_FOLDER: project,
    PATH: `${bin};${process.env.PATH ?? ""}`,
  };
  let app: Running | null = null;
  try {
    app = await launch(dataDir, env);
    await expect(app.page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await invoke<{ id: string }>(app.page, "workspace_open_dialog");
    const providers = await invoke<{ id: string; detection: { displayPath: string | null } | null }[]>(
      app.page,
      "providers_detect",
    );
    expect(providers.find((provider) => provider.id === "claude-code")?.detection?.displayPath).toContain(
      basename(root),
    );
    expect(providers.find((provider) => provider.id === "codex")?.detection?.displayPath).toContain(basename(root));
    const before = await invoke<ProviderAccount[]>(app.page, "provider_accounts_list");
    const claudeA = before.find((account) => account.providerId === "claude-code");
    const codexA = before.find((account) => account.providerId === "codex");
    expect(claudeA).toBeTruthy();
    expect(codexA).toBeTruthy();
    if (!claudeA || !codexA) throw new Error("The primary Claude and Codex accounts are required");
    await invoke(app.page, "provider_account_rename", { accountId: claudeA.id, displayName: "Claude A" });
    await invoke(app.page, "provider_account_rename", { accountId: codexA.id, displayName: "Codex A" });
    const claudeB = await invoke<ProviderAccount>(app.page, "provider_account_create", {
      providerId: "claude-code",
      displayName: "Claude B",
    });
    const codexB = await invoke<ProviderAccount>(app.page, "provider_account_create", {
      providerId: "codex",
      displayName: "Codex B",
    });
    expect(claudeB.isDefault).toBe(false);
    expect(codexB.isDefault).toBe(false);
    await invoke(app.page, "provider_account_set_default", { accountId: codexB.id });
    const saved = await invoke<ProviderAccount[]>(app.page, "provider_accounts_list");
    expect(saved.find((account) => account.id === codexB.id)?.isDefault).toBe(true);
    const codexAReadMarker = join(
      dataDir,
      "provider-profiles",
      "providers",
      "codex",
      "accounts",
      codexA.id,
      "home",
      ".kalcode-fake-first-account-read",
    );
    await closeGracefully(app);
    app = null;
    // The initial app can validate the fixture's original default. Reset only this synthetic
    // account's test marker while the app is closed so the next launch owns the delay proof.
    rmSync(codexAReadMarker, { force: true });
    // Seed only synthetic, non-secret account metadata after the isolated app is fully closed.
    // Claude auth status is intentionally never invoked: affected native versions can lose a
    // refreshed token on exit. Native login outcome tests cover sign-in; this proves restart.
    const identity = "restart@example.test";
    execFileSync(
      "python",
      [
        "-c",
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); pairs=[(sys.argv[i+1],sys.argv[i]) for i in range(2,10,2)]; r=c.executemany(\"UPDATE provider_accounts SET authentication_state='authenticated', provider_reported_identity=?, last_checked_at='2026-10-03T00:00:00Z', last_error_code=NULL WHERE id=? AND archived_at IS NULL\", pairs); assert r.rowcount == 4; c.commit(); c.close()",
        join(dataDir, "kalcode.db"),
        claudeB.id,
        identity,
        claudeA.id,
        "primary@example.test",
        codexA.id,
        "codex-a@example.test",
        codexB.id,
        "codex-b@example.test",
      ],
      { windowsHide: true, stdio: "pipe" },
    );
    configure(10_000);
    app = await launch(dataDir, env);
    await expect(app.page.getByRole("heading", { level: 1, name: "project" })).toBeVisible();
    const restored = await invoke<ProviderAccount[]>(app.page, "provider_accounts_list");
    expect(
      restored.map(({ id, displayName, providerId, isDefault }) => ({ id, displayName, providerId, isDefault })),
    ).toEqual(saved.map(({ id, displayName, providerId, isDefault }) => ({ id, displayName, providerId, isDefault })));
    expect(restored.find((account) => account.id === claudeB.id)).toMatchObject({
      authenticationState: "authenticated",
      displayName: "Claude B",
      isDefault: false,
      providerReportedIdentity: identity,
      lastCheckedAt: "2026-10-03T00:00:00Z",
    });
    expect(restored.find((account) => account.id === codexA.id)).toMatchObject({
      authenticationState: "authenticated",
      displayName: "Codex A",
      isDefault: false,
      providerReportedIdentity: "codex-a@example.test",
      lastCheckedAt: "2026-10-03T00:00:00Z",
    });
    expect(restored.find((account) => account.id === codexB.id)).toMatchObject({
      authenticationState: "authenticated",
      displayName: "Codex B",
      isDefault: true,
    });
    await expect.poll(() => existsSync(codexAReadMarker), { timeout: 30_000 }).toBe(true);
    await waitForProviderAdmission(app.page);
    await app.page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    const launcher = app.page.getByRole("dialog", { name: "New agent" });
    // The launcher lists each provider's accounts as options; the restored default is marked.
    const codexGroup = launcher.getByRole("group", { name: "Codex", exact: true });
    const account = (group: typeof codexGroup, name: string) => group.getByRole("option").filter({ hasText: name });
    await expect(codexGroup.getByRole("option")).toHaveCount(2);
    await expect(account(codexGroup, "Codex A")).toBeVisible();
    await account(codexGroup, "Codex A").click();
    await expect(account(codexGroup, "Codex A")).toHaveAttribute("aria-selected", "true");
    await app.page.screenshot({ path: test.info().outputPath("restored-codex-account-picker.png") });
    expect(readFileSync(codexAReadMarker, "utf8")).toBe("entered\n");
    const launchStartedAt = Date.now();
    await launcher.getByRole("button", { name: "Launch Codex agent", exact: true }).click();
    await expect(launcher).not.toBeVisible({ timeout: 8_000 });
    expect(Date.now() - launchStartedAt).toBeLessThan(8_000);
    const codexThreads = await invoke<{ id: string; providerAccountId: string; runtimeKind: string }[]>(
      app.page,
      "thread_list",
    );
    const codexThread = codexThreads.find((candidate) => candidate.providerAccountId === codexA.id);
    expect(codexThread).toBeTruthy();
    expect(codexThread?.runtimeKind).toBe("interactive_pty");
    if (!codexThread) throw new Error("The restored Codex account did not launch a coding agent");
    const codexPane = app.page.locator(`[data-provider-pane="${codexThread.id}"]`);
    await expect(codexPane).toBeVisible();
    await expect(codexPane.locator("[data-pane-terminal] .xterm-rows")).toContainText(
      "KalCode fake provider (interactive Codex)",
      { timeout: 30_000 },
    );

    await app.page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    await account(codexGroup, "Codex B").click();
    await expect(account(codexGroup, "Codex B")).toHaveAttribute("aria-selected", "true");
    await launcher.getByRole("button", { name: "Launch Codex agent", exact: true }).click();
    await expect(launcher).not.toBeVisible({ timeout: 30_000 });
    const codexBThreads = await invoke<{ id: string; providerAccountId: string; runtimeKind: string }[]>(
      app.page,
      "thread_list",
    );
    const codexBThread = codexBThreads.find((candidate) => candidate.providerAccountId === codexB.id);
    expect(codexBThread).toBeTruthy();
    expect(codexBThread?.runtimeKind).toBe("interactive_pty");
    if (!codexBThread) throw new Error("The restored default Codex account did not launch a coding agent");
    const codexBPane = app.page.locator(`[data-provider-pane="${codexBThread.id}"]`);
    await expect(codexBPane.locator("[data-pane-terminal] .xterm-rows")).toContainText(
      "KalCode fake provider (interactive Codex)",
      { timeout: 30_000 },
    );

    await app.page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    const claudeGroup = launcher.getByRole("group", { name: "Claude Code", exact: true });
    await expect(claudeGroup.getByRole("option")).toHaveCount(2);
    await account(claudeGroup, "Claude B").click();
    await expect(account(claudeGroup, "Claude B")).toHaveAttribute("aria-selected", "true");
    await launcher.getByRole("button", { name: "Launch Claude Code agent", exact: true }).click();
    await expect(launcher).not.toBeVisible({ timeout: 30_000 });
    const threads = await invoke<{ id: string; providerAccountId: string; runtimeKind: string }[]>(
      app.page,
      "thread_list",
    );
    const thread = threads.find((candidate) => candidate.providerAccountId === claudeB.id);
    expect(thread).toBeTruthy();
    expect(thread?.runtimeKind).toBe("interactive_pty");
    if (!thread) throw new Error("The selected restored account did not launch a coding agent");
    const pane = app.page.locator(`[data-provider-pane="${thread.id}"]`);
    await expect(pane).toBeVisible();
    await expect(pane.locator("[data-pane-terminal] .xterm-rows")).toContainText(
      "KalCode fake provider (interactive)",
      { timeout: 30_000 },
    );
    const restartedPage = app.page;
    await expect
      .poll(
        async () => (await invoke<{ status: string }>(restartedPage, "thread_get", { threadId: thread.id })).status,
        {
          timeout: 30_000,
        },
      )
      .toBe("idle");
    // The fake is positively identified above before any terminal input. Exercise the real
    // authenticated hook bridge and runtime event worker, without a provider or credentials.
    await pane.locator("[data-pane-terminal] .xterm-screen").click();
    await app.page.keyboard.type("auth-fail");
    await app.page.keyboard.press("Enter");
    await expect
      .poll(async () => {
        const current = await invoke<ProviderAccount[]>(restartedPage, "provider_accounts_list");
        return current.find((account) => account.id === claudeB.id)?.authenticationState;
      })
      .toBe("not_authenticated");
    const afterExpiry = await invoke<ProviderAccount[]>(app.page, "provider_accounts_list");
    expect(afterExpiry.find((account) => account.id === claudeA.id)?.authenticationState).toBe("authenticated");
    await goTo(app.page, "Providers");
    await app.page.getByRole("tab", { name: "Accounts", exact: true }).click();
    await expect(
      app.page.getByRole("region", { name: /Claude B/ }).getByText("Expired", { exact: true }),
    ).toBeVisible();
    await expect(
      app.page.getByRole("region", { name: /Claude A/ }).getByText("Connected", { exact: true }),
    ).toBeVisible();
    await invoke(app.page, "thread_stop", { threadId: thread.id });
    await invoke(app.page, "thread_stop", { threadId: codexThread.id });
    await invoke(app.page, "thread_stop", { threadId: codexBThread.id });
    const starts = readFileSync(join(bin, "runs.log"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { args: string[] });
    expect(starts.some(({ args }) => args[0] === "auth" && args[1] === "status")).toBe(false);

    await closeGracefully(app);
    app = null;
    configure(0);
    app = await launch(dataDir, env);
    await expect(app.page.getByRole("heading", { level: 1, name: "project" })).toBeVisible();
    await goTo(app.page, "Providers");
    await app.page.getByRole("tab", { name: "Accounts", exact: true }).click();
    const codexARegion = app.page.getByRole("region", { name: /Codex A/ });
    // A coding agent counts as an agent (AGENTS.md agent definition); usage is truthful: the fake
    // provider records no rate limits, so it says so instead of inventing a number.
    await expect(codexARegion.getByText("1 agent", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(codexARegion.getByText("Usage unavailable", { exact: true })).toBeVisible();
    const codexBRegion = app.page.getByRole("region", { name: /Codex B/ });
    // A coding agent counts as an agent (AGENTS.md agent definition); usage is truthful: the fake
    // provider records no rate limits, so it says so instead of inventing a number.
    await expect(codexBRegion.getByText("1 agent", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(codexBRegion.getByText("Usage unavailable", { exact: true })).toBeVisible();
  } finally {
    if (app) await closeGracefully(app);
    removeDir(dataDir);
    removeDir(root);
  }
});
