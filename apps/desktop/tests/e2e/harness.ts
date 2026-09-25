import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";

/**
 * Launching and closing the real KalCode binary for end-to-end tests (see app.spec.ts for the
 * original harness). The binary must be built with the `e2e` feature so it honours
 * KALCODE_DATA_DIR and the other test hooks; the harness refuses to drive one that doesn't.
 */
export const EXE =
  process.env.KALCODE_E2E_EXE ?? resolve(import.meta.dirname, "../../../../target/e2e/release/kalcode.exe");
export const PORT = Number(process.env.KALCODE_E2E_CDP_PORT ?? 9333);

export interface Running {
  child: ChildProcess;
  browser: Browser;
  page: Page;
}

export async function launch(dataDir: string, env: Record<string, string> = {}): Promise<Running> {
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      ...env,
      KALCODE_DATA_DIR: dataDir,
      WEBVIEW2_USER_DATA_FOLDER: join(dataDir, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  let browser: Browser | null = null;
  while (!browser) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const deadlineDb = Date.now() + 10_000;
  while (!existsSync(join(dataDir, "kalcode.db"))) {
    if (Date.now() > deadlineDb) {
      await browser.close();
      execFileSync("taskkill", ["/F", "/PID", String(child.pid)]);
      throw new Error(`${EXE} did not use the isolated data folder; build it with --features e2e`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error("No WebView2 browser context");
  let page = context.pages().find((p) => !p.url().startsWith("devtools"));
  while (!page) page = await context.waitForEvent("page");
  return { child, browser, page };
}

/** Graceful close: WM_CLOSE to the window, as when the user clicks the close button. */
export async function closeGracefully(app: Running) {
  await app.browser.close().catch(() => undefined);
  execFileSync("taskkill", ["/PID", String(app.child.pid)]);
  await waitForExit(app.child);
}

export function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once("exit", () => resolveExit()));
}

/** WebView2 helper processes release file locks shortly after the app exits. */
export function removeDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch {
    // Left for the next run's sweep.
  }
}

/** Process ids of running programs whose command line contains `needle` (Windows). */
export function processesMatching(needle: string): number[] {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle.replaceAll("'", "''")}*' -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $_.ProcessId }`;
  const out = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  return out
    .split(/\r?\n/)
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

/**
 * Finds a window titled `name` belonging to process `pid` with Windows UI Automation and closes
 * it (for a file dialog, the same as Cancel). Returns whether one was found.
 */
export function closeWindowNamed(pid: number, name: string): boolean {
  const script = [
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
    "$A = [System.Windows.Automation.AutomationElement]",
    "$S = [System.Windows.Automation.TreeScope]",
    `$byPid = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, ${pid})`,
    `$byName = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, '${name.replaceAll("'", "''")}')`,
    "$found = $null",
    "foreach ($top in $A::RootElement.FindAll($S::Children, $byPid)) {",
    "  if ($top.Current.Name -eq '" + name.replaceAll("'", "''") + "') { $found = $top; break }",
    "  $found = $top.FindFirst($S::Descendants, $byName); if ($found) { break }",
    "}",
    "if ($found) { $found.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close(); 'closed' } else { 'none' }",
  ].join("\n");
  const out = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  return out.trim().endsWith("closed");
}
