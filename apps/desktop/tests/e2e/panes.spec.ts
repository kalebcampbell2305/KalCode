import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import {
  closeGracefully,
  EXE,
  killForcibly,
  launch,
  processesMatching,
  RESOURCE_PROVIDER_FIXTURE_OPT_IN,
  removeDir,
  test,
  waitForProviderAdmission,
  writeManagedFakeProviderConfig,
} from "./harness.ts";

/**
 * Z7-W1 end to end against the real app: arrange a pane layout (real shells in real PTYs and a
 * provider pane running the FAKE provider CLI), quit KalCode, relaunch, and find the same layout
 * restored from the layout store (`workspace_layouts`, schema v9): pane count, divider position,
 * a collapsed pane and every tab, with ended shells offering Restart and the provider pane shown
 * as ended in an earlier run. Then a change followed by a forced kill is restored too. Closing a
 * pane ends its terminals and agents; reopening restores only its pane slot.
 *
 * The provider is `kalcode-fake-provider` copied as `claude.exe` first on PATH; no AI service is
 * contacted. Build first: pnpm --filter @kalcode/desktop build:e2e (KALCODE_E2E_CDP_PORT=9451).
 */
test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

const FAKE = join(dirname(EXE), "kalcode-fake-provider.exe");
const HELPER = join(dirname(EXE), "kalcode-hook.exe");
test.skip(!existsSync(FAKE) || !existsSync(HELPER), "Run build:e2e: it builds kalcode-hook and the fake provider.");

const codeNav = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true });
const panes = (page: Page) => page.locator("[data-pane-id]:not([hidden])");
const pane = (page: Page, n: number) => panes(page).nth(n);
// The pane splitter ("Resize pane 1 and pane 2"), not other separators in the shell.
const divider = (page: Page) => page.getByRole("separator", { name: /^Resize / }).first();

