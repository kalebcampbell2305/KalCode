import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";

// A binary built with the `e2e` feature (test hooks enabled) into its own target directory:
//   CARGO_TARGET_DIR=target/e2e pnpm tauri build --no-bundle --features e2e
// Normal release builds ignore KALCODE_DATA_DIR and WebView2 overrides by design.
const EXE = process.env.KALCODE_E2E_EXE ?? resolve(import.meta.dirname, "../../../../target/e2e/release/kalcode.exe");
const PORT = Number(process.env.KALCODE_E2E_CDP_PORT ?? 9333);

test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

// WebView2's crash reporter can hold files in a finished run's folder for a while; sweep
// folders left by earlier runs. Only stale ones: parallel runs may be using recent folders.
test.beforeAll(() => {
  const staleBefore = Date.now() - 30 * 60_000;
  for (const name of readdirSync(tmpdir())) {
    const dir = join(tmpdir(), name);
    if (name.startsWith("kalcode-e2e-") && statSync(dir).mtimeMs < staleBefore) removeDataDir(dir);
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

// Detection only runs `--version` and each provider's documented sign-in status command
// (`claude auth status`, `codex login status`); it never sends a prompt or signs in.
test("the Providers page detects the installed Claude Code CLI", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  try {
    const app = await launch(dataDir);
    await expect(app.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await app.page.getByRole("button", { name: "Providers" }).click();
    await expect(app.page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();

    const claude = app.page.getByRole("region", { name: "Claude Code", exact: true });
    await expect(claude.getByText(/^Installed, version \d+\.\d+\.\d+/)).toBeVisible({ timeout: 30_000 });
    await expect(claude.getByText(/^(Signed in|Signed out|Sign-in status unknown)$/)).toBeVisible();
    // Every provider ends with a definite result, never a spinner.
    for (const name of ["Codex", "Gemini CLI"]) {
      const region = app.page.getByRole("region", { name, exact: true });
      await expect(region.getByText(/^(Installed, version|Outdated|Not installed|Couldn't check)/)).toBeVisible();
    }
    await expect(app.page.getByRole("button", { name: "Check again" })).toBeEnabled();

    // The first detection is recorded in the event log.
    await app.page.getByRole("button", { name: "Dashboard" }).click();
    await expect(activity(app.page).getByText(/^Claude Code \d+\.\d+\.\d+/)).toBeVisible();
    await closeGracefully(app);
  } finally {
    removeDataDir(dataDir);
  }
});

test("the Threads surface runs on the native thread runtime", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  try {
    const app = await launch(dataDir);
    await expect(app.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await app.page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Threads" }).click();
    await expect(app.page.getByRole("heading", { level: 1, name: "Threads" })).toBeVisible();

    // `thread_list` answered from the native runtime: an empty list, not an error.
    await expect(app.page.getByRole("heading", { name: "No threads yet" })).toBeVisible();
    await expect(app.page.getByText("Threads couldn't load")).toHaveCount(0);

    // `thread_options` answered natively. A fresh data folder has no workspace yet, so the flow
    // asks for one (or explains why no provider is ready when Claude Code isn't usable here).
    await app.page.getByRole("button", { name: "New thread" }).first().click();
    await expect(
      app.page.getByRole("heading", { name: /^(No workspaces yet|No provider is ready for threads)$/ }),
    ).toBeVisible({ timeout: 60_000 });
    await closeGracefully(app);

    // The threads schema was created in the isolated database.
    const script = `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(",".join(r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('threads','thread_messages','tool_calls','thread_files') ORDER BY name")))`;
    const tables = execFileSync("python", ["-c", script, join(dataDir, "kalcode.db")], { encoding: "utf8" }).trim();
    expect(tables).toBe("thread_files,thread_messages,threads,tool_calls");
  } finally {
    removeDataDir(dataDir);
  }
});
