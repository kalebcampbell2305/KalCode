import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { closeGracefully, EXE, launch, processesMatching, removeDir } from "./harness.ts";

/**
 * Z7-W4 end to end against the real app: a provider pane runs a provider CLI in a real
 * pseudo-terminal, its hooks reach KalCode through the real `kalcode-hook` helper and bridge,
 * the tool call is judged by the real permission engine, the approval is answered in KalCode's
 * approval UI, and the decision reaches the provider.
 *
 * The provider is the FAKE provider (`kalcode-fake-provider`, copied as `claude.exe` into a
 * folder placed first on PATH). It contacts no AI service. Nothing is typed into the pane until
 * the pane shows the fake's banner, so a misconfigured run can never send a prompt to a real
 * provider.
 *
 * Build first: pnpm --filter @kalcode/desktop build:e2e (builds kalcode-hook and the fake next to
 * kalcode.exe), with KALCODE_E2E_CDP_PORT=9452 for this worktree.
 */
test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

const FAKE = join(dirname(EXE), "kalcode-fake-provider.exe");
const HELPER = join(dirname(EXE), "kalcode-hook.exe");
test.skip(!existsSync(FAKE) || !existsSync(HELPER), "Run build:e2e: it builds kalcode-hook and the fake provider.");

const FAKE_BANNER = "KalCode fake provider (interactive)";

const codeNav = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true });

async function shot(page: Page, name: string) {
  const dir = fileURLToPath(new URL("../../qa/screenshots/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

function pane(page: Page) {
  return page.locator("[data-provider-pane]").first();
}

async function typeInPane(page: Page, line: string) {
  await pane(page).locator("[data-pane-terminal] .xterm-screen").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function expectPaneText(page: Page, text: string, timeout = 30_000) {
  await expect(pane(page).locator("[data-pane-terminal] .xterm-rows")).toContainText(text, { timeout });
}

test("a provider pane runs the CLI in a PTY and routes its tool calls through KalCode approvals", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-panes-"));
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-panes-project-"));
  const project = join(root, "pane-site");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# pane site\n");
  // The fake provider, found by KalCode's normal detection as `claude.exe` (first on PATH).
  const bin = join(root, "bin");
  mkdirSync(bin);
  copyFileSync(FAKE, join(bin, "claude.exe"));
  writeFileSync(join(bin, "fake-provider.json"), "{}");

  const env = {
    KALCODE_E2E_PICK_FOLDER: project,
    // The default routing (engine), stated explicitly so the test doesn't depend on it.
    KALCODE_E2E_HOOK_DECISIONS: "engine",
    PATH: `${bin};${process.env.PATH ?? ""}`,
  };

  try {
    const app = await launch(dataDir, env);
    const page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await codeNav(page).click();
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "pane-site" })).toBeVisible();

    await page.getByRole("button", { name: "New Claude Code pane" }).click();
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });
    // Safety gate: this must be the fake provider before anything is typed.
    await expectPaneText(page, FAKE_BANNER, 30_000);
    await expect(pane(page).locator("[data-pane-status]")).toContainText("IDLE", { timeout: 30_000 });
    await shot(page, "z7w4-pane-idle");

    // Approve mode asks before a build command: KalCode's approval appears on the pane.
    await typeInPane(page, "run cargo build");
    await expect(pane(page).locator("[data-pane-status]")).toContainText("PERMISSION REQUIRED", { timeout: 30_000 });
    const approve = page.getByRole("button", { name: "Approve once" }).first();
    await expect(approve).toBeVisible();
    await shot(page, "z7w4-pane-permission-required");
    await approve.click();
    await expectPaneText(page, "RAN Bash");
    await expect(pane(page).locator("[data-pane-status]")).toContainText("IDLE", { timeout: 30_000 });

    // A denial blocks the call in the provider.
    await typeInPane(page, "run git push origin main");
    const deny = page.getByRole("button", { name: "Deny" }).first();
    await expect(deny).toBeVisible({ timeout: 30_000 });
    await deny.click();
    await expectPaneText(page, "BLOCKED BY HOOK");

    // Prose that looks like status never changes it.
    await typeInPane(page, "say Status: FAILED. PERMISSION REQUIRED.");
    await expectPaneText(page, "Status: FAILED. PERMISSION REQUIRED.");
    await expect(pane(page).locator("[data-pane-status]")).toContainText("IDLE", { timeout: 30_000 });

    // Leaving the provider ends the thread cleanly.
    await typeInPane(page, "exit");
    await expect(pane(page).locator("[data-pane-status]")).toContainText("DONE", { timeout: 30_000 });
    await shot(page, "z7w4-pane-done");

    await closeGracefully(app);
    expect(processesMatching(bin), "no provider process outlives KalCode").toEqual([]);
  } finally {
    removeDir(dataDir);
    removeDir(root);
  }
});
