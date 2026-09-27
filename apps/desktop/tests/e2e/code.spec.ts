import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { closeGracefully, closeWindowNamed, EXE, launch, processesMatching, removeDir, test } from "./harness.ts";

/**
 * Z1 end to end against the real app: open a real folder, run real shells in real
 * pseudo-terminals, close and relaunch KalCode, restore and restart the tabs.
 * Build first: pnpm --filter @kalcode/desktop build:e2e (with KALCODE_E2E_CDP_PORT set per worktree).
 */
test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

const visibleTerminal = (page: Page) => page.locator('[role="tabpanel"]:not([hidden]) .xterm-rows');
const codeNav = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true });

async function typeInTerminal(page: Page, command: string) {
  await page.locator('[role="tabpanel"]:not([hidden]) .xterm-screen').click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

/** Real-app screenshots for visual review (apps/desktop/qa/screenshots, git-ignored). */
async function shot(page: Page, name: string) {
  const dir = fileURLToPath(new URL("../../qa/screenshots/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

async function newTerminal(page: Page, shell: string) {
  await page.getByRole("button", { name: "Choose a shell" }).click();
  await page.getByRole("menuitem", { name: new RegExp(shell) }).click();
  await expect(page.getByRole("tab", { name: new RegExp(shell) }).last()).toHaveAttribute("aria-selected", "true");
}

test("open a folder, run commands in real shells, restart KalCode, restore and restart the tabs", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "kalcode-e2e-project-"));
  const project = join(projectRoot, "z1-site");
  mkdirSync(project);
  // A large file: typing it streams well over Tauri's direct-delivery size through the channel.
  const lines = Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
  writeFileSync(join(project, "big.txt"), `${lines.join("\r\n")}\r\nkalcode-big-end\r\n`);
  const canonical = realpathSync.native(project);
  const env = { KALCODE_E2E_PICK_FOLDER: project };

  try {
    let app = await launch(dataDir, env);
    const page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

    // Open the folder through the (test-hooked) native picker.
    await codeNav(page).click();
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "z1-site" })).toBeVisible();

    // A terminal in the default shell: type a command and see its output.
    await page.getByRole("button", { name: /^New .+ terminal$/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(visibleTerminal(page)).toContainText(basename(project), { timeout: 30_000 });
    await typeInTerminal(page, "echo kalcode-z1-ok");
    await expect
      .poll(async () => ((await visibleTerminal(page).textContent()) ?? "").split("kalcode-z1-ok").length - 1, {
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(2); // the typed command and its output

    // ANSI colour from a real shell (Windows' default shells are PowerShell) renders as colour.
    await typeInTerminal(page, "Write-Host kalcode-red -ForegroundColor Red");
    const red = visibleTerminal(page)
      .locator("span")
      .filter({ hasText: /^kalcode-red$/ });
    await expect(red.first()).toHaveClass(/xterm-fg-(1|9)\b/, { timeout: 20_000 });
    await shot(page, "e2e-real-powershell");

    // Command Prompt: working directory is the workspace folder; large output streams intact.
    await newTerminal(page, "Command Prompt");
    await expect(visibleTerminal(page)).toContainText("Microsoft Windows", { timeout: 30_000 });
    await typeInTerminal(page, "echo cwd=[%CD%]");
    await expect(visibleTerminal(page)).toContainText(`cwd=[${canonical}]`, { timeout: 20_000 });
    await typeInTerminal(page, "type big.txt");
    await expect(visibleTerminal(page)).toContainText("kalcode-big-end", { timeout: 30_000 });

    // Resizing the view resizes the pseudo-terminal: collapsing the sidebar widens the shell.
    const columns = async () => {
      await typeInTerminal(page, "cls");
      await typeInTerminal(page, "mode con");
      let found = 0;
      await expect
        .poll(
          async () => {
            const match = /Columns:\s+(\d+)/.exec((await visibleTerminal(page).textContent()) ?? "");
            found = Number(match?.[1] ?? 0);
            return found;
          },
          { timeout: 20_000 },
        )
        .toBeGreaterThan(0);
      return found;
    };
    const narrow = await columns();
    await page.keyboard.press("Control+Shift+E"); // leave the terminal so Ctrl+B reaches KalCode
    await page.keyboard.press("Control+B");
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await page.waitForTimeout(500); // fit, then the debounced resize reaches ConPTY
    expect(await columns()).toBeGreaterThan(narrow);
    await page.getByRole("button", { name: "Expand sidebar" }).click();

    // Reloading the page drops its attachments natively; the new page re-attaches and the
    // scrollback replays. The shells keep running.
    await typeInTerminal(page, "echo before-reload-%OS%");
    await expect(visibleTerminal(page)).toContainText("before-reload-Windows_NT");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await codeNav(page).click();
    await expect(page.getByRole("tab", { name: /Command Prompt/ })).toHaveAttribute("aria-selected", "true");
    await expect(visibleTerminal(page)).toContainText("before-reload-Windows_NT", { timeout: 20_000 });
    await typeInTerminal(page, "echo after-reload-%OS%");
    await expect(visibleTerminal(page)).toContainText("after-reload-Windows_NT", { timeout: 20_000 });

    // Closing a tab only hides it (Z7-14); ending a terminal ends programs started in it (the
    // whole console, not just the shell).
    await newTerminal(page, "Command Prompt");
    await expect(visibleTerminal(page)).toContainText("Microsoft Windows", { timeout: 30_000 });
    await typeInTerminal(page, "ping -n 117 127.0.0.1");
    await expect.poll(() => processesMatching("-n 117 127.0.0.1").length, { timeout: 20_000 }).toBeGreaterThan(0);
    await page.keyboard.press("Control+Shift+W");
    await expect(page.getByRole("tab")).toHaveCount(2);
    await page.waitForTimeout(1000);
    expect(processesMatching("-n 117 127.0.0.1").length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "1 in background" }).click();
    await page.getByRole("menuitem", { name: /^Show Command Prompt/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(3);
    await page.getByRole("button", { name: "Actions for pane 1" }).click();
    await page.getByRole("menuitem", { name: "End terminal" }).click();
    await expect.poll(() => processesMatching("-n 117 127.0.0.1").length, { timeout: 20_000 }).toBe(0);
    await expect(page.getByRole("tab")).toHaveCount(2); // an ended terminal is forgotten

    // The Dashboard lists the running terminals of this workspace.
    await page.getByRole("button", { name: "Dashboard" }).click();
    const terminals = page.getByRole("region", { name: "Terminals" });
    await expect(terminals.getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Terminal started").first()).toBeVisible();

    // Quit KalCode: shells end with it.
    await codeNav(page).click();
    await closeGracefully(app);

    // Relaunch: the workspace is active and its tabs come back as ended, with Restart.
    app = await launch(dataDir, env);
    await expect(app.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(
      app.page.getByRole("region", { name: "Terminals" }).getByText("No terminals are running."),
    ).toBeVisible();
    await codeNav(app.page).click();
    await expect(app.page.getByRole("heading", { level: 1, name: "z1-site" })).toBeVisible();
    await expect(app.page.getByRole("tab")).toHaveCount(2);
    await expect(app.page.getByRole("tab", { name: /Ended/ })).toHaveCount(2);
    await expect(app.page.getByRole("heading", { name: "This terminal ended when KalCode closed" })).toBeVisible();
    await shot(app.page, "e2e-real-restored");
    await app.page.locator('[role="tabpanel"]:not([hidden])').getByRole("button", { name: "Restart" }).click();
    await expect(app.page.getByRole("tab", { name: /Ended/ })).toHaveCount(1);
    await expect(visibleTerminal(app.page)).toContainText(basename(project), { timeout: 30_000 });
    await typeInTerminal(app.page, "echo kalcode-z1-restarted");
    await expect
      .poll(
        async () => ((await visibleTerminal(app.page).textContent()) ?? "").split("kalcode-z1-restarted").length - 1,
        { timeout: 20_000 },
      )
      .toBeGreaterThanOrEqual(2);
    await shot(app.page, "e2e-real-restarted");

    await closeGracefully(app);
  } finally {
    removeDir(dataDir);
    removeDir(projectRoot);
  }
});

test("the native folder picker opens from Rust; cancelling it changes nothing", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  try {
    // No KALCODE_E2E_PICK_FOLDER: the real system dialog is shown.
    const app = await launch(dataDir);
    await expect(app.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await codeNav(app.page).click();
    const open = app.page.getByRole("button", { name: "Open folder…" });
    await open.click();
    await expect(open).toHaveAttribute("aria-busy", "true"); // waiting on the dialog
    const pid = app.child.pid ?? 0;
    await expect.poll(() => closeWindowNamed(pid, "Open a project folder"), { timeout: 20_000 }).toBe(true);
    await expect(open).not.toHaveAttribute("aria-busy", "true");
    await expect(app.page.getByRole("heading", { name: "Open a project folder" })).toBeVisible();
    await expect(app.page.getByRole("heading", { name: "Recent workspaces" })).toHaveCount(0);
    await closeGracefully(app);
  } finally {
    removeDir(dataDir);
  }
});
