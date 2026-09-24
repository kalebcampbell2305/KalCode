import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";

// A binary built with the `e2e` feature (test hooks enabled) into its own target directory:
//   CARGO_TARGET_DIR=target/e2e pnpm tauri build --no-bundle --features e2e
// Normal release builds ignore KALCODE_DATA_DIR and WebView2 overrides by design.
const EXE = process.env.KALCODE_E2E_EXE ?? resolve(import.meta.dirname, "../../../../target/e2e/release/kalcode.exe");
const PORT = 9333;

test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

// WebView2's crash reporter can hold files in a finished run's folder for a while; sweep
// folders left by earlier runs before starting.
test.beforeAll(() => {
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith("kalcode-e2e-")) removeDataDir(join(tmpdir(), name));
  }
});

interface Running {
  child: ChildProcess;
  browser: Browser;
  page: Page;
}

async function launch(dataDir: string): Promise<Running> {
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      KALCODE_DATA_DIR: dataDir,
      // Isolated WebView2 profile so tests never share state with a running KalCode.
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
  // Safety: never drive an app that is using the real data folder.
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
  while (!page) {
    page = await context.waitForEvent("page");
  }
  return { child, browser, page };
}

/** Graceful close: WM_CLOSE to the window, as when the user clicks the close button. */
async function closeGracefully(app: Running) {
  await app.browser.close().catch(() => undefined);
  execFileSync("taskkill", ["/PID", String(app.child.pid)]);
  await waitForExit(app.child);
}

/** Simulates a crash or force quit. */
async function kill(app: Running) {
  await app.browser.close().catch(() => undefined);
  execFileSync("taskkill", ["/F", "/PID", String(app.child.pid)]);
  await waitForExit(app.child);
}

/** WebView2 helper processes release file locks shortly after the app exits. */
function removeDataDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch {
    // Left for the next run's sweep.
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once("exit", () => resolveExit()));
}

const activity = (page: Page) => page.getByRole("region", { name: "Activity" });

test("launch, change settings, quit, relaunch: settings and history persist", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  try {
    // First launch: fresh database.
    let app = await launch(dataDir);
    await expect(app.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(activity(app.page).getByText("Local database created")).toBeVisible();
    await expect(activity(app.page).getByText("KalCode started")).toBeVisible();

    // Real OS credential store round trip (Windows Credential Manager).
    await app.page.getByRole("button", { name: "Check credential store" }).click();
    await expect(activity(app.page).getByText("Credential store verified")).toBeVisible();

    // Change settings through the UI.
    await app.page.getByRole("button", { name: "Settings" }).click();
    await app.page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
    await app.page.getByRole("radiogroup", { name: "Density" }).getByRole("radio", { name: "Compact" }).click();
    await expect(app.page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(app.page.locator("html")).toHaveAttribute("data-density", "compact");

    await closeGracefully(app);

    // Relaunch: settings restored before first paint; history shows a clean shutdown.
    app = await launch(dataDir);
    await expect(app.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(app.page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(app.page.locator("html")).toHaveAttribute("data-density", "compact");
    await expect(activity(app.page).getByText("KalCode closed")).toBeVisible();
    await expect(activity(app.page).getByText("Settings changed").first()).toBeVisible();
    await expect(activity(app.page).getByText("Previous session ended unexpectedly")).toHaveCount(0);

    // Crash: the next launch reports the interrupted session.
    await kill(app);
    app = await launch(dataDir);
    await expect(activity(app.page).getByText("Previous session ended unexpectedly")).toBeVisible();

    // Structured JSON logs were written, and contain no credential material.
    const logDir = join(dataDir, "logs");
    const logs = readdirSync(logDir)
      .map((f) => readFileSync(join(logDir, f), "utf8"))
      .join("\n");
    expect(logs).toContain('"event":"app.started"');
    expect(logs).not.toMatch(/diagnostics:probe:[0-9a-f]{32}.*[0-9a-f-]{36}/);

    await closeGracefully(app);
  } finally {
    removeDataDir(dataDir);
  }
});

test("a database from a newer KalCode is refused with a clear explanation", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  try {
    let app = await launch(dataDir);
    await expect(app.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await closeGracefully(app);

    // Simulate a database written by a future version.
    const script = `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("INSERT INTO schema_migrations VALUES (99,'future','x','2030-01-01T00:00:00.000Z')"); c.commit()`;
    execFileSync("python", ["-c", script, join(dataDir, "kalcode.db")]);

    app = await launch(dataDir);
    await expect(app.page.getByRole("heading", { level: 1, name: "KalCode couldn't start" })).toBeVisible();
    await expect(app.page.getByText("created by a newer version of KalCode")).toBeVisible();
    await expect(app.page.getByText("Error code: database/schema_too_new")).toBeVisible();
    await closeGracefully(app);
  } finally {
    removeDataDir(dataDir);
  }
});
