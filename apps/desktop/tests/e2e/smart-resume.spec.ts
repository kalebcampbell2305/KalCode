import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PaneInfo, TerminalInfo, ThreadSummary, WorkspaceLayout } from "@kalcode/protocol";
import { expect, type Page } from "@playwright/test";
import {
  ACCOUNT_KALVOICE_FIXTURE_OPT_IN,
  closeGracefully,
  createAccountFixtureDataDir,
  EXE,
  launch,
  PORT,
  processesMatching,
  RESOURCE_PROVIDER_FIXTURE_OPT_IN,
  type Running,
  removeDir,
  test,
  waitForProviderAdmission,
  writeManagedFakeProviderConfig,
} from "./harness.ts";

/**
 * Real native restart proof for Smart Resume. The application, SQLite layout/session stores,
 * PTYs, hook bridge and Browser child are real. The provider is the managed fake copied to an
 * isolated PATH; no provider account, credential or inference service is used.
 */
test.skip(process.platform !== "win32", "The native restart harness drives Windows WebView2.");
test.skip(!existsSync(EXE), `Build the native E2E app first: ${EXE}`);

const FAKE = join(dirname(EXE), "kalcode-fake-provider.exe");
const HELPER = join(dirname(EXE), "kalcode-hook.exe");
test.skip(!existsSync(FAKE) || !existsSync(HELPER), "Build the native hook and fake provider helpers first.");

const FAKE_BANNER = "KalCode fake provider (interactive)";

type RestartThread = ThreadSummary & { restartRecoverable?: boolean };

interface FakeLaunch {
  exe: string;
  args: string[];
}

interface BrowserState {
  browserId: string;
  workspaceId: string;
  url: string;
  title: string | null;
  loading: boolean;
}

interface AccountSnapshot {
  account: { id: string } | null;
}

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

function claudeLaunches(bin: string): FakeLaunch[] {
  const path = join(bin, "runs.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeLaunch)
    .filter(({ exe, args }) => exe.toLowerCase() === "claude.exe" && args.includes("--settings"));
}

function argAfter(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

async function closeServer(server: Server) {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function browserFixture(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end("<!doctype html><html><head><title>Desk reference</title></head><body>saved desk</body></html>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The Browser fixture did not bind TCP.");
  return { server, url: `http://127.0.0.1:${address.port}/desk` };
}

async function browserState(page: Page, browserId: string): Promise<BrowserState | null> {
  return page.evaluate(async (id) => {
    const nativeInvoke = (
      window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> } }
    ).__TAURI_INTERNALS__.invoke;
    const pageLease = (await nativeInvoke("browser_page_lease", {})) as number;
    try {
      return (await nativeInvoke("browser_info", { browserId: id, pageLease })) as BrowserState;
    } catch (error) {
      if (typeof error !== "object" || error === null) throw error;
      const payload = error as { code?: unknown };
      if (payload.code === "browser_not_found" || payload.code === "browser_starting") return null;
      throw error;
    }
  }, browserId);
}

const codeNav = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true });

const visiblePanes = (page: Page) => page.locator("[data-pane-id]:not([hidden])");

async function paneIds(page: Page): Promise<string[]> {
  return visiblePanes(page).evaluateAll((elements) =>
    elements.flatMap((element) => {
      const id = element.getAttribute("data-pane-id");
      return id ? [id] : [];
    }),
  );
}

async function focusedPaneId(page: Page): Promise<string | null> {
  return page.locator('[data-pane-id][data-focused="true"]').first().getAttribute("data-pane-id");
}

async function listThreads(page: Page, workspaceId: string): Promise<RestartThread[]> {
  return invoke<RestartThread[]>(page, "thread_list", { workspaceId, includeArchived: false });
}

async function startClaude(page: Page) {
  await waitForProviderAdmission(page);
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  const launcher = page.getByRole("dialog", { name: "New agent" });
  await expect(launcher).toBeVisible();
  await launcher.getByRole("button", { name: "Launch Claude Code agent", exact: true }).click();
  await expect(launcher).not.toBeVisible({ timeout: 30_000 });
}

