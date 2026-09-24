import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { closeGracefully, EXE, launch, processesMatching, removeDir } from "./harness.ts";

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

    // Command Prompt: working directory is the workspace folder; large output streams intact.
    await newTerminal(page, "Command Prompt");
    await expect(visibleTerminal(page)).toContainText("Microsoft Windows", { timeout: 30_000 });
    await typeInTerminal(page, "echo cwd=[%CD%]");
    await expect(visibleTerminal(page)).toContainText(`cwd=[${canonical}]`, { timeout: 20_000 });
    await typeInTerminal(page, "type big.txt");
    await expect(visibleTerminal(page)).toContainText("kalcode-big-end", { timeout: 30_000 });

    // Closing a tab ends programs started in it (the whole console, not just the shell).
    await newTerminal(page, "Command Prompt");
    await expect(visibleTerminal(page)).toContainText("Microsoft Windows", { timeout: 30_000 });
    await typeInTerminal(page, "ping -n 117 127.0.0.1");
    await expect.poll(() => processesMatching("-n 117 127.0.0.1").length, { timeout: 20_000 }).toBeGreaterThan(0);
    await page.keyboard.press("Control+Shift+W");
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect.poll(() => processesMatching("-n 117 127.0.0.1").length, { timeout: 20_000 }).toBe(0);

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

    await closeGracefully(app);
  } finally {
    removeDir(dataDir);
    removeDir(projectRoot);
  }
});
