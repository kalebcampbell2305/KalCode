import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { closeGracefully, EXE, launch, removeDir } from "./harness.ts";

/**
 * Wave 2 integration against the real app: a workspace (Z1) is offered to threads (Z3) together
 * with the providers the real detection (Z2) found usable, while a real terminal keeps working.
 *
 * Detection is read-only (`--version` and the documented sign-in status command). This test
 * never starts a thread or sends a prompt, so it never uses the owner's provider quota.
 */
test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name, exact: true });
const visibleTerminal = (page: Page) => page.locator('[role="tabpanel"]:not([hidden]) .xterm-rows');

async function typeInTerminal(page: Page, command: string) {
  await page.locator('[role="tabpanel"]:not([hidden]) .xterm-screen').click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function countIn(page: Page, marker: string): Promise<number> {
  return ((await visibleTerminal(page).textContent()) ?? "").split(marker).length - 1;
}

/** Calls a native command from the page, as the app's IPC client does. */
function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    ([cmd, a]) =>
      (
        window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } }
      ).__TAURI_INTERNALS__.invoke(cmd, a),
    [command, args] as const,
  ) as Promise<T>;
}

interface ProviderStatusLite {
  id: string;
  adapter: "implemented" | "planned";
  detection: { state: string; auth: string } | null;
}

async function shot(page: Page, name: string) {
  const dir = fileURLToPath(new URL("../../qa/screenshots/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

test("a workspace offers the detected Claude Code to threads while a terminal keeps running", async () => {
  test.setTimeout(180_000);
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "kalcode-e2e-project-"));
  const project = join(projectRoot, "wave2-project");
  mkdirSync(project);

  try {
    const app = await launch(dataDir, { KALCODE_E2E_PICK_FOLDER: project });
    const page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

    // Z1: open the temp folder and start a real shell in it.
    await nav(page, "Code").click();
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "wave2-project" })).toBeVisible();
    await page.getByRole("button", { name: /^New .+ terminal$/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(visibleTerminal(page)).toContainText("wave2-project", { timeout: 30_000 });
    await typeInTerminal(page, "echo wave2-before");
    await expect.poll(() => countIn(page, "wave2-before"), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);

    // Z3 + Z2: the New thread flow. Its first load runs the real, read-only detection.
    await nav(page, "Threads").click();
    await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toBeVisible();
    await page.getByRole("button", { name: "New thread" }).first().click();
    const form = page.getByRole("region", { name: "New thread" });
    await expect(form.getByRole("heading", { name: "New thread" })).toBeVisible();
    await expect(form.getByText("Loading providers and workspaces")).toHaveCount(0, { timeout: 60_000 });

    // Compare the UI with what native detection reported.
    const statuses = await invoke<ProviderStatusLite[]>(page, "providers_list");
    const claude = statuses.find((s) => s.id === "claude-code");
    expect(claude?.detection, "detection ran before the options were shown").not.toBeNull();
    const claudeUsable =
      claude?.adapter === "implemented" &&
      claude.detection?.state === "installed" &&
      claude.detection.auth !== "not_authenticated";
    const options = await invoke<{ providers: { id: string }[]; workspaces: { name: string }[] }>(
      page,
      "thread_options",
    );
    // Only providers with an adapter that detection found usable are offered: Claude Code or none.
    expect(options.providers.map((p) => p.id)).toEqual(claudeUsable ? ["claude-code"] : []);

    const unavailable = form.getByRole("list", { name: "Not available for threads" });
    if (claudeUsable) {
      await expect(form.getByLabel("Provider", { exact: true }).locator("option")).toHaveText([/^Claude Code/]);
      await expect(form.getByLabel("Workspace", { exact: true }).locator("option")).toHaveText(["wave2-project"]);
      expect(options.workspaces.map((w) => w.name)).toEqual(["wave2-project"]);
    } else {
      await expect(form.getByRole("heading", { name: "No provider is ready for threads" })).toBeVisible();
      await expect(unavailable.getByRole("listitem").filter({ hasText: "Claude Code" })).toBeVisible();
    }
    // Codex and Gemini CLI have no adapter: listed with the reason, never offered.
    for (const name of ["Codex", "Gemini CLI"]) {
      await expect(unavailable.getByRole("listitem").filter({ hasText: name })).toContainText(
        "KalCode can't run threads with it yet",
      );
    }
    await shot(page, "e2e-wave2-new-thread");

    // Leave without starting a thread: no prompt is ever sent.
    await form.getByRole("button", { name: claudeUsable ? "Cancel" : "Back to threads" }).click();
    await expect(page.getByRole("heading", { name: "No threads yet" })).toBeVisible();
    expect(await invoke<unknown[]>(page, "thread_list", { workspaceId: null, includeArchived: true })).toEqual([]);

    // The terminal kept running meanwhile and still takes input.
    await nav(page, "Code").click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(visibleTerminal(page)).toContainText("wave2-before");
    await typeInTerminal(page, "echo wave2-after");
    await expect.poll(() => countIn(page, "wave2-after"), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);

    // The Dashboard lists it among running terminals.
    await nav(page, "Dashboard").click();
    const terminals = page.getByRole("region", { name: "Terminals" });
    await expect(terminals.getByRole("heading", { name: "wave2-project" })).toBeVisible();
    await expect(terminals.getByRole("listitem")).toHaveCount(1);
    await shot(page, "e2e-wave2-dashboard");

    await closeGracefully(app);
  } finally {
    removeDir(dataDir);
    removeDir(projectRoot);
  }
});
