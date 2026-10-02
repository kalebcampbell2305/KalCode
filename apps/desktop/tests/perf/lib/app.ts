/**
 * Launches the real KalCode binary for measurement, isolated exactly like the real-app E2E
 * suite: its own data folder (KALCODE_DATA_DIR), its own WebView2 profile, and a DevTools port
 * that no other worktree uses. Refuses to continue if the binary ignores the data folder.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { type Browser, chromium, type Page } from "@playwright/test";
import { prepareAccountFixtureDataDir } from "../../e2e/harness.ts";
import type { ProcessProbe } from "./platform.ts";

export interface LaunchOptions {
  exe: string;
  dataDir: string;
  cdpPort: number;
  probe: ProcessProbe;
  timeoutMs?: number;
}

export interface Running {
  child: ChildProcess;
  pid: number;
  browser: Browser;
  page: Page;
  /** Epoch ms immediately before the process was spawned. */
  spawnedAt: number;
  /** Epoch ms at which the main window became visible (OS-observed). */
  windowVisibleAt: number;
}

/**
 * Page-side timings, converted to epoch ms using the page's `performance.timeOrigin`. Paint
 * timings (first-contentful-paint) are not used: the window is hidden until `window_ready`, and
 * Chromium does not report paint timing for a page that painted while hidden.
 */
export interface PageTimings {
  navigationStartAt: number;
  domContentLoadedAt: number | null;
  loadAt: number | null;
  /** When the frontend's `window_ready` IPC call completed (it runs after the first real render). */
  windowReadyIpcAt: number | null;
}

/** Measurement data folders: the e2e build accepts the account fixture only under this prefix. */
export const PERF_DIR_PREFIX = "kalcode-e2e-perf-";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export async function launch(options: LaunchOptions): Promise<Running> {
  const { exe, dataDir, cdpPort, probe } = options;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (await portInUse(cdpPort)) {
    throw new Error(`DevTools port ${cdpPort} is already in use; refusing to attach to another process's WebView.`);
  }
  // Start the OS-side window watcher first so its own startup never delays or races the app.
  const watcher = await probe.createWindowWatcher(timeoutMs);
  // The e2e build opens its own DevTools port and WebView2 profile from KALCODE_E2E_CDP_PORT and
  // the data folder, and boots straight into a ready account with the reviewed fixture (exactly as
  // the real-app E2E harness launches it).
  prepareAccountFixtureDataDir(dataDir);
  const env: NodeJS.ProcessEnv = { ...process.env, KALCODE_E2E_ACCOUNT_FIXTURE: "ready-v1" };
  for (const name of Object.keys(env)) {
    if (/^(WEBVIEW2_|COREWEBVIEW2_|WEBKIT_INSPECTOR)/i.test(name) || name === "KALCODE_E2E_RESOURCE_FIXTURE") {
      delete env[name];
    }
  }
  const spawnedAt = epochNow();
  const child = spawn(exe, [], {
    env: { ...env, KALCODE_DATA_DIR: dataDir, KALCODE_E2E_CDP_PORT: String(cdpPort) },
    stdio: "ignore",
  });
  const pid = child.pid;
  if (pid === undefined) {
    watcher.dispose();
    throw new Error(`Could not start ${exe}`);
  }
  let windowVisibleAt: number;
  try {
    windowVisibleAt = await watcher.watch(pid);
  } catch (error) {
    probe.forceKill(pid);
    throw error;
  } finally {
    watcher.dispose();
  }

  // Safety: never measure (or keep running) an app that is not using the isolated data folder.
  const dbDeadline = Date.now() + 10_000;
  while (!existsSync(join(dataDir, "kalcode.db"))) {
    if (Date.now() > dbDeadline) {
      probe.forceKill(pid);
      throw new Error(`${exe} did not use the isolated data folder; build it with \`pnpm build:e2e\`.`);
    }
    await sleep(50);
  }

  try {
    const { browser, page } = await connect(cdpPort, timeoutMs);
    return { child, pid, browser, page, spawnedAt, windowVisibleAt };
  } catch (error) {
    probe.forceKill(pid);
    throw error;
  }
}

/** Attaches Playwright to the app's WebView2 over the DevTools protocol. */
export async function connect(cdpPort: number, timeoutMs = 30_000): Promise<{ browser: Browser; page: Page }> {
  const deadline = Date.now() + timeoutMs;
  let browser: Browser | null = null;
  while (!browser) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(100);
    }
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error("No WebView2 browser context");
  let page = context.pages().find((p) => !p.url().startsWith("devtools"));
  while (!page) page = await context.waitForEvent("page");
  return { browser, page };
}

/**
 * Detaches the DevTools client (the app keeps running), so idle measurements carry no debugger
 * overhead. Call `reattach` before driving the page again.
 */
export async function detach(app: Running): Promise<void> {
  await app.browser.close().catch(() => undefined);
}

export async function reattach(app: Running, cdpPort: number): Promise<void> {
  const { browser, page } = await connect(cdpPort);
  app.browser = browser;
  app.page = page;
}

/** Reads navigation/paint/resource timings the page recorded on its own (no observer effect). */
export async function pageTimings(page: Page): Promise<PageTimings> {
  return page.evaluate(() => {
    // In the page this is the DOM Performance API (Node's typings would otherwise apply here).
    const perf = performance as unknown as {
      timeOrigin: number;
      getEntriesByType(type: string): (PerformanceEntry & Partial<PerformanceNavigationTiming>)[];
    };
    const origin = perf.timeOrigin;
    const abs = (value: number | undefined) => (value && value > 0 ? origin + value : null);
    const nav = perf.getEntriesByType("navigation")[0];
    const ready = perf.getEntriesByType("resource").find((entry) => /\/window_ready(\?|$)/.test(entry.name));
    return {
      navigationStartAt: origin,
      domContentLoadedAt: abs(nav?.domContentLoadedEventEnd),
      loadAt: abs(nav?.loadEventEnd),
      windowReadyIpcAt: abs(ready?.responseEnd),
    };
  });
}

/** Waits for the Dashboard to be on screen (the app booted into its normal shell). */
export async function waitForShell(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.getByRole("heading", { level: 1, name: "Dashboard" }).waitFor({ state: "visible", timeout: timeoutMs });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Graceful close (WM_CLOSE). Returns ms from the request to process exit. */
export async function close(app: Running, probe: ProcessProbe, timeoutMs = 20_000): Promise<number> {
  await app.browser.close().catch(() => undefined);
  const start = epochNow();
  probe.requestClose(app.pid);
  const exited = await waitForExit(app.child, timeoutMs);
  const elapsed = epochNow() - start;
  if (!exited) {
    probe.forceKill(app.pid);
    await waitForExit(app.child, 5_000);
    throw new Error(`KalCode did not exit within ${timeoutMs} ms of a close request`);
  }
  return elapsed;
}

/** Best-effort cleanup; WebView2 helpers release file locks shortly after exit. */
export function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // Left for the next run's sweep.
  }
}