test("Continue where I left off restores one recoverable desk without reviving ended work", async () => {
  test.setTimeout(300_000);
  const dataDir = createAccountFixtureDataDir();
  const root = mkdtempSync(join(tmpdir(), "kalcode-smart-resume-"));
  const project = join(root, "saved-desk");
  const bin = join(root, "bin");
  mkdirSync(project);
  mkdirSync(bin);
  writeFileSync(join(project, "README.md"), "# Smart Resume native proof\n");
  copyFileSync(FAKE, join(bin, "claude.exe"));
  writeManagedFakeProviderConfig(bin);
  const web = await browserFixture();
  const env = {
    KALCODE_E2E_ACCOUNT_FIXTURE: ACCOUNT_KALVOICE_FIXTURE_OPT_IN,
    KALCODE_E2E_BROWSER_CDP_BASE: String(PORT + 100),
    KALCODE_E2E_HOOK_DECISIONS: "engine",
    KALCODE_E2E_PICK_FOLDER: project,
    KALCODE_E2E_RESOURCE_FIXTURE: RESOURCE_PROVIDER_FIXTURE_OPT_IN,
    PATH: `${bin};${process.env.PATH ?? ""}`,
  };
  let app: Running | null = null;

  try {
    app = await launch(dataDir, env);
    let page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await codeNav(page).click();
    await page.getByRole("button", { name: /Open folder/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "saved-desk" })).toBeVisible();

    const workspaces = await invoke<{ id: string; name: string }[]>(page, "workspace_list");
    const workspace = workspaces.find(({ name }) => name === "saved-desk");
    if (!workspace) throw new Error("The isolated workspace did not open.");
    const account = (await invoke<AccountSnapshot>(page, "account_status")).account;
    if (!account) throw new Error("The isolated KalCode account fixture did not become ready.");
    const restorePreferenceKey = `kalcode:desk-restore:v1:${account.id}`;
    await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [
      restorePreferenceKey,
      "manual",
    ] as const);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), restorePreferenceKey)).toBe("manual");

    // The saved-open agent is the only process that is allowed to recover after relaunch.
    await startClaude(page);
    const recoverablePane = page.locator("[data-provider-pane]").first();
    await expect(recoverablePane.locator("[data-pane-terminal] .xterm-rows")).toContainText(FAKE_BANNER, {
      timeout: 30_000,
    });
    const recoverableId = await recoverablePane.getAttribute("data-provider-pane");
    if (!recoverableId) throw new Error("The recoverable agent did not receive a thread id.");
    await expect
      .poll(async () => (await invoke<RestartThread>(page, "thread_get", { threadId: recoverableId })).resumable, {
        timeout: 30_000,
      })
      .toBe(true);
    await invoke(page, "thread_rename", { threadId: recoverableId, name: "Restore release review" });
    const firstInstance = await invoke<PaneInfo>(page, "provider_pane_info", { threadId: recoverableId });
    expect(firstInstance.running).toBe(true);
    expect(firstInstance.instanceId).toBeTruthy();
    await expect.poll(() => claudeLaunches(bin).length, { timeout: 30_000 }).toBe(1);
    const originalSessionId = argAfter(claudeLaunches(bin)[0]?.args ?? [], "--session-id");
    expect(originalSessionId).toBeTruthy();

    // A user-stopped agent is closed from the saved layout and remains historical.
    await page.keyboard.press("Control+Alt+d");
    await expect(visiblePanes(page)).toHaveCount(2);
    await startClaude(page);
    await expect(page.locator("[data-provider-pane]")).toHaveCount(2, { timeout: 30_000 });
    const stoppedPane = page.locator("[data-provider-pane]").nth(1);
    await expect(stoppedPane.locator("[data-pane-terminal] .xterm-rows")).toContainText(FAKE_BANNER, {
      timeout: 30_000,
    });
    const stoppedId = await stoppedPane.getAttribute("data-provider-pane");
    if (!stoppedId) throw new Error("The stopped agent did not receive a thread id.");
    await invoke(page, "thread_rename", { threadId: stoppedId, name: "Intentionally closed migration" });
    await invoke<RestartThread>(page, "thread_stop", { threadId: stoppedId });
    const stopped = await invoke<RestartThread>(page, "thread_get", { threadId: stoppedId });
    expect(stopped).toMatchObject({
      currentActivity: "Stopped by you",
      restartRecoverable: false,
      status: "interrupted",
    });
    await expect
      .poll(async () => (await invoke<PaneInfo>(page, "provider_pane_info", { threadId: stoppedId })).running, {
        timeout: 30_000,
      })
      .toBe(false);
    const stoppedFrame = stoppedPane.locator("xpath=ancestor::*[@data-pane-id]").first();
    await stoppedFrame.getByRole("button", { name: /^Close pane \d+$/ }).click();
    await expect(visiblePanes(page)).toHaveCount(1);

    // A completed local build stays ended; Smart Resume must never replay its shell command.
    const terminalIdsBefore = new Set(
      (await invoke<TerminalInfo[]>(page, "terminal_list", { workspaceId: workspace.id })).map(({ id }) => id),
    );
    await page.keyboard.press("Control+Alt+d");
    await expect(visiblePanes(page)).toHaveCount(2);
    await visiblePanes(page)
      .nth(1)
      .getByRole("button", { name: /^New .+ terminal$/ })
      .click();
    let buildTerminal: TerminalInfo | undefined;
    await expect
      .poll(async () => {
        const terminals = await invoke<TerminalInfo[]>(page, "terminal_list", { workspaceId: workspace.id });
        buildTerminal = terminals.find(({ id }) => !terminalIdsBefore.has(id));
        return buildTerminal?.status ?? null;
      })
      .toBe("running");
    if (!buildTerminal) throw new Error("The finished build terminal did not start.");
    await invoke(page, "terminal_rename", { terminalId: buildTerminal.id, title: "Release build finished" });
    await invoke(page, "terminal_write", {
      terminalId: buildTerminal.id,
      data: "Write-Output smart-resume-build-finished; exit\r",
      expectedGeneration: null,
    });
    await expect
      .poll(
        async () =>
          (await invoke<TerminalInfo[]>(page, "terminal_list", { workspaceId: workspace.id })).find(
            ({ id }) => id === buildTerminal?.id,
          ),
        { timeout: 30_000 },
      )
      .toMatchObject({ exitCode: 0, status: "exited", title: "Release build finished" });

    // Browser identity and URL are layout metadata, restored independently from heavy hydration.
    await page.keyboard.press("Control+Alt+d");
    await expect(visiblePanes(page)).toHaveCount(3);
    await visiblePanes(page).nth(2).getByRole("button", { name: "Open Browser", exact: true }).click();
    const browser = page.locator("[data-browser-id]").first();
    await expect(browser).toBeVisible({ timeout: 30_000 });
    const browserId = await browser.getAttribute("data-browser-id");
    if (!browserId) throw new Error("The Browser pane did not receive a stable id.");
    await browser.getByLabel("Web address").fill(web.url);
    await browser.getByLabel("Web address").press("Enter");
    await expect.poll(async () => (await browserState(page, browserId))?.title ?? null).toBe("Desk reference");
    await browser.getByLabel("Web address").click();

    await expect
      .poll(async () =>
        JSON.stringify((await invoke<WorkspaceLayout>(page, "layout_get", { workspaceId: workspace.id })).layout),
      )
      .toContain(web.url);

    const savedPaneIds = await paneIds(page);
    const savedFocus = await focusedPaneId(page);
    if (!savedFocus) throw new Error("The focused Browser pane did not persist a stable pane id.");
    const focusStorageKey = `kalcode:canvas-focus:${workspace.id}`;
    const savedLayout = (await invoke<WorkspaceLayout>(page, "layout_get", { workspaceId: workspace.id })).layout;
    const savedLayoutJson = JSON.stringify(savedLayout);
    expect(savedPaneIds).toHaveLength(3);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), focusStorageKey)).toBe(savedFocus);
    expect(savedLayoutJson).toContain(recoverableId);
    expect(savedLayoutJson).toContain(buildTerminal.id);
    expect(savedLayoutJson).toContain(browserId);
    expect(savedLayoutJson).toContain(web.url);
    expect(savedLayoutJson).not.toContain(stoppedId);
    expect((await invoke<RestartThread>(page, "thread_get", { threadId: recoverableId })).name).toBe(
      "Restore release review",
    );
    expect((await invoke<RestartThread>(page, "thread_get", { threadId: stoppedId })).name).toBe(
      "Intentionally closed migration",
    );
    await page.waitForTimeout(1_500); // layout persistence is intentionally debounced
    await closeGracefully(app);
    app = null;
    await expect.poll(() => processesMatching(bin), { timeout: 30_000 }).toEqual([]);

    // Relaunch paints the saved shell first. Manual mode must not start a provider on its own.
    app = await launch(dataDir, env);
    page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "saved-desk" })).toBeVisible();
    await expect(visiblePanes(page)).toHaveCount(3);
    expect(await paneIds(page)).toEqual(savedPaneIds);
    await expect(page.locator(`[data-pane-id="${savedFocus}"]`)).toHaveAttribute("data-focused", "true");
    expect(await page.evaluate((key) => window.localStorage.getItem(key), focusStorageKey)).toBe(savedFocus);
    expect((await invoke<WorkspaceLayout>(page, "layout_get", { workspaceId: workspace.id })).layout).toEqual(
      savedLayout,
    );
    expect(await page.evaluate((key) => window.localStorage.getItem(key), restorePreferenceKey)).toBe("manual");
    expect(claudeLaunches(bin)).toHaveLength(2);
    expect(processesMatching(bin)).toEqual([]);

    const restoredBrowser = page.locator(`[data-browser-id="${browserId}"]`);
    await expect(restoredBrowser).toBeVisible();
    await expect(restoredBrowser.getByLabel("Web address")).toHaveValue(web.url);
    await expect.poll(async () => (await browserState(page, browserId))?.url ?? null).toBe(web.url);
    const restoredTerminal = (await invoke<TerminalInfo[]>(page, "terminal_list", { workspaceId: workspace.id })).find(
      ({ id }) => id === buildTerminal?.id,
    );
    expect(restoredTerminal).toMatchObject({
      exitCode: 0,
      status: "exited",
      title: "Release build finished",
    });

    const afterRestart = await listThreads(page, workspace.id);
    expect(afterRestart.find(({ id }) => id === stoppedId)).toMatchObject({
      currentActivity: "Stopped by you",
      name: "Intentionally closed migration",
      restartRecoverable: false,
      status: "interrupted",
    });
    expect(afterRestart.find(({ id }) => id === recoverableId)).toMatchObject({
      currentActivity: expect.stringMatching(/^KalCode closed(?: while this thread was running)?$/),
      name: "Restore release review",
      restartRecoverable: true,
      resumable: true,
      runtimeKind: "interactive_pty",
      status: "interrupted",
    });

    // One click resumes the provider-native session once. A runtime handle is never reused.
    const recovery = page.getByRole("region", { name: "Desk recovery" });
    await expect(recovery.getByText("1 saved agent can resume.", { exact: true })).toBeVisible();
    await recovery.getByRole("button", { name: "Continue where I left off", exact: true }).click();
    await expect.poll(() => claudeLaunches(bin).length, { timeout: 30_000 }).toBe(3);
    await expect.poll(() => processesMatching(bin).length, { timeout: 30_000 }).toBe(1);
    const resumedLaunch = claudeLaunches(bin)[2];
    expect(argAfter(resumedLaunch?.args ?? [], "--resume")).toBe(originalSessionId);
    expect(resumedLaunch?.args).not.toContain("--session-id");
    await expect
      .poll(async () => (await invoke<PaneInfo>(page, "provider_pane_info", { threadId: recoverableId })).running, {
        timeout: 30_000,
      })
      .toBe(true);
    const resumedInstance = await invoke<PaneInfo>(page, "provider_pane_info", { threadId: recoverableId });
    expect(resumedInstance.instanceId).toBeTruthy();
    expect(resumedInstance.instanceId).not.toBe(firstInstance.instanceId);
    expect((await invoke<RestartThread>(page, "thread_get", { threadId: recoverableId })).name).toBe(
      "Restore release review",
    );
    await page.waitForTimeout(1_000);
    expect(claudeLaunches(bin)).toHaveLength(3);
    await page.screenshot({ path: test.info().outputPath("smart-resume-restored-desk.png") });

    // New agent always creates a new thread and a fresh provider session.
    const knownThreadIds = new Set((await listThreads(page, workspace.id)).map(({ id }) => id));
    await startClaude(page);
    let fresh: RestartThread | undefined;
    await expect
      .poll(async () => {
        fresh = (await listThreads(page, workspace.id)).find(({ id }) => !knownThreadIds.has(id));
        return fresh?.runtimeKind ?? null;
      })
      .toBe("interactive_pty");
    if (!fresh) throw new Error("New agent did not create a unique live coding session.");
    expect(fresh.id).not.toBe(recoverableId);
    await expect.poll(() => claudeLaunches(bin).length, { timeout: 30_000 }).toBe(4);
    const freshLaunch = claudeLaunches(bin)[3];
    expect(freshLaunch?.args).not.toContain("--resume");
    const freshSessionId = argAfter(freshLaunch?.args ?? [], "--session-id");
    expect(freshSessionId).toBeTruthy();
    expect(freshSessionId).not.toBe(originalSessionId);
    await expect.poll(() => processesMatching(bin).length, { timeout: 30_000 }).toBe(2);

    await closeGracefully(app);
    app = null;
    await expect.poll(() => processesMatching(bin), { timeout: 30_000 }).toEqual([]);
  } finally {
    if (app) await closeGracefully(app).catch(() => undefined);
    await closeServer(web.server);
    removeDir(dataDir);
    removeDir(root);
  }
});
