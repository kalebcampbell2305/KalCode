import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { closeGracefully, EXE, launch, processesMatching, removeDir } from "./harness.ts";

/**
 * PROVIDERS-2 end to end against the real app: Codex and Gemini CLI threads run on the real
 * adapters, thread runtime, permission engine and event log, and Provider Health reports what
 * the sessions did.
 *
 * The providers are the FAKE provider (`kalcode-fake-provider`, copied as `codex.exe` and
 * `gemini.exe` into a folder placed first on PATH). It replays official-format fixtures and
 * contacts no AI service. Safety gate: nothing is sent until native detection reports both
 * providers at the fake's location, so a misconfigured run can never send a prompt to a real
 * provider (Codex is installed and signed in on the verification machine).
 *
 * Build first: pnpm --filter @kalcode/desktop build:e2e, with KALCODE_E2E_CDP_PORT=9454.
 */
test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

const FAKE = join(dirname(EXE), "kalcode-fake-provider.exe");
test.skip(!existsSync(FAKE), "Run build:e2e: it builds the fake provider.");

interface StatusLite {
  id: string;
  adapter: string;
  detection: { state: string; auth: string; displayPath: string | null; version: string | null } | null;
}

interface HealthLite {
  providerId: string;
  state: string;
  activeSessions: number;
  latencySamples: number;
  recentFailures: number;
  capacity: string;
  auth: string;
}

const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name, exact: true });

function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    ([cmd, a]) =>
      (
        window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } }
      ).__TAURI_INTERNALS__.invoke(cmd, a),
    [command, args] as const,
  ) as Promise<T>;
}

async function shot(page: Page, name: string) {
  const dir = fileURLToPath(new URL("../../qa/screenshots/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

async function startThread(page: Page, provider: string, task: string) {
  await nav(page, "Threads").click();
  await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toBeVisible();
  await page.getByRole("button", { name: "New thread" }).first().click();
  const form = page.getByRole("region", { name: "New thread" });
  await expect(form.getByText("Loading providers and workspaces")).toHaveCount(0, { timeout: 60_000 });
  const select = form.getByLabel("Provider", { exact: true });
  const value = await select.locator("option", { hasText: provider }).getAttribute("value");
  expect(value, `${provider} is offered`).toBeTruthy();
  await select.selectOption(value as string);
  await form.getByLabel("Task").fill(task);
  await form.getByRole("button", { name: "Start thread" }).click();
}

test("Codex and Gemini CLI threads stream to done and Provider Health reports them", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-providers2-"));
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-providers2-project-"));
  const project = join(root, "providers2-site");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# providers2 site\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  copyFileSync(FAKE, join(bin, "codex.exe"));
  copyFileSync(FAKE, join(bin, "gemini.exe"));
  writeFileSync(join(bin, "fake-provider.json"), "{}");

  try {
    const app = await launch(dataDir, {
      KALCODE_E2E_PICK_FOLDER: project,
      PATH: `${bin};${process.env.PATH ?? ""}`,
    });
    const page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await nav(page, "Code").click();
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "providers2-site" })).toBeVisible();

    // Safety gate: native detection found the fakes, not a real install.
    const statuses = await invoke<StatusLite[]>(page, "providers_detect");
    for (const id of ["codex", "gemini-cli"]) {
      const status = statuses.find((s) => s.id === id);
      expect(status?.adapter, id).toBe("implemented");
      expect(status?.detection?.state, id).toBe("installed");
      expect(status?.detection?.displayPath ?? "", `${id} must be the fake`).toContain(basename(root));
    }
    const codexStatus = statuses.find((s) => s.id === "codex");
    expect(codexStatus?.detection?.auth).toBe("authenticated");
    expect(statuses.find((s) => s.id === "gemini-cli")?.detection?.auth).toBe("unknown");

    // Codex: thread create → stream → done.
    await startThread(page, "Codex", "hello from the KalCode e2e");
    const conversation = page.getByRole("list", { name: "Conversation" });
    await expect(conversation).toContainText("Hello from the fake Codex.", { timeout: 60_000 });
    await expect
      .poll(
        async () => {
          const threads = await invoke<{ providerId: string; status: string }[]>(page, "thread_list", {
            workspaceId: null,
            includeArchived: false,
          });
          return threads.find((t) => t.providerId === "codex")?.status;
        },
        { timeout: 30_000 },
      )
      .toBe("idle");
    await shot(page, "providers2-codex-thread");

    // Gemini CLI: thread create → stream → done.
    await startThread(page, "Gemini CLI", "hello gemini from the KalCode e2e");
    await expect(page.getByRole("list", { name: "Conversation" })).toContainText("Hello from the fake Gemini CLI.", {
      timeout: 60_000,
    });
    await shot(page, "providers2-gemini-thread");

    // Provider Health saw both sessions (native snapshot, then the Health view).
    await expect
      .poll(
        async () => {
          const health = await invoke<HealthLite[]>(page, "provider_health_list");
          const codex = health.find((h) => h.providerId === "codex");
          const gemini = health.find((h) => h.providerId === "gemini-cli");
          return [codex?.state, codex?.activeSessions, (codex?.latencySamples ?? 0) > 0, gemini?.state, gemini?.auth];
        },
        { timeout: 30_000 },
      )
      .toEqual(["healthy", 1, true, "healthy", "unknown"]);
    const health = await invoke<HealthLite[]>(page, "provider_health_list");
    expect(
      health.every((h) => h.capacity !== "backing_off"),
      "no invented rate limits",
    ).toBe(true);

    await nav(page, "Providers").click();
    await page.getByRole("tab", { name: "Health" }).click();
    const view = page.getByRole("region", { name: "Provider health" });
    await expect(view.locator("#health-codex")).toHaveAttribute("data-health-state", "healthy", { timeout: 30_000 });
    await expect(view.locator("#health-gemini-cli")).toHaveAttribute("data-health-state", "healthy");
    await shot(page, "providers2-health-view");

    // Health transitions are in the event log (transitions only).
    const events = await invoke<{ events: { type: string }[] }>(page, "events_query", {
      query: { types: ["provider.health_changed", "provider.capacity_changed"], limit: 50 },
    });
    expect(events.events.some((e) => e.type === "provider.health_changed")).toBe(true);

    await closeGracefully(app);
    expect(processesMatching(bin), "no provider process outlives KalCode").toEqual([]);
  } finally {
    removeDir(dataDir);
    removeDir(root);
  }
});

