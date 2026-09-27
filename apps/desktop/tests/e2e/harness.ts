import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";

/**
 * Launching and closing the real KalCode binary for end-to-end tests (see app.spec.ts for the
 * original harness). The binary must be built with the `e2e` and `kalvoice-whisper` features so it
 * honours KALCODE_DATA_DIR and the other test hooks while exercising the production STT engine.
 */
export const EXE =
  process.env.KALCODE_E2E_EXE ?? resolve(import.meta.dirname, "../../../../target/e2e/release/kalcode.exe");
export const PORT = Number(process.env.KALCODE_E2E_CDP_PORT ?? 9333);
export const ACCOUNT_FIXTURE_OPT_IN = "onboarding-v1";
export const ACCOUNT_READY_FIXTURE_OPT_IN = "ready-v1";
export const ACCOUNT_KALVOICE_FIXTURE_OPT_IN = "kalvoice-under-limit-v1";
const ACCOUNT_FIXTURE_PREFIX = "kalcode-e2e-account-";
const ACCOUNT_FIXTURE_MARKER = ".kalcode-account-e2e-v1";
const ACCOUNT_FIXTURE_MARKER_CONTENT = "kalcode-account-e2e-v1\n";
const ACCOUNT_FIXTURE_INITIALIZED_MARKER = ".kalcode-account-e2e-initialized-v1";
const ACCOUNT_FIXTURE_INITIALIZED_CONTENT = "kalcode-account-e2e-initialized-v1\n";

export interface Running {
  child: ChildProcess;
  browser: Browser;
  page: Page;
}

/** Creates the fresh, explicitly marked directory the native account fixture requires. */
export function createAccountFixtureDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), ACCOUNT_FIXTURE_PREFIX));
  prepareAccountFixtureDataDir(dataDir);
  return dataDir;
}

/** Marks a freshly created native E2E directory before the application can create its store. */
export function prepareAccountFixtureDataDir(dataDir: string): void {
  for (const [filename, content] of [
    [ACCOUNT_FIXTURE_MARKER, ACCOUNT_FIXTURE_MARKER_CONTENT],
    [ACCOUNT_FIXTURE_INITIALIZED_MARKER, ACCOUNT_FIXTURE_INITIALIZED_CONTENT],
  ] as const) {
    const marker = join(dataDir, filename);
    if (existsSync(marker)) {
      if (readFileSync(marker, "utf8") !== content) {
        throw new Error(`Refusing account fixture directory with an invalid marker: ${dataDir}`);
      }
      continue;
    }
    writeFileSync(marker, content, { encoding: "utf8", flag: "wx" });
  }
}

