import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("a second connected account survives a complete restart and launches without Refresh", async () => {
  test.setTimeout(180_000);
  const dataDir = createAccountFixtureDataDir();
  const root = mkdtempSync(join(tmpdir(), "kalcode-provider-restart-"));
  const project = join(root, "project");
  const bin = join(root, "bin");
  mkdirSync(project);
  mkdirSync(bin);
  writeFileSync(join(project, "README.md"), "# Isolated restart proof\n");
  copyFileSync(FAKE, join(bin, "claude.exe"));
  const configure = (versionDelayMs: number) =>
    writeFileSync(
      join(bin, "fake-provider.json"),
      JSON.stringify({ versions: { claude: "2.1.282 (Claude Code)" }, versionDelayMs }),
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
    await expect(app.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await invoke(app.page, "workspace_open_dialog");
    const providers = await invoke<{ id: string; detection: { displayPath: string | null } | null }[]>(
      app.page,
      "providers_detect",
    );
    expect(providers.find((provider) => provider.id === "claude-code")?.detection?.displayPath).toContain(
      basename(root),
    );
    const before = await invoke<ProviderAccount[]>(app.page, "provider_accounts_list");
    const primary = before.find((account) => account.providerId === "claude-code");
    expect(primary).toBeTruthy();
    await invoke(app.page, "provider_account_rename", { accountId: primary?.id, displayName: "Claude A" });
    const second = await invoke<ProviderAccount>(app.page, "provider_account_create", {
      providerId: "claude-code",
      displayName: "Claude B",
    });
    expect(second.isDefault).toBe(false);
    const saved = await invoke<ProviderAccount[]>(app.page, "provider_accounts_list");
    await closeGracefully(app);
    app = null;
    // Seed only synthetic, non-secret account metadata after the isolated app is fully closed.
    // Claude auth status is intentionally never invoked: affected native versions can lose a
    // refreshed token on exit. Native login outcome tests cover sign-in; this proves restart.
    const identity = "restart@example.test";
    execFileSync(
      "python",
      [
        "-c",
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); r=c.execute(\"UPDATE provider_accounts SET authentication_state='authenticated', provider_reported_identity=?, last_checked_at='2026-10-03T00:00:00Z', last_error_code=NULL WHERE id=? AND archived_at IS NULL\", (sys.argv[3],sys.argv[2])); assert r.rowcount == 1; c.commit(); c.close()",
        join(dataDir, "kalcode.db"),
        second.id,
        identity,
      ],
      { windowsHide: true, stdio: "pipe" },
    );
    configure(1500);
    app = await launch(dataDir, env);
    await expect(app.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    const restored = await invoke<ProviderAccount[]>(app.page, "provider_accounts_list");
    expect(
      restored.map(({ id, displayName, providerId, isDefault }) => ({ id, displayName, providerId, isDefault })),
    ).toEqual(saved.map(({ id, displayName, providerId, isDefault }) => ({ id, displayName, providerId, isDefault })));
    expect(restored.find((account) => account.id === second.id)).toMatchObject({
      authenticationState: "authenticated",
      displayName: "Claude B",
      isDefault: false,
      providerReportedIdentity: identity,
      lastCheckedAt: "2026-10-03T00:00:00Z",
    });
    await waitForProviderAdmission(app.page);
    await app.page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Code", exact: true })
      .click();
    await app.page.getByRole("button", { name: "New agent", exact: true }).click();
    const launcher = app.page.getByRole("dialog", { name: "New agent" });
    const accountPicker = launcher.getByLabel("Account", { exact: true });
    await expect(accountPicker.locator("option")).toHaveCount(2);
    await expect(accountPicker.locator(`option[value="${second.id}"]`)).toContainText("Claude B");
    await accountPicker.selectOption(second.id);
    await app.page.screenshot({ path: test.info().outputPath("restored-account-picker.png") });
    await launcher.getByRole("button", { name: "Launch Claude Code agent", exact: true }).click();
    await expect(launcher).not.toBeVisible({ timeout: 30_000 });
    const pane = app.page.locator("[data-provider-pane]").first();
    await expect(pane).toBeVisible();
    await expect(pane.locator("[data-pane-terminal] .xterm-rows")).toContainText(
      "KalCode fake provider (interactive)",
      { timeout: 30_000 },
    );
    const threads = await invoke<{ id: string; providerAccountId: string; runtimeKind: string }[]>(
      app.page,
      "thread_list",
    );
    const thread = threads.find((candidate) => candidate.providerAccountId === second.id);
    expect(thread).toBeTruthy();
    expect(thread?.runtimeKind).toBe("interactive_pty");
    if (!thread) throw new Error("The selected restored account did not launch a coding agent");
    const restartedPage = app.page;
    await expect
      .poll(
        async () => (await invoke<{ status: string }>(restartedPage, "thread_get", { threadId: thread.id })).status,
        {
          timeout: 30_000,
        },
      )
      .toBe("idle");
    await invoke(app.page, "thread_stop", { threadId: thread.id });
    const starts = readFileSync(join(bin, "runs.log"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { args: string[] });
    expect(starts.some(({ args }) => args[0] === "auth" && args[1] === "status")).toBe(false);
  } finally {
    if (app) await closeGracefully(app);
    removeDir(dataDir);
    removeDir(root);
  }
});