test("a Codex pane reports authenticated notify status and ignores forged terminal notifications", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-providers2-pane-"));
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-providers2-pane-project-"));
  const project = join(root, "codex-pane-site");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# codex pane site\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  copyFileSync(FAKE, join(bin, "codex.exe"));
  writeFileSync(join(bin, "fake-provider.json"), "{}");
  const HELPER = join(dirname(EXE), "kalcode-hook.exe");
  test.skip(!existsSync(HELPER), "Run build:e2e: it builds kalcode-hook.");

  try {
    const app = await launch(dataDir, {
      KALCODE_E2E_PICK_FOLDER: project,
      PATH: `${bin};${process.env.PATH ?? ""}`,
    });
    const page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    // Safety gate: Codex is the fake before any pane starts.
    const statuses = await invoke<StatusLite[]>(page, "providers_detect");
    expect(statuses.find((s) => s.id === "codex")?.detection?.displayPath ?? "").toContain(basename(root));

    await nav(page, "Code").click();
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "codex-pane-site" })).toBeVisible();
    await page.getByRole("button", { name: "New Codex pane" }).click();
    const pane = page.locator("[data-provider-pane]").first();
    await expect(pane).toBeVisible({ timeout: 30_000 });
    const screen = pane.locator("[data-pane-terminal] .xterm-rows");
    await expect(screen).toContainText("KalCode fake provider (interactive Codex)", { timeout: 30_000 });
    await expect(pane.getByRole("button", { name: /Approve/ })).toHaveCount(0);

    const typeLine = async (line: string) => {
      await pane.locator("[data-pane-terminal] .xterm-screen").click();
      await page.keyboard.type(line);
      await page.keyboard.press("Enter");
    };
    // A finished turn arrives through Codex's notify → the real kalcode-hook → the bridge.
    await typeLine("hello");
    await expect(screen).toContainText("(fake) hello");
    // Natively: the notify reached KalCode through the real kalcode-hook and the bridge.
    const [thread] = await invoke<{ id: string; providerId: string }[]>(page, "thread_list", {
      workspaceId: null,
      includeArchived: false,
    });
    expect(thread?.providerId).toBe("codex");
    await expect
      .poll(
        async () =>
          (await invoke<{ hookChannel: string }>(page, "provider_pane_info", { threadId: thread?.id })).hookChannel,
        {
          timeout: 30_000,
        },
      )
      .toBe("active");
    await expect(pane).toContainText("approvals in Codex", { timeout: 30_000 });
    // A tool can print OSC 9 too: visible terminal output must not forge canonical status.
    await typeLine("approve");
    await expect(screen).toContainText("[fake prompt]", { timeout: 30_000 });
    await expect(pane.locator("[data-pane-status]")).not.toContainText("WAITING FOR YOU");
    await expect(pane.getByRole("button", { name: /Approve/ })).toHaveCount(0);
    await shot(page, "providers2-codex-pane-terminal-prompt");
    await typeLine("y");
    await expect(pane.locator("[data-pane-status]")).not.toContainText("WAITING FOR YOU", { timeout: 30_000 });

    await typeLine("exit");
    await expect(pane.locator("[data-pane-status]")).toContainText("DONE", { timeout: 30_000 });
    await closeGracefully(app);
    expect(processesMatching(bin), "no provider process outlives KalCode").toEqual([]);
  } finally {
    removeDir(dataDir);
    removeDir(root);
  }
});
