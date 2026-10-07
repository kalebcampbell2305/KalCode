import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { type Browser, chromium, type Page, test as playwrightTest, type TestInfo } from "@playwright/test";
import { type LaunchReadinessTimer, waitForLaunchConnection, waitForLaunchReadiness } from "./launchReadiness.ts";

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
/** A signed MAX account: features placed on MAX, such as agent handoff. */
export const ACCOUNT_MAX_FIXTURE_OPT_IN = "max-v1";
/** A signed OWNER account: features narrowed to OWNER, such as KalCode Remote for now. */
export const ACCOUNT_OWNER_FIXTURE_OPT_IN = "owner-v1";
export const RESOURCE_PROVIDER_FIXTURE_OPT_IN = "provider-capacity-v1";
const ACCOUNT_FIXTURE_PREFIX = "kalcode-e2e-account-";
const ACCOUNT_FIXTURE_MARKER = ".kalcode-account-e2e-v1";
const ACCOUNT_FIXTURE_MARKER_CONTENT = "kalcode-account-e2e-v1\n";
const ACCOUNT_FIXTURE_INITIALIZED_MARKER = ".kalcode-account-e2e-initialized-v1";
const ACCOUNT_FIXTURE_INITIALIZED_CONTENT = "kalcode-account-e2e-initialized-v1\n";

export interface Running {
  child: ChildProcess;
  dataDir: string;
  browser: Browser;
  page: Page;
}

interface OwnedApplication {
  child: ChildProcess;
  dataDir: string;
  browser: Browser | null;
  page: Page | null;
}

/** Exact per-test ownership. Failed cleanup stays registered for the fixture's bounded retry. */
export class OwnedApplicationRegistry<T> {
  readonly #owners = new Map<string, Set<T>>();

