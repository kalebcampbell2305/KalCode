import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PaneInfo, ThreadSummary } from "@kalcode/protocol";
import { expect, type Page } from "@playwright/test";
import {
  ACCOUNT_KALVOICE_FIXTURE_OPT_IN,
  closeGracefully,
  createAccountFixtureDataDir,
  EXE,
  launch,
  processesMatching,
  RESOURCE_PROVIDER_FIXTURE_OPT_IN,
  removeDir,
  test,
  waitForProviderAdmission,
  writeManagedFakeProviderConfig,
} from "./harness.ts";

/**
 * Z7-W4 end to end against the real app: a provider pane runs a provider CLI in a real
 * pseudo-terminal, its hooks reach KalCode through the real `kalcode-hook` helper and bridge,
 * the tool call is judged by the real permission engine, the approval is answered in KalCode's
 * approval UI, and the decision reaches the provider.
 *
 * The provider is the FAKE provider (`kalcode-fake-provider`, copied as `claude.exe` into a
 * folder placed first on PATH). It contacts no AI service. Nothing is typed into the pane until
 * the pane shows the fake's banner, so a misconfigured run can never send a prompt to a real
 * provider.
 *
 * Build first: pnpm --filter @kalcode/desktop build:e2e (builds kalcode-hook and the fake next to
 * kalcode.exe), with KALCODE_E2E_CDP_PORT=9452 for this worktree.
 */
test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

const FAKE = join(dirname(EXE), "kalcode-fake-provider.exe");
const HELPER = join(dirname(EXE), "kalcode-hook.exe");
test.skip(!existsSync(FAKE) || !existsSync(HELPER), "Run build:e2e: it builds kalcode-hook and the fake provider.");

const FAKE_BANNER = "KalCode fake provider (interactive)";

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

interface FakeLaunch {
  exe: string;
  args: string[];
}

function claudeLaunches(bin: string): FakeLaunch[] {
  const path = join(bin, "runs.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeLaunch)
    .filter(({ exe, args }) => exe.toLowerCase() === "claude.exe" && args.includes("--settings"));
}

function argAfter(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

const codeNav = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true });

async function shot(page: Page, name: string) {
  const dir = fileURLToPath(new URL("../../qa/screenshots/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

function pane(page: Page) {
  return page.locator("[data-provider-pane]").first();
}

async function typeInPane(page: Page, line: string) {
  await pane(page).locator("[data-pane-terminal] .xterm-screen").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function expectPaneText(page: Page, text: string, timeout = 30_000) {
  await expect(pane(page).locator("[data-pane-terminal] .xterm-rows")).toContainText(text, { timeout });
}

test("a provider pane runs routine coding in Bypass and still gates credential access", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-panes-"));
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-panes-project-"));
  const project = join(root, "pane-site");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# pane site\n");
  // The fake provider, found by KalCode's normal detection as `claude.exe` (first on PATH).
  const bin = join(root, "bin");
  mkdirSync(bin);
  copyFileSync(FAKE, join(bin, "claude.exe"));
  writeManagedFakeProviderConfig(bin);

  const env = {
    KALCODE_E2E_PICK_FOLDER: project,
    // The default routing (engine), stated explicitly so the test doesn't depend on it.
    KALCODE_E2E_HOOK_DECISIONS: "engine",
    KALCODE_E2E_RESOURCE_FIXTURE: RESOURCE_PROVIDER_FIXTURE_OPT_IN,
    PATH: `${bin};${process.env.PATH ?? ""}`,
  };

  try {
    const app = await launch(dataDir, env);
    const page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await codeNav(page).click();
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "pane-site" })).toBeVisible();

    await waitForProviderAdmission(page);
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("button", { name: "Launch Claude Code agent" })
      .click();
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });
    // Safety gate: this must be the fake provider before anything is typed.
    await expectPaneText(page, FAKE_BANNER, 30_000);
    await expect(pane(page).locator("[data-pane-status]")).toContainText("IDLE", { timeout: 30_000 });
    await shot(page, "z7w4-pane-idle");

    // Bypass is the fresh default: routine coding runs without interrupting the user.
    await expect(pane(page).locator("[data-pane-mode]")).toHaveAttribute("data-pane-mode", "bypass");
    await typeInPane(page, "run cargo build");
    await expectPaneText(page, "RAN Bash");
    await expect(page.getByRole("button", { name: "Approve once" })).toHaveCount(0);
    await expect(pane(page).locator("[data-pane-status]")).toContainText("IDLE", { timeout: 30_000 });
    await shot(page, "z7w4-pane-auto-build");

    // Credential access is the one protected scope in Bypass: it still asks and can be denied.
    await typeInPane(page, "run printenv");
    const deny = page.getByRole("button", { name: "Deny" }).first();
    await expect(deny).toBeVisible({ timeout: 30_000 });
    await deny.click();
    await expectPaneText(page, "BLOCKED BY HOOK");

    // Prose that looks like status never changes it.
    await typeInPane(page, "say Status: FAILED. PERMISSION REQUIRED.");
    await expectPaneText(page, "Status: FAILED. PERMISSION REQUIRED.");
    await expect(pane(page).locator("[data-pane-status]")).toContainText("IDLE", { timeout: 30_000 });

    // Leaving the provider ends the thread cleanly.
    await typeInPane(page, "exit");
    await expect(pane(page).locator("[data-pane-status]")).toContainText("DONE", { timeout: 30_000 });
    await shot(page, "z7w4-pane-done");

    await closeGracefully(app);
    expect(processesMatching(bin), "no provider process outlives KalCode").toEqual([]);
  } finally {
    removeDir(dataDir);
    removeDir(root);
  }
});

