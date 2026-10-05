import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import {
  closeGracefully,
  EXE,
  launch,
  RESOURCE_PROVIDER_FIXTURE_OPT_IN,
  removeDir,
  test,
  waitForProviderAdmission,
  writeManagedFakeProviderConfig,
} from "./harness.ts";

/**
 * Z7-W3 end to end against the real app: a provider pane asks for permission and later finishes;
 * the native notification center (crates/notifications) raises both from the real events; the
 * Dashboard shows the thread as ACTION NEEDED and then DONE; opening each notification focuses the
 * thread's pane in the Code surface.
 *
 * The provider is the FAKE provider (`kalcode-fake-provider`, copied as `claude.exe` first on PATH):
 * no AI service is contacted and no quota is used. Nothing is typed until the pane shows the
 * fake's banner. Build first: pnpm --filter @kalcode/desktop build:e2e; run with
 * KALCODE_E2E_CDP_PORT=9453 for this worktree.
 */
test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

const FAKE = join(dirname(EXE), "kalcode-fake-provider.exe");
const HELPER = join(dirname(EXE), "kalcode-hook.exe");
test.skip(!existsSync(FAKE) || !existsSync(HELPER), "Run build:e2e: it builds kalcode-hook and the fake provider.");

const FAKE_BANNER = "KalCode fake provider (interactive)";

const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name, exact: true });
const bell = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^Needs you/ });
const center = (page: Page) => page.getByRole("dialog", { name: "Needs you" });

/** The history's unread count, as the open Needs you sheet states it (then closes the sheet). */
async function expectUnread(page: Page, count: number, timeout = 5_000) {
  if (!(await center(page).isVisible())) await bell(page).click();
  const summary = center(page).locator("#notifications-description");
  if (count === 0) await expect(summary).not.toContainText("unread", { timeout });
  else await expect(summary).toContainText(`${count} unread ${count === 1 ? "update" : "updates"}`, { timeout });
  await page.keyboard.press("Escape");
  await expect(center(page)).toHaveCount(0);
}
const pane = (page: Page) => page.locator("[data-provider-pane]").first();

async function shot(page: Page, name: string) {
  const dir = fileURLToPath(new URL("../../qa/screenshots/w3/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

async function typeInPane(page: Page, line: string) {
  await pane(page).locator("[data-pane-terminal] .xterm-screen").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function expectPaneText(page: Page, text: string, timeout = 30_000) {
  await expect(pane(page).locator("[data-pane-terminal] .xterm-rows")).toContainText(text, { timeout });
}

test("a pane's permission request and completion reach the notification center, and each focuses the pane", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-w3-"));
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-w3-project-"));
  const project = join(root, "notify-site");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# notify site\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  copyFileSync(FAKE, join(bin, "claude.exe"));
  writeManagedFakeProviderConfig(bin);

  const env = {
    KALCODE_E2E_PICK_FOLDER: project,
    KALCODE_E2E_HOOK_DECISIONS: "engine",
    KALCODE_E2E_RESOURCE_FIXTURE: RESOURCE_PROVIDER_FIXTURE_OPT_IN,
    PATH: `${bin};${process.env.PATH ?? ""}`,
  };

  try {
    const app = await launch(dataDir, env);
    const page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await expectUnread(page, 0);

    // A real provider pane (the fake CLI) in a real PTY.
    await nav(page, "Code").click();
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "notify-site" })).toBeVisible();
    await waitForProviderAdmission(page);
    await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("button", { name: "Launch Claude Code agent" })
      .click();
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });
    await expectPaneText(page, FAKE_BANNER, 30_000); // safety gate: the fake, not a real provider
    // A fresh session at its prompt is READY (shared agent state); IDLE once it has worked.
    await expect(pane(page).locator("[data-pane-status]")).toContainText(/READY|IDLE/, { timeout: 30_000 });

    // Bypass runs routine coding without prompts, but credential access still asks.
    await expect(pane(page).locator("[data-pane-mode]")).toHaveAttribute("data-pane-mode", "bypass");
    await typeInPane(page, "run printenv");
    await expect(pane(page).locator("[data-pane-status]")).toContainText("NEEDS YOU", { timeout: 30_000 });
    await expectUnread(page, 1, 15_000);

    // A question or approval is also live in Needs you (the history keeps its own unread count).
    await expect(bell(page)).toHaveAccessibleName("Needs you, 1 waiting");

    // Activity shows the pane's thread as ACTION NEEDED with the inline approval.
    await nav(page, "Activity").click();
    const board = page.getByRole("region", { name: "Agents", exact: true });
    const card = board.getByRole("article").first();
    await expect(card.getByText("Needs you", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(card.getByRole("button", { name: "Approve once" })).toBeVisible();
    await shot(page, "e2e-dashboard-action-needed");

    // Opening the notification focuses the pane (Code surface, pane selected).
    await bell(page).click();
    const permission = center(page).getByRole("article", { name: /needs your permission/ });
    await expect(permission).toBeVisible();
    await shot(page, "e2e-notification-center");
    await permission.getByRole("button", { name: /needs your permission$/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "notify-site" })).toBeVisible();
    await expect(pane(page)).toBeVisible();
    await expect(pane(page).locator("[data-pane-status]")).toContainText("NEEDS YOU");
    await expectUnread(page, 0);

    await page.getByRole("button", { name: "Approve once" }).first().click();
    await expectPaneText(page, "RAN Bash");
    await expect(pane(page).locator("[data-pane-status]")).toContainText(/READY|IDLE/, { timeout: 30_000 });

    // The provider exits: the thread completes and the center says so.
    await typeInPane(page, "exit");
    await expect(pane(page).locator("[data-pane-status]")).toContainText("DONE", { timeout: 30_000 });
    await expectUnread(page, 1, 15_000);

    await nav(page, "Activity").click();
    await expect(board.getByRole("article").first().getByText("Done", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, "e2e-dashboard-done");

    await bell(page).click();
    const completed = center(page).getByRole("article", { name: /completed$/ });
    await expect(completed).toBeVisible();
    await completed.getByRole("button", { name: /completed$/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "notify-site" })).toBeVisible();
    await expect(pane(page).locator("[data-pane-status]")).toContainText("DONE");
    await expectUnread(page, 0);

    await closeGracefully(app);
  } finally {
    removeDir(dataDir);
    removeDir(root);
  }
});
