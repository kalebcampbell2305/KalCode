import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import {
  closeGracefully,
  closeWindowNamed,
  EXE,
  inServiceSession,
  launch,
  processesMatching,
  removeDir,
  SERVICE_SESSION_SKIP,
  test,
} from "./harness.ts";

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

test("image attachment stores real pixels and pastes into its isolated native terminal", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-images-"));
  const project = mkdtempSync(join(tmpdir(), "kalcode-e2e-image-project-"));
  const app = await launch(dataDir, { KALCODE_E2E_PICK_FOLDER: project });
  try {
    const page = app.page;
    await codeNav(page).click();
    await page.getByRole("button", { name: "Open folder…", exact: true }).click();
    await page.getByRole("button", { name: /^New .+ terminal$/ }).click();
    await expect(visibleTerminal(page)).toContainText(basename(project));
    const before = await visibleTerminal(page).innerText();
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 4;
      canvas.height = 4;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No canvas");
      context.fillStyle = "#408cff";
      context.fillRect(0, 0, 4, 4);
      return canvas.toDataURL("image/png").split(",")[1] ?? "";
    });
    await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({
      name: "private-picture.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
    await expect(visibleTerminal(page)).toContainText("terminal-images", { timeout: 20_000 });
    const directories = readdirSync(join(dataDir, "terminal-images", "terminals"));
    expect(directories).toHaveLength(1);
    const storedDir = join(dataDir, "terminal-images", "terminals", directories[0] ?? "");
    const images = readdirSync(storedDir);
    expect(images).toHaveLength(1);
    const stored = readFileSync(join(storedDir, images[0] ?? ""));
    expect([...stored.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(stored.readUInt32BE(16)).toBe(4);
    expect(stored.readUInt32BE(20)).toBe(4);
    expect((await visibleTerminal(page).innerText()).split("PS ").length).toBe(before.split("PS ").length);
    await page.keyboard.press("Control+c");
    // Compute the marker in PowerShell so command echo and line wrapping cannot satisfy the proof.
    await typeInTerminal(page, "Write-Output ('image-' + 'terminal-alive')");
    await expect(visibleTerminal(page)).toContainText("image-terminal-alive");
    await typeInTerminal(page, "exit");
    await page.locator('[role="tabpanel"]:not([hidden])').getByRole("button", { name: "Restart", exact: true }).click();
    await expect(visibleTerminal(page)).toContainText(basename(project));
    await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({
      name: "after-restart.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
    await expect.poll(() => readdirSync(storedDir).length).toBe(2);
    await expect(visibleTerminal(page)).toContainText("terminal-images");
    await page.screenshot({ path: test.info().outputPath("native-code-image.png") });
    await page.getByRole("button", { name: "Actions for pane 1" }).click();
    await page.getByRole("menuitem", { name: "End terminal", exact: true }).click();
    // Smart Close (#222) asks before stopping a running shell; ending it removes its images.
    await page
      .getByRole("alertdialog", { name: "Close active work?" })
      .getByRole("button", { name: "Stop and Close", exact: true })
      .click();
    await expect.poll(() => existsSync(storedDir)).toBe(false);
  } finally {
    await closeGracefully(app);
    removeDir(dataDir);
    removeDir(project);
  }
});

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
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();

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
    // Fit, then the debounced resize reaches ConPTY: poll for it rather than sleeping a fixed time,
    // which lost the race on a loaded gate machine (gate 37413248990).
    await expect.poll(columns, { timeout: 20_000 }).toBeGreaterThan(narrow);
    await page.getByRole("button", { name: "Expand sidebar" }).click();

    // Reloading the page drops its attachments natively; the new page re-attaches and the
    // scrollback replays. The shells keep running.
    await typeInTerminal(page, "echo before-reload-%OS%");
    await expect(visibleTerminal(page)).toContainText("before-reload-Windows_NT");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "z1-site" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Command Prompt/ })).toHaveAttribute("aria-selected", "true");
    await expect(visibleTerminal(page)).toContainText("before-reload-Windows_NT", { timeout: 20_000 });
    await typeInTerminal(page, "echo after-reload-%OS%");
    await expect(visibleTerminal(page)).toContainText("after-reload-Windows_NT", { timeout: 20_000 });

    // Closing a terminal ends it (owner decision): the whole console, including programs started in
    // it, not just the shell, and nothing keeps running in the background.
    await newTerminal(page, "Command Prompt");
    await expect(visibleTerminal(page)).toContainText("Microsoft Windows", { timeout: 30_000 });
    await typeInTerminal(page, "ping -n 117 127.0.0.1");
    await expect.poll(() => processesMatching("-n 117 127.0.0.1").length, { timeout: 20_000 }).toBeGreaterThan(0);
    await page.keyboard.press("Control+Shift+W");
    // Smart Close (#222) asks before closing a terminal with a running program; stop it.
    await page
      .getByRole("alertdialog", { name: "Close active work?" })
      .getByRole("button", { name: "Stop and Close", exact: true })
      .click();
    await expect(page.getByRole("tab")).toHaveCount(2); // the closed terminal is forgotten
    await expect.poll(() => processesMatching("-n 117 127.0.0.1").length, { timeout: 20_000 }).toBe(0);
    await expect(page.getByRole("button", { name: /in background/ })).toHaveCount(0);

    // The Dashboard lists the running terminals of this workspace.
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    const terminals = page.getByRole("region", { name: "Terminals" });
    await expect(terminals.getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Terminal started").first()).toBeVisible();

    // Quit KalCode: shells end with it.
    await codeNav(page).click();
    await closeGracefully(app);

    // Relaunch opens the active workspace directly in Code and restores its tabs as ended, with
    // Restart available.
    app = await launch(dataDir, env);
    await expect(app.page.getByRole("heading", { level: 1, name: "z1-site" })).toBeVisible();
    await app.page.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(
      app.page.getByRole("region", { name: "Terminals" }).getByText("No terminals are running."),
    ).toBeVisible();
    await codeNav(app.page).click();
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
  // Finds and closes the real system dialog through UI Automation, which session 0 lacks.
  test.skip(inServiceSession(), SERVICE_SESSION_SKIP);
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  try {
    // No KALCODE_E2E_PICK_FOLDER: the real system dialog is shown.
    const app = await launch(dataDir);
    await expect(app.page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
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