/** Writes exact reviewed CLI versions for managed-account E2E providers sharing one fake bin. */
export function writeManagedFakeProviderConfig(binDir: string): void {
  writeFileSync(
    join(binDir, "fake-provider.json"),
    `${JSON.stringify({
      versions: {
        claude: "2.1.282 (Claude Code)",
        codex: "codex-cli 0.155.1",
        gemini: "0.61.0",
      },
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

function isolatedWebviewEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const name of Object.keys(childEnvironment)) {
    const upper = name.toUpperCase();
    if (upper.startsWith("WEBVIEW2_") || upper.startsWith("COREWEBVIEW2_") || upper.startsWith("WEBKIT_INSPECTOR")) {
      delete childEnvironment[name];
    }
  }
  return childEnvironment;
}

export async function launch(dataDir: string, env: Record<string, string> = {}): Promise<Running> {
  prepareAccountFixtureDataDir(dataDir);
  if (!Number.isInteger(PORT) || PORT < 1_024 || PORT > 65_535) {
    throw new Error(`KALCODE_E2E_CDP_PORT must be an integer from 1024 through 65535; received ${String(PORT)}`);
  }
  const child = spawn(EXE, [], {
    env: {
      ...isolatedWebviewEnvironment({ KALCODE_E2E_ACCOUNT_FIXTURE: ACCOUNT_READY_FIXTURE_OPT_IN, ...env }),
      KALCODE_DATA_DIR: dataDir,
      KALCODE_E2E_CDP_PORT: String(PORT),
    },
    stdio: "ignore",
  });
  let spawnError: Error | null = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  let browser: Browser | null = null;
  try {
    const deadline = Date.now() + 30_000;
    let connectionError: unknown = null;
    while (!browser) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
      } catch (error) {
        connectionError = error;
        if (spawnError) throw new Error(`${EXE} could not start`, { cause: spawnError });
        if (child.exitCode !== null) {
          throw new Error(`${EXE} exited with code ${String(child.exitCode)} before opening CDP port ${PORT}`, {
            cause: error,
          });
        }
        if (Date.now() > deadline) {
          throw new Error(`${EXE} did not open CDP port ${PORT} within 30 seconds`, { cause: connectionError });
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
    }

    const deadlineDb = Date.now() + 10_000;
    while (!existsSync(join(dataDir, "kalcode.db"))) {
      if (child.exitCode !== null) {
        throw new Error(`${EXE} exited with code ${String(child.exitCode)} before opening its isolated database`);
      }
      if (Date.now() > deadlineDb) {
        throw new Error(`${EXE} did not use the isolated data folder; build it with --features e2e`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error("No WebView2 browser context");
    let page = context.pages().find((candidate) => !candidate.url().startsWith("devtools"));
    while (!page) page = await context.waitForEvent("page");
    return { child, browser, page };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await stopOwnedProcess(child, true);
    throw error;
  }
}

interface ProviderAdmissionReport {
  status: { state: string };
  admission: {
    state: "allowed" | "held";
    additional: number;
    reasons: unknown[];
    snapshotSeq: number | null;
  };
  freshness: { state: string; detail: string };
}

/** Waits for a real, fresh governor sample that can admit provider work. */
export async function waitForProviderAdmission(page: Page, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: ProviderAdmissionReport | null = null;
  while (Date.now() <= deadline) {
    last = (await page.evaluate(() =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (command: string) => Promise<ProviderAdmissionReport> };
        }
      ).__TAURI_INTERNALS__.invoke("resource_report"),
    )) as ProviderAdmissionReport;
    if (last.admission.state === "allowed" && last.admission.additional > 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Provider admission was not allowed within ${timeoutMs}ms: ${JSON.stringify(last)}`);
}

/** Graceful close: WM_CLOSE to the window, as when the user clicks the close button. */
export async function closeGracefully(app: Running) {
  let requested = false;
  try {
    requested = closeWindowNamed(app.child.pid ?? -1, "KalCode");
  } catch {
    // The process may have closed between the CDP action and the UI Automation lookup.
  }
  if (!requested && app.child.pid !== undefined && app.child.exitCode === null) {
    try {
      execFileSync("taskkill", ["/PID", String(app.child.pid)], { windowsHide: true });
    } catch {
      // The bounded wait below distinguishes a concurrent exit from a process still running.
    }
  }
  const exited = await Promise.race([
    waitForExit(app.child).then(() => true),
    new Promise<false>((resolveExit) => setTimeout(() => resolveExit(false), 10_000)),
  ]);
  if (!exited && app.child.pid !== undefined) {
    execFileSync("taskkill", ["/F", "/PID", String(app.child.pid)], { windowsHide: true });
    await waitForExit(app.child);
  }
  await app.browser.close().catch(() => undefined);
}

/** Simulates a desktop crash while preserving its independent process-cleanup guardian. */
export async function killForcibly(app: Running): Promise<void> {
  await stopOwnedProcess(app.child, true);
  await app.browser.close().catch(() => undefined);
}

async function stopOwnedProcess(child: ChildProcess, force: boolean): Promise<void> {
  if (child.exitCode !== null) return;
  if (child.pid === undefined) throw new Error("The E2E process has no pid");
  try {
    execFileSync("taskkill", [...(force ? ["/F"] : []), "/PID", String(child.pid)], {
      windowsHide: true,
    });
  } catch (error) {
    if (child.exitCode === null) throw error;
  }
  const exited = await Promise.race([
    waitForExit(child).then(() => true),
    new Promise<false>((resolveExit) => setTimeout(() => resolveExit(false), 10_000)),
  ]);
  if (!exited) throw new Error(`E2E process ${child.pid} did not exit within 10 seconds`);
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
  const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
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
    `  if ($top.Current.Name -eq '${name.replaceAll("'", "''")}') { $found = $top; break }`,
    "  $found = $top.FindFirst($S::Descendants, $byName); if ($found) { break }",
    "}",
    "if ($found) { $found.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close(); 'closed' } else { 'none' }",
  ].join("\n");
  const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  return out.trim().endsWith("closed");
}
