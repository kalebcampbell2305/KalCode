import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { closeGracefully, EXE, launch, processesMatching, removeDir, test } from "./harness.ts";

/**
 * KalTidy against the real app: real shells in real pseudo-terminals and the real process scan.
 * An idle PowerShell at its prompt is stopped; a Command Prompt running `ping` is kept.
 * Build first: pnpm --filter @kalcode/desktop build:e2e.
 */
test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

const PING = "-n 900 127.0.0.1";
/** Real-app screenshots for visual review (apps/desktop/qa/screenshots, git-ignored). */
async function shot(page: Page, name: string) {
  const dir = fileURLToPath(new URL("../../qa/screenshots/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

const visibleTerminal = (page: Page) => page.locator('[role="tabpanel"]:not([hidden]) .xterm-rows');

test("KalTidy stops an idle shell and keeps a terminal running a command", async () => {
  // KalTidy waits for a shell to be quiet for two minutes before it counts as idle.
  test.setTimeout(420_000);
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "kalcode-e2e-project-"));
  const project = join(projectRoot, "tidy-site");
  mkdirSync(project);
  try {
    const app = await launch(dataDir, { KALCODE_E2E_PICK_FOLDER: project });
    const page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "tidy-site" })).toBeVisible();

    // An idle shell: started, at its prompt, nothing typed.
    await page.getByRole("button", { name: /^New .+ terminal$/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(visibleTerminal(page)).toContainText(basename(project), { timeout: 30_000 });

    // A busy one: Command Prompt running ping (output every second).
    await page.getByRole("button", { name: "Choose a shell" }).click();
    await page.getByRole("menuitem", { name: /Command Prompt/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(visibleTerminal(page)).toContainText("Microsoft Windows", { timeout: 30_000 });
    await page.locator('[role="tabpanel"]:not([hidden]) .xterm-screen').click();
    await page.keyboard.type(`ping ${PING}`);
    await page.keyboard.press("Enter");
    await expect.poll(() => processesMatching(PING).length, { timeout: 20_000 }).toBeGreaterThan(0);

    // Before the quiet threshold nothing is idle: one click stops nothing.
    await page.getByRole("button", { name: "KalTidy: Stop idle terminals" }).click();
    await expect(page.getByText("No idle terminals to stop. Kept 2 terminals in use.")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("tab")).toHaveCount(2);

    // Past the threshold (2 minutes quiet), from the Dashboard so neither terminal is focused.
    await page.waitForTimeout(125_000);
    await page.getByRole("button", { name: "Dashboard" }).click();
    await page.keyboard.press("Control+K");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.getByRole("combobox").fill("tidy");
    await palette.getByRole("option", { name: "KalTidy: Review terminals before stopping" }).click();
    const review = page.getByRole("dialog", { name: "KalTidy — Stop idle terminals" });
    const idle = review.getByRole("region", { name: /^Idle/ });
    await expect(idle.getByRole("checkbox")).toHaveCount(1, { timeout: 20_000 });
    await expect(idle.getByRole("checkbox")).toBeChecked();
    await expect(idle).toContainText("At its prompt, quiet for");
    // The ping terminal is shown as in use (active or waiting), never idle.
    await expect(idle).not.toContainText(/ping/i);
    await expect(review.getByRole("region", { name: /^(Active|Waiting for you)/ })).toContainText(/ping/i);
    await shot(page, "e2e-kaltidy-review");
    await review.getByRole("button", { name: "Cancel" }).click();

    // One click from the palette: only the idle shell stops.
    await page.keyboard.press("Control+K");
    await palette.getByRole("combobox").fill("tidy");
    await palette.getByRole("option", { name: "KalTidy: Stop idle terminals" }).click();
    await expect(page.getByText("Stopped 1 idle terminal. Kept 1 terminal in use.")).toBeVisible({ timeout: 20_000 });
    await shot(page, "e2e-kaltidy-toast");
    expect(processesMatching(PING).length).toBeGreaterThan(0);

    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(page.getByRole("tab", { name: /Command Prompt/ })).toBeVisible();

    await closeGracefully(app);
    await expect.poll(() => processesMatching(PING).length, { timeout: 20_000 }).toBe(0);
  } finally {
    removeDir(dataDir);
    removeDir(projectRoot);
  }
});