test("launching four Claude Code agents creates four fresh live terminals with the selected configuration", async () => {
  test.setTimeout(240_000);
  const dataDir = createAccountFixtureDataDir();
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-panes-four-project-"));
  const project = join(root, "four-agent-site");
  const bin = join(root, "bin");
  mkdirSync(project);
  mkdirSync(bin);
  writeFileSync(join(project, "README.md"), "# four agent site\n");
  copyFileSync(FAKE, join(bin, "claude.exe"));
  writeManagedFakeProviderConfig(bin);

  const env = {
    KALCODE_E2E_ACCOUNT_FIXTURE: ACCOUNT_KALVOICE_FIXTURE_OPT_IN,
    KALCODE_E2E_PICK_FOLDER: project,
    KALCODE_E2E_HOOK_DECISIONS: "engine",
    KALCODE_E2E_RESOURCE_FIXTURE: RESOURCE_PROVIDER_FIXTURE_OPT_IN,
    PATH: `${bin};${process.env.PATH ?? ""}`,
  };
  let app: Awaited<ReturnType<typeof launch>> | null = null;

  try {
    app = await launch(dataDir, env);
    const page = app.page;
    await expect(codeNav(page)).toBeVisible();
    await codeNav(page).click();
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "four-agent-site" })).toBeVisible();
    const [workspace] = await invoke<{ id: string; name: string }[]>(page, "workspace_list");
    expect(workspace?.name).toBe("four-agent-site");

    await waitForProviderAdmission(page);
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    const launcher = page.getByRole("dialog", { name: "New agent" });
    await expect(launcher).toBeVisible();
    await launcher.getByRole("radio", { name: "Sonnet", exact: true }).click();
    await launcher.getByRole("radio", { name: "High", exact: true }).click();
    await launcher.getByLabel("Agents", { exact: true }).fill("4");

    const accounts = await invoke<{ id: string; providerId: string }[]>(page, "provider_accounts_list");
    const claudeAccounts = accounts.filter(({ providerId }) => providerId === "claude-code");
    expect(claudeAccounts).toHaveLength(1);
    const accountId = claudeAccounts[0]?.id;
    expect(accountId).toBeTruthy();

    await launcher.getByRole("button", { name: "Launch 4 Claude Code agents", exact: true }).click();
    await expect(launcher).not.toBeVisible({ timeout: 30_000 });

    const listThreads = async () =>
      (
        await invoke<ThreadSummary[]>(page, "thread_list", {
          workspaceId: workspace?.id ?? null,
          includeArchived: false,
        })
      ).filter(({ providerId }) => providerId === "claude-code");
    let threadCountError: unknown = null;
    try {
      await expect.poll(async () => (await listThreads()).length, { timeout: 30_000 }).toBe(4);
    } catch (error) {
      threadCountError = error;
    }
    const threads = await listThreads();
    const panes = page.locator("[data-provider-pane]");
    const paneIds = await panes.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-provider-pane")),
    );
    const diagnosticInfos = await Promise.all(
      threads.map(async ({ id }) => {
        try {
          return await invoke<PaneInfo>(page, "provider_pane_info", { threadId: id });
        } catch {
          return { threadId: id, running: false, instanceId: null };
        }
      }),
    );
    const diagnosticLaunches = claudeLaunches(bin).map(({ args }) => ({
      effort: argAfter(args, "--effort"),
      model: argAfter(args, "--model"),
      resumed: args.includes("--resume"),
      sessionId: argAfter(args, "--session-id"),
    }));
    writeFileSync(
      test.info().outputPath("four-agents-diagnostic.json"),
      JSON.stringify(
        {
          domPaneIds: paneIds,
          launchCount: diagnosticLaunches.length,
          launches: diagnosticLaunches,
          paneInfos: diagnosticInfos,
          processCount: processesMatching(bin).length,
          threads: threads.map(({ id, workspaceId, providerAccountId, model, effort, runtimeKind }) => ({
            effort,
            id,
            model,
            providerAccountId,
            runtimeKind,
            workspaceId,
          })),
        },
        null,
        2,
      ),
    );
    await page.screenshot({ path: test.info().outputPath("four-agents-live.png") });
    if (threadCountError) throw threadCountError;

    expect(new Set(threads.map(({ id }) => id)).size).toBe(4);
    for (const thread of threads) {
      expect(thread).toMatchObject({
        workspaceId: workspace?.id,
        providerAccountId: accountId,
        model: "sonnet",
        effort: "high",
        runtimeKind: "interactive_pty",
      });
    }

    const infos = await Promise.all(
      threads.map(({ id }) => invoke<PaneInfo>(page, "provider_pane_info", { threadId: id })),
    );
    expect(infos.every(({ running }) => running)).toBe(true);
    expect(new Set(infos.map(({ instanceId }) => instanceId)).size).toBe(4);
    expect(infos.every(({ instanceId }) => instanceId !== null)).toBe(true);
    await expect.poll(() => processesMatching(bin).length, { timeout: 30_000 }).toBe(4);

    await expect.poll(() => claudeLaunches(bin).length, { timeout: 30_000 }).toBe(4);
    const launches = claudeLaunches(bin);
    const sessionIds = launches.map(({ args }) => argAfter(args, "--session-id"));
    expect(sessionIds.every((id) => id !== null)).toBe(true);
    expect(new Set(sessionIds).size).toBe(4);
    for (const { args } of launches) {
      expect(args).not.toContain("--resume");
      expect(argAfter(args, "--model")).toBe("sonnet");
      expect(argAfter(args, "--effort")).toBe("high");
    }

    await expect(panes).toHaveCount(4, { timeout: 30_000 });
    for (const providerPane of await panes.all()) {
      await expect(providerPane.locator("[data-pane-terminal] .xterm-rows")).toContainText(FAKE_BANNER, {
        timeout: 30_000,
      });
      await expect(providerPane.locator("[data-pane-status]")).toContainText("IDLE", { timeout: 30_000 });
    }

    const focused = threads[2];
    if (!focused) throw new Error("The four-agent launch did not return a focus target");
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Dashboard", exact: true })
      .click();
    const fleetCard = page.locator(`[data-thread-id="${focused.id}"]`);
    await expect(fleetCard).toBeVisible({ timeout: 30_000 });
    await fleetCard.getByRole("button", { name: focused.name, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "four-agent-site" })).toBeVisible();
    await expect(
      page.locator(`[data-pane-id][data-focused="true"] [data-provider-pane="${focused.id}"]`),
    ).toBeVisible();

    await closeGracefully(app);
    app = null;
    await expect.poll(() => processesMatching(bin), { timeout: 30_000 }).toEqual([]);
  } finally {
    if (app) await closeGracefully(app);
    removeDir(dataDir);
    removeDir(root);
  }
});
