import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, type Page } from "@playwright/test";
import {
  closeGracefully,
  EXE,
  inServiceSession,
  killForcibly,
  launch,
  removeDir,
  SERVICE_SESSION_SKIP,
  test,
  writeManagedFakeProviderConfig,
} from "./harness.ts";

// A binary built with the `e2e` feature (test hooks enabled) into its own target directory:
//   CARGO_TARGET_DIR=target/e2e pnpm tauri build --no-bundle --features e2e
// Normal release builds ignore KALCODE_DATA_DIR and WebView2 overrides by design.
test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

// WebView2's crash reporter can hold files in a finished run's folder for a while; sweep
// folders left by earlier runs. Only stale ones: parallel runs may be using recent folders.
test.beforeAll(() => {
  const staleBefore = Date.now() - 30 * 60_000;
  for (const name of readdirSync(tmpdir())) {
    const dir = join(tmpdir(), name);
    if (name.startsWith("kalcode-e2e-") && statSync(dir).mtimeMs < staleBefore) removeDir(dir);
  }
});

const activity = (page: Page) => page.getByRole("region", { name: "Activity" });
const FAKE = join(dirname(EXE), "kalcode-fake-provider.exe");

interface ProviderStatusLite {
  id: string;
  detection: { state: string; auth: string; displayPath: string | null; version: string | null } | null;
}

function invoke<T>(page: Page, command: string): Promise<T> {
  return page.evaluate(
    (cmd) =>
      (
        window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<unknown> } }
      ).__TAURI_INTERNALS__.invoke(cmd),
    command,
  ) as Promise<T>;
}

function displayedPath(path: string, home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()): string {
  const plain = (value: string) => (value.startsWith("\\\\?\\") ? value.slice(4) : value);
  const comparablePath = plain(path);
  const trimmedHome = plain(home).replace(/[\\/]+$/, "");
  if (trimmedHome.length === 0 || comparablePath.length < trimmedHome.length) return path;
  const head = comparablePath.slice(0, trimmedHome.length);
  const rest = comparablePath.slice(trimmedHome.length);
  const same = head.replaceAll("\\", "/").toLowerCase() === trimmedHome.replaceAll("\\", "/").toLowerCase();
  const atBoundary = rest.length === 0 || rest.startsWith("\\") || rest.startsWith("/");
  return same && atBoundary ? `~${rest}` : path;
}

test("launch, change settings, quit, relaunch: settings and history persist", async () => {
  // The graceful quit closes the window through UI Automation, which session 0 lacks.
  test.skip(inServiceSession(), SERVICE_SESSION_SKIP);
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
    await app.page.getByRole("button", { name: "Settings", exact: true }).click();
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
    await killForcibly(app);
    app = await launch(dataDir);
    await expect(app.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
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
    removeDir(dataDir);
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
    execFileSync("python", ["-c", script, join(dataDir, "kalcode.db")], { windowsHide: true });

    app = await launch(dataDir);
    await expect(app.page.getByRole("heading", { level: 1, name: "KalCode couldn't start" })).toBeVisible();
    await expect(app.page.getByText("created by a newer version of KalCode")).toBeVisible();
    await expect(app.page.getByText("Error code: database/schema_too_new")).toBeVisible();
    await closeGracefully(app);
  } finally {
    removeDir(dataDir);
  }
});

// Detection only runs `--version` and each provider's documented sign-in status command
// (Claude version detection and `codex login status`); it never sends a prompt or signs in.
test("the Providers page detects the installed Claude Code CLI", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-provider-detection-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  expect(existsSync(FAKE), "build:e2e must build the fake provider").toBe(true);
  for (const name of ["claude.exe", "codex.exe", "gemini.exe"]) copyFileSync(FAKE, join(bin, name));
  writeManagedFakeProviderConfig(bin);
  try {
    const app = await launch(dataDir, { PATH: `${bin};${process.env.PATH ?? ""}` });
    await expect(app.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

    // Safety gate: native detection resolved every provider to the no-network fake before the UI
    // asserts any installed or account state.
    const statuses = await invoke<ProviderStatusLite[]>(app.page, "providers_detect");
    for (const [id, executable, version] of [
      ["claude-code", "claude.exe", "2.1.282"],
      ["codex", "codex.exe", "0.160.0"],
      ["gemini-cli", "gemini.exe", "0.61.0"],
    ] as const) {
      const status = statuses.find((candidate) => candidate.id === id);
      const expectedDisplayPath = displayedPath(realpathSync.native(join(bin, executable)));
      expect(status?.detection?.state, id).toBe("installed");
      expect(expectedDisplayPath.startsWith("~"), id).toBe(true);
      expect(status?.detection?.displayPath?.toLowerCase(), id).toBe(expectedDisplayPath.toLowerCase());
      expect(status?.detection?.version, id).toBe(version);
    }

    await app.page.getByRole("button", { name: "Providers" }).click();
    await expect(app.page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();
    await app.page.getByRole("tab", { name: "Setup", exact: true }).click();

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
    removeDir(dataDir);
    removeDir(root);
  }
});

test("the Threads surface runs on the native thread runtime", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-thread-options-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    expect(existsSync(FAKE), "build:e2e must build the fake provider").toBe(true);
    for (const name of ["claude.exe", "codex.exe", "gemini.exe"]) copyFileSync(FAKE, join(bin, name));
    writeManagedFakeProviderConfig(bin);

    const app = await launch(dataDir, { PATH: `${bin};${process.env.PATH ?? ""}` });
    await expect(app.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    const statuses = await invoke<ProviderStatusLite[]>(app.page, "providers_detect");
    for (const [id, executable, version] of [
      ["claude-code", "claude.exe", "2.1.282"],
      ["codex", "codex.exe", "0.160.0"],
      ["gemini-cli", "gemini.exe", "0.61.0"],
    ] as const) {
      const status = statuses.find((candidate) => candidate.id === id);
      const expectedDisplayPath = displayedPath(realpathSync.native(join(bin, executable)));
      expect(status?.detection?.state, id).toBe("installed");
      expect(expectedDisplayPath.startsWith("~"), id).toBe(true);
      expect(status?.detection?.displayPath?.toLowerCase(), id).toBe(expectedDisplayPath.toLowerCase());
      expect(status?.detection?.version, id).toBe(version);
    }
    await app.page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Threads" }).click();
    await expect(app.page.getByRole("heading", { level: 1, name: "Threads" })).toBeVisible();

    // `thread_list` answered from the native runtime: an empty list, not an error.
    await expect(app.page.getByRole("heading", { name: "No threads yet" })).toBeVisible();
    await expect(app.page.getByText("Threads couldn't load")).toHaveCount(0);

    // `thread_options` answered natively. Managed no-network providers make this independent of
    // the host's installed CLIs; a fresh data folder must ask for a workspace.
    await app.page.getByRole("button", { name: "New thread" }).first().click();
    await expect(app.page.getByRole("heading", { level: 2, name: "New thread" })).toBeVisible();
    await expect(app.page.getByRole("heading", { name: "No workspaces yet" })).toBeVisible();
    await closeGracefully(app);

    // The threads schema was created in the isolated database.
    const script = `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(",".join(r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('threads','thread_messages','tool_calls','thread_files') ORDER BY name")))`;
    const tables = execFileSync("python", ["-c", script, join(dataDir, "kalcode.db")], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    expect(tables).toBe("thread_files,thread_messages,threads,tool_calls");
  } finally {
    removeDir(dataDir);
    removeDir(root);
  }
});