  begin(owner: string): void {
    if (this.#owners.has(owner)) throw new Error("The native E2E owner is already active");
    this.#owners.set(owner, new Set());
  }

  track(owner: string, value: T): void {
    const values = this.#owners.get(owner);
    if (!values) throw new Error("Native E2E launch requires the harness test fixture");
    values.add(value);
  }

  release(owner: string, value: T): void {
    this.#owners.get(owner)?.delete(value);
  }

  count(owner: string): number {
    return this.#owners.get(owner)?.size ?? 0;
  }

  requireActive(owner: string): void {
    if (!this.#owners.has(owner)) throw new Error("Native E2E launch requires the harness test fixture");
  }

  async cleanup(owner: string, cleanup: (value: T) => Promise<void>): Promise<number> {
    const values = this.#owners.get(owner);
    if (!values) return 0;
    let failures = 0;
    for (const value of [...values]) {
      try {
        await cleanup(value);
        values.delete(value);
      } catch {
        failures += 1;
      }
    }
    return failures;
  }

  async cleanupAll(cleanup: (value: T) => Promise<void>): Promise<number> {
    let failures = 0;
    for (const owner of [...this.#owners.keys()]) {
      failures += await this.cleanup(owner, cleanup);
      if (this.count(owner) === 0) this.finish(owner);
    }
    return failures;
  }

  finish(owner: string): void {
    this.#owners.delete(owner);
  }
}

const ownedApplications = new OwnedApplicationRegistry<OwnedApplication>();

export async function settleOwnedApplications<T>(
  registry: OwnedApplicationRegistry<T>,
  owner: string,
  cleanup: (value: T) => Promise<void>,
  bodyFailed: boolean,
  report: (failures: number) => Promise<void>,
): Promise<void> {
  let failures = await registry.cleanup(owner, cleanup);
  if (failures > 0) failures = await registry.cleanup(owner, cleanup);
  if (failures === 0) {
    registry.finish(owner);
    return;
  }
  if (bodyFailed) {
    await report(failures).catch(() => undefined);
    return;
  }
  throw new Error(`Failed to settle ${failures} owned native application(s)`);
}

function currentOwner(): string {
  return playwrightTest.info().testId;
}

async function attachCleanupFailure(testInfo: TestInfo, failures: number): Promise<void> {
  await testInfo.attach("native E2E owned cleanup failure", {
    body: Buffer.from(`Failed to settle ${failures} owned native application(s) after two bounded attempts.\n`),
    contentType: "text/plain",
  });
}

/**
 * Every spec imports this test fixture. It owns even partially launched children and settles them
 * without scanning or terminating any process that the current test did not spawn.
 */
export const test = playwrightTest.extend<
  { _ownedNativeApplications: undefined },
  { _ownedNativeWorkerCleanup: undefined }
>({
  _ownedNativeWorkerCleanup: [
    async (
      // biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern here.
      {},
      use,
    ) => {
      await use(undefined);
      const failures = await ownedApplications.cleanupAll(cleanupOwnedApplication);
      if (failures > 0) throw new Error(`Failed to settle ${failures} owned native application(s) at worker exit`);
    },
    { auto: true, scope: "worker" },
  ],
  _ownedNativeApplications: [
    async (
      // biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern here.
      {},
      use,
      testInfo,
    ) => {
      ownedApplications.begin(testInfo.testId);
      let useError: unknown;
      try {
        await use(undefined);
      } catch (error) {
        useError = error;
      }

      await settleOwnedApplications(
        ownedApplications,
        testInfo.testId,
        cleanupOwnedApplication,
        useError !== undefined || testInfo.status !== testInfo.expectedStatus,
        (failures) => attachCleanupFailure(testInfo, failures),
      );
      if (useError !== undefined) throw useError;
    },
    { auto: true },
  ],
});

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
        codex: "codex-cli 0.160.0",
        gemini: "0.61.0",
      },
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

export function isolatedWebviewEnvironment(
  overrides: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = { ...source };
  for (const name of Object.keys(inherited)) {
    const upper = name.toUpperCase();
    if (
      upper.startsWith("WEBVIEW2_") ||
      upper.startsWith("COREWEBVIEW2_") ||
      upper.startsWith("WEBKIT_INSPECTOR") ||
      upper === "KALCODE_E2E_RESOURCE_FIXTURE"
    ) {
      delete inherited[name];
    }
  }
  const childEnvironment: NodeJS.ProcessEnv = { ...inherited, ...overrides };
  for (const name of Object.keys(childEnvironment)) {
    const upper = name.toUpperCase();
    if (upper.startsWith("WEBVIEW2_") || upper.startsWith("COREWEBVIEW2_") || upper.startsWith("WEBKIT_INSPECTOR")) {
      delete childEnvironment[name];
    }
  }
  return childEnvironment;
}

function launchTimer(milliseconds: number): LaunchReadinessTimer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolveElapsed) => {
    handle = setTimeout(resolveElapsed, milliseconds);
  });
  return {
    elapsed,
    cancel: () => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

export async function launch(dataDir: string, env: Record<string, string> = {}): Promise<Running> {
  prepareAccountFixtureDataDir(dataDir);
  if (!Number.isInteger(PORT) || PORT < 1_024 || PORT > 65_535) {
    throw new Error(`KALCODE_E2E_CDP_PORT must be an integer from 1024 through 65535; received ${String(PORT)}`);
  }
  const owner = currentOwner();
  ownedApplications.requireActive(owner);
  const child = spawn(EXE, [], {
    env: {
      ...isolatedWebviewEnvironment({ KALCODE_E2E_ACCOUNT_FIXTURE: ACCOUNT_READY_FIXTURE_OPT_IN, ...env }),
      KALCODE_DATA_DIR: dataDir,
      KALCODE_E2E_CDP_PORT: String(PORT),
    },
    stdio: "ignore",
  });
  const owned: OwnedApplication = { child, dataDir, browser: null, page: null };
  ownedApplications.track(owner, owned);
  let spawnError: Error | null = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  let browser: Browser | null = null;
  try {
    const deadline = Date.now() + 30_000;
    const processProbe = {
      now: Date.now,
      timer: launchTimer,
      startupError: () => spawnError,
      exitCode: () => child.exitCode,
    };
    browser = await waitForLaunchConnection(processProbe, {
      deadline,
      processName: EXE,
      port: PORT,
      pollMilliseconds: 250,
      connect: (timeout) => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout }),
      disposeLate: (connection) => connection.close().catch(() => undefined),
    });
    const connectedBrowser = browser;
    owned.browser = connectedBrowser;

    const page = await waitForLaunchReadiness<Page>(
      {
        ...processProbe,
        databaseReady: () => existsSync(join(dataDir, "kalcode.db")),
        candidates: () =>
          connectedBrowser
            .contexts()
            .flatMap((context) => context.pages())
            .filter((candidate) => !candidate.isClosed() && !candidate.url().startsWith("devtools")),
        initialized: async (candidate) =>
          candidate.evaluate(() => {
            const tauri = (
              window as unknown as {
                __TAURI_INTERNALS__?: { invoke?: unknown };
              }
            ).__TAURI_INTERNALS__;
            const root = document.getElementById("root");
            return (
              document.readyState !== "loading" && typeof tauri?.invoke === "function" && root?.hasChildNodes() === true
            );
          }),
        candidateValid: (candidate) => !candidate.isClosed() && !candidate.url().startsWith("devtools"),
      },
      { deadline, processName: EXE },
    );
    owned.page = page;
    // The document is initialized while KalCode still shows a startup screen ("Starting your
    // workspace" while local services open). Under gate load that took 4-10 s, and specs then gave
    // the shell's first heading only the default 5 s. Return once no startup screen is busy.
    // A function, not a string predicate: the app's CSP forbids eval.
    const settleDeadline = Date.now() + 60_000;
    while (!(await page.evaluate(startupScreenSettled as () => boolean))) {
      if (Date.now() >= settleDeadline) throw new Error(`${EXE} stayed on a busy startup screen for 60 seconds`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    return owned as Running;
  } catch (error) {
    await cleanupOwnedApplication(owned)
      .then(() => ownedApplications.release(owner, owned))
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Whether KalCode has left its transitional startup screens: the boot mark, "Restoring your
 * session" and "Starting your workspace". Each is a busy status; once it settles the app shows the
 * shell, sign-in, or an error a spec can assert on. Self-contained: it runs in the page.
 */
export function startupScreenSettled(doc: Document = document): boolean {
  if (doc.querySelector(".boot-screen")) return false;
  return !Array.from(doc.querySelectorAll('[role="status"][aria-busy="true"]')).some(
    (status) => status.querySelector("#account-runtime-title, #account-title") !== null,
  );
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

/**
 * Waits for a real, fresh governor sample that can admit provider work. A user-requested agent is
 * admitted even before the first sample (owner directive 2026-10-04: late telemetry never holds
 * one), so `allowed` alone no longer proves a sample exists: also require a decision taken on a
 * sampled snapshot and a fresh reading.
 */
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
    if (
      last.admission.state === "allowed" &&
      last.admission.additional > 0 &&
      (last.admission.snapshotSeq ?? 0) > 0 &&
      last.freshness.state === "fresh"
    )
      return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Provider admission was not allowed within ${timeoutMs}ms: ${JSON.stringify(last)}`);
}

/** Graceful close: WM_CLOSE to the window, as when the user clicks the close button. */
export async function closeGracefully(app: Running) {
  let requested = ownedChildIsTerminal(app.child);
  if (!requested) {
    try {
      requested = closeWindowNamed(app.child.pid ?? -1, "KalCode");
    } catch {
      // The process may have closed between the CDP action and the UI Automation lookup.
    }
  }
  if (!requested && !ownedChildIsTerminal(app.child)) app.child.kill();
  if (!(await waitForOwnedExit(app.child, 10_000))) await stopOwnedProcess(app.child, true);
  await settleOwnedWebview(ownedWebviewProbe(app.dataDir));
  await closeBrowserBounded(app.browser);
  ownedApplications.release(currentOwner(), app);
}

/** Simulates a desktop crash while preserving its independent process-cleanup guardian. */
export async function killForcibly(app: Running): Promise<void> {
  await stopOwnedProcess(app.child, true);
  await settleOwnedWebview(ownedWebviewProbe(app.dataDir));
  await closeBrowserBounded(app.browser);
  ownedApplications.release(currentOwner(), app);
}

async function stopOwnedProcess(child: ChildProcess, force: boolean): Promise<void> {
  if (ownedChildIsTerminal(child)) return;
  if (!child.kill(force ? "SIGKILL" : undefined) && !ownedChildIsTerminal(child)) {
    throw new Error("The owned E2E process could not be signaled");
  }
  if (!(await waitForOwnedExit(child, 10_000))) throw new Error("The owned E2E process did not exit within 10 seconds");
}

async function waitForOwnedExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (ownedChildIsTerminal(child)) return true;
  return new Promise<boolean>((resolveExit) => {
    const finish = (exited: boolean) => {
      clearTimeout(handle);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const handle = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    if (ownedChildIsTerminal(child)) finish(true);
  });
}

/**
 * Called only after the owned app and its WebView2 tree (the CDP listener) have provably exited.
 * The connection is then closed once Playwright reports it disconnected. `browser.close()` itself
 * also awaits Playwright's own temporary artifacts-folder removal (`fs.rm` with retries), which
 * took up to 4.7 s under parallel load and is what overran the bound in gates 37529315873 and
 * 37520284094: by then the browser was already disconnected and no CDP connection remained.
 */
export async function closeBrowserBounded(browser: Pick<Browser, "close" | "isConnected" | "once">): Promise<void> {
  const closing = browser.close();
  closing.catch(() => undefined);
  const disconnected = new Promise<void>((resolveDisconnected) => {
    if (!browser.isConnected()) resolveDisconnected();
    else browser.once("disconnected", () => resolveDisconnected());
  });
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error("The owned E2E browser did not close within 5 seconds")), 5_000);
  });
  try {
    await Promise.race([closing, disconnected, timedOut]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

/** The processes `settleOwnedWebview` watches and, only past its grace period, terminates. */
export interface OwnedWebviewProbe {
  list(): number[];
  terminate(pid: number): void;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

/**
 * The CDP endpoint the harness connects to is served by the app's msedgewebview2.exe browser
 * process (a child of kalcode.exe), not by kalcode.exe. That WebView2 tree outlives the app by
 * seconds under load, and closing the CDP connection while it is still shutting down can hang:
 * "The owned E2E browser did not close within 5 seconds" (gates 37529315873, 37520284094). So once
 * the app has exited, wait for its own WebView2 tree to exit, terminate exactly those processes if
 * they linger past the grace period, and fail if any survive. Only then close the connection.
 */
export async function settleOwnedWebview(
  probe: OwnedWebviewProbe,
  graceMilliseconds = 15_000,
  confirmMilliseconds = 5_000,
  pollMilliseconds = 250,
): Promise<void> {
  const remainingAfter = async (milliseconds: number): Promise<number[]> => {
    const deadline = probe.now() + milliseconds;
    for (;;) {
      const pids = probe.list();
      if (pids.length === 0 || probe.now() >= deadline) return pids;
      await probe.sleep(pollMilliseconds);
    }
  };
  const lingering = await remainingAfter(graceMilliseconds);
  if (lingering.length === 0) return;
  console.warn(
    `[e2e] owned WebView2 processes outlived the app by ${graceMilliseconds}ms; ending ${lingering.join(", ")}`,
  );
  for (const pid of lingering) {
    try {
      probe.terminate(pid);
    } catch {
      // Exited between the listing and the signal; the confirmation below rechecks.
    }
  }
  const survivors = await remainingAfter(confirmMilliseconds);
  if (survivors.length > 0) {
    throw new Error(`Owned WebView2 processes outlived the E2E app: ${survivors.join(", ")}`);
  }
}

/** The WebView2 processes whose user data lives in this test's own data directory (Windows). */
function ownedWebviewProbe(dataDir: string): OwnedWebviewProbe {
  const needle = `${dataDir}${sep}`.replaceAll("'", "''");
  const script = `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('${needle}', [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId }`;
  return {
    list: () =>
      process.platform !== "win32"
        ? []
        : execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true })
            .split(/\r?\n/)
            .map((line) => Number.parseInt(line.trim(), 10))
            .filter((pid) => Number.isFinite(pid)),
    terminate: (pid) => process.kill(pid),
    sleep: (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
    now: Date.now,
  };
}

async function cleanupOwnedApplication(app: OwnedApplication): Promise<void> {
  const failures: string[] = [];
  try {
    await stopOwnedProcess(app.child, true);
  } catch {
    failures.push("process");
  }
  if (ownedChildIsTerminal(app.child)) {
    try {
      await settleOwnedWebview(ownedWebviewProbe(app.dataDir));
    } catch {
      failures.push("webview");
    }
  }
  if (app.browser) {
    try {
      await closeBrowserBounded(app.browser);
    } catch {
      failures.push("browser");
    }
  }
  if (failures.length > 0) throw new Error(`Owned native cleanup failed: ${failures.join(",")}`);
}

export function waitForExit(child: ChildProcess): Promise<void> {
  if (ownedChildIsTerminal(child)) return Promise.resolve();
  return new Promise((resolveExit) => {
    const onExit = () => resolveExit();
    child.once("exit", onExit);
    if (ownedChildIsTerminal(child)) {
      child.off("exit", onExit);
      resolveExit();
    }
  });
}

export function ownedChildIsTerminal(child: Pick<ChildProcess, "exitCode" | "pid" | "signalCode">): boolean {
  return child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
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
/** The reason specs give when `inServiceSession()` makes them skip. */
export const SERVICE_SESSION_SKIP = "skipped: session 0 has no interactive desktop; run in an interactive session";

let serviceSession: boolean | undefined;

/**
 * Whether this run is in Windows session 0 (a service, such as the self-hosted gate runner). It
 * has no interactive desktop, so UI Automation can't find or close a window and native dialogs and
 * foreground changes never behave as they do for a person. Specs that need those skip there with
 * `SERVICE_SESSION_SKIP`; interactive local and release runs still cover them. The same check as
 * `windows_tao_reentrant_focus.rs` (the process's own session id is 0).
 */
export function inServiceSession(): boolean {
  if (serviceSession === undefined) {
    serviceSession = false;
    if (process.platform === "win32") {
      try {
        const out = execFileSync(
          "powershell",
          ["-NoProfile", "-Command", `(Get-Process -Id ${process.pid}).SessionId`],
          {
            encoding: "utf8",
            windowsHide: true,
          },
        );
        serviceSession = out.trim() === "0";
      } catch {
        serviceSession = false;
      }
    }
  }
  return serviceSession;
}

export function closeWindowNamed(pid: number, name: string): boolean {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
    "$A = [System.Windows.Automation.AutomationElement]",
    "$S = [System.Windows.Automation.TreeScope]",
    `$byPid = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, ${pid})`,
    `$byName = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, '${name.replaceAll("'", "''")}')`,
    "$byWindow = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)",
    "$namedWindow = New-Object System.Windows.Automation.AndCondition($byName, $byWindow)",
    "$found = $null",
    "foreach ($top in $A::RootElement.FindAll($S::Children, $byPid)) {",
    `  if ($top.Current.Name -eq '${name.replaceAll("'", "''")}' -and $top.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) { $found = $top; break }`,
    "  $found = $top.FindFirst($S::Descendants, $namedWindow); if ($found) { break }",
    "}",
    "$pattern = $null",
    "if ($found -and $found.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$pattern)) {",
    "  ([System.Windows.Automation.WindowPattern]$pattern).Close()",
    "  'closed'",
    "} else { 'none' }",
    "} catch { 'none' }",
  ].join("\n");
  const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  return out.trim().endsWith("closed");
}