async function shot(page: Page, name: string) {
  const dir = fileURLToPath(new URL("../../qa/screenshots/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

function python(script: string, ...args: string[]): string {
  return execFileSync("python", ["-c", script, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

/** The stored layout row (read-only, while the app is closed). */
function storedLayout(dataDir: string): { rows: number; version: number; panes: number } {
  const out = python(
    `import json,sqlite3,sys
c=sqlite3.connect(sys.argv[1])
rows=c.execute("SELECT schema_version, layout FROM workspace_layouts").fetchall()
def leaves(n): return 1 if n["kind"]=="leaf" else sum(leaves(x) for x in n["children"])
print(len(rows), rows[0][0] if rows else 0, leaves(json.loads(rows[0][1])["root"]) if rows else 0)`,
    join(dataDir, "kalcode.db"),
  );
  const [rows, version, count] = out.split(" ").map(Number);
  return { rows: rows ?? 0, version: version ?? 0, panes: count ?? 0 };
}

test("a pane layout is saved per workspace and restored after a graceful quit and after a forced kill", async () => {
  test.setTimeout(300_000);
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-w1-"));
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-w1-project-"));
  const project = join(root, "w1-panes");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# w1 panes\n");
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
    let app = await launch(dataDir, env);
    let page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await codeNav(page).click();
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "w1-panes" })).toBeVisible();
    await expect(panes(page)).toHaveCount(1);
    // Room for the keyboard resize: the gate's service desktop clamps the 1360 px window toward its
    // 960 px minimum, where the rail and sidebar leave a ~612 px canvas and two 320 px minimum panes
    // cannot move at all. With the sidebar collapsed the canvas keeps room at any allowed size.
    await page.keyboard.press("Control+B");
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

    // Pane 1: a real shell.
    await page.getByRole("button", { name: /^New .+ terminal$/ }).click();
    await expect(pane(page, 0).locator('[role="tabpanel"] .xterm-rows')).toContainText("w1-panes", {
      timeout: 30_000,
    });
    // Pane 2 (split right): the provider CLI in a PTY (the fake).
    await page.keyboard.press("Control+Alt+d");
    await expect(panes(page)).toHaveCount(2);
    await waitForProviderAdmission(page);
    await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("button", { name: "Launch Claude Code agent" })
      .click();
    const provider = page.locator("[data-provider-pane]").first();
    await expect(provider.locator("[data-pane-terminal] .xterm-rows")).toContainText(
      "KalCode fake provider (interactive)",
      { timeout: 30_000 },
    );
    // Pane 3 (split pane 2 down): a second shell.
    await page.keyboard.press("Control+Alt+Shift+D");
    await expect(panes(page)).toHaveCount(3);
    await pane(page, 2)
      .getByRole("button", { name: /^New .+ terminal$/ })
      .click();
    await expect(pane(page, 2).locator('[role="tabpanel"] .xterm-rows')).toContainText("w1-panes", {
      timeout: 30_000,
    });

    // Resize the first divider with the keyboard, and collapse pane 3.
    // A just-started terminal can take focus when it becomes ready; make sure the divider holds it
    // before resizing (on the gate the keys once went elsewhere and the ratio stayed 50).
    await divider(page).focus();
    await expect(divider(page)).toBeFocused();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(async () => Number(await divider(page).getAttribute("aria-valuenow"))).toBeGreaterThan(55);
    const arrangedRatio = await divider(page).getAttribute("aria-valuenow");
    await pane(page, 2).getByRole("button", { name: "Actions for pane 3" }).click();
    await page.getByRole("menuitem", { name: "Collapse" }).click();
    await expect(page.locator("[data-pane-id][data-collapsed]")).toHaveCount(1);
    await shot(page, "w1-e2e-arranged");

    // Closing a pane ends what it runs (owner decision): the shell in pane 1 and the program it
    // started stop; nothing keeps running in the background. Reopen brings back only the pane.
    await page.keyboard.press("Control+Alt+ArrowLeft");
    await pane(page, 0).locator(".xterm-screen").click();
    await page.keyboard.type("ping -n 97 127.0.0.1");
    await page.keyboard.press("Enter");
    await expect.poll(() => processesMatching("-n 97 127.0.0.1").length, { timeout: 20_000 }).toBeGreaterThan(0);
    await pane(page, 0).getByRole("button", { name: "Close pane 1" }).click();
    // Smart Close (#222) asks before closing a pane with a running program; stop it.
    await page
      .getByRole("alertdialog", { name: "Close active work?" })
      .getByRole("button", { name: "Stop and Close", exact: true })
      .click();
    await expect(panes(page)).toHaveCount(2);
    await expect.poll(() => processesMatching("-n 97 127.0.0.1").length, { timeout: 20_000 }).toBe(0);
    await expect(page.getByRole("button", { name: /in background/ })).toHaveCount(0);
    await page.keyboard.press("Control+Alt+r");
    await expect(panes(page)).toHaveCount(3);
    await expect(divider(page)).toHaveAttribute("aria-valuenow", arrangedRatio ?? "");

    // The reopened slot, provider pane and collapsed shell are the graceful-restart layout.
    // The debounced save lands before quitting: poll the stored layout instead of a fixed wait.
    await expect.poll(() => storedLayout(dataDir).panes, { timeout: 20_000 }).toBe(3);
    await closeGracefully(app);

    const stored = storedLayout(dataDir);
    expect(stored).toEqual({ rows: 1, version: 1, panes: 3 });

    // Relaunch opens the restored workspace directly in Code, with the same layout, ended shells
    // offering Restart and the provider pane ended.
    app = await launch(dataDir, env);
    page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "w1-panes" })).toBeVisible();
    await expect(panes(page)).toHaveCount(3);
    await expect(divider(page)).toHaveAttribute("aria-valuenow", arrangedRatio ?? "");
    await expect(page.locator("[data-pane-id][data-collapsed]")).toHaveCount(1);
    await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
    await expect(page.locator("[data-provider-pane] [data-pane-terminal] .xterm-rows")).toContainText(
      "ended in an earlier run",
      { timeout: 20_000 },
    );
    // Pane 1's shell ended when its pane closed, so its restored slot is empty. The collapsed
    // pane's shell ended with KalCode and offers Restart.
    await expect(pane(page, 0).getByRole("heading", { name: "Empty pane" })).toBeVisible();
    await page
      .locator("[data-pane-id][data-collapsed]")
      .getByRole("button", { name: /^Expand / })
      .click();
    await expect(pane(page, 2).getByRole("heading", { name: "This terminal ended when KalCode closed" })).toBeVisible();
    await shot(page, "w1-e2e-restored");

    // A change, then a forced kill: the layout saved after the change is what comes back.
    await page.keyboard.press("Control+Alt+2");
    await expect(panes(page)).toHaveCount(2);
    // The forced kill must come after the debounced save of this change, however long it takes.
    await expect.poll(() => storedLayout(dataDir).panes, { timeout: 20_000 }).toBe(2);
    await killForcibly(app);
    expect(storedLayout(dataDir).panes).toBe(2);

    app = await launch(dataDir, env);
    page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "w1-panes" })).toBeVisible();
    await expect(panes(page)).toHaveCount(2);
    await shot(page, "w1-e2e-restored-after-kill");
    await closeGracefully(app);
    expect(processesMatching(bin), "no provider process outlives KalCode").toEqual([]);
  } finally {
    removeDir(dataDir);
    removeDir(root);
  }
});
