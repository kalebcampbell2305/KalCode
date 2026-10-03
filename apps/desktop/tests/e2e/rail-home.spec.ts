import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { ACCOUNT_KALVOICE_FIXTURE_OPT_IN, closeGracefully, EXE, launch, removeDir, test } from "./harness.ts";

/**
 * Z7-W2 end to end against the real app: workspaces made from the rail, pinned, renamed in the
 * rail, filed into a rail folder, and a display name set in Settings — all still there after a
 * relaunch; the Session Locator finds a workspace by what you type, in the real index; removing a
 * workspace from KalCode leaves its folder on disk.
 *
 * Schema v11 (rail + locator) is a registered migration, so the real database persists it.
 * Build first: pnpm --filter @kalcode/desktop build:e2e; run with KALCODE_E2E_CDP_PORT=9452.
 */
test.skip(process.platform !== "win32", "Real-app E2E drives WebView2 and runs on Windows.");
test.skip(!existsSync(EXE), `Build the app first: ${EXE}`);

const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name, exact: true });
const tree = (page: Page) => page.getByRole("tree", { name: "Workspaces" });
const item = (page: Page, name: RegExp) => tree(page).getByRole("treeitem", { name });

async function shot(page: Page, name: string) {
  const dir = fileURLToPath(new URL("../../qa/screenshots/w2/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

/** Narrow windows (under 1400 px) start with the rail as a strip; open it. */
async function showRail(page: Page) {
  const strip = page.getByRole("navigation", { name: "Workspaces (collapsed rail)" });
  await expect(tree(page).or(strip).first()).toBeVisible();
  if ((await strip.count()) > 0) await strip.getByRole("button", { name: "Show the workspace rail" }).click();
  await expect(page.getByRole("complementary", { name: "Workspace rail" })).toBeVisible();
}

async function newWorkspace(page: Page, name: string) {
  await page.getByRole("button", { name: "Add a workspace" }).click();
  await page.getByRole("menuitem", { name: "New workspace…" }).click();
  const dialog = page.getByRole("dialog", { name: "New workspace" });
  await dialog.getByRole("textbox", { name: "Folder name" }).fill(name);
  await dialog.getByRole("button", { name: "Choose location…" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(item(page, new RegExp(`^${name}, active workspace`))).toBeVisible();
}

async function invoke<T>(page: Page, command: string, args?: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    ([name, payload]) => {
      const internals = (
        window as typeof window & {
          __TAURI_INTERNALS__: { invoke<R>(command: string, args?: Record<string, unknown>): Promise<R> };
        }
      ).__TAURI_INTERNALS__;
      return internals.invoke<T>(name, payload);
    },
    [command, args] as const,
  );
}

test("the rail persists across a relaunch and the Session Locator finds a workspace", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(join(tmpdir(), "kalcode-e2e-w2-"));
  const root = mkdtempSync(join(tmpdir(), "kalcode-e2e-w2-projects-"));
  // New workspaces are created inside the folder the (test-build) picker returns.
  // Several workspaces: a verified Pro account (Free allows two).
  const env = { KALCODE_E2E_ACCOUNT_FIXTURE: ACCOUNT_KALVOICE_FIXTURE_OPT_IN, KALCODE_E2E_PICK_FOLDER: root };

  try {
    // ---- First session: build up the rail.
    let app = await launch(dataDir, env);
    let page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await showRail(page);
    await expect(page.getByText("No workspaces yet")).toBeVisible();

    await newWorkspace(page, "alpha-app");
    await newWorkspace(page, "beta-service");
    await newWorkspace(page, "gamma-notes");
    expect(existsSync(join(root, "beta-service"))).toBe(true);

    // Pin alpha-app; rename beta-service in the rail; make a rail folder and file beta into it.
    await item(page, /^alpha-app/).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin" }).click();
    await expect(item(page, /^Pinned, 1$/)).toBeVisible();
    await item(page, /^beta-service/).focus();
    await page.keyboard.press("F2");
    const rename = page.getByRole("dialog", { name: "Rename in the rail" });
    await rename.getByRole("textbox", { name: "Name" }).fill("Beta billing");
    await rename.getByRole("button", { name: "Save name" }).click();
    await expect(item(page, /^Beta billing/)).toBeVisible();
    await item(page, /^Beta billing/).click({ button: "right" });
    await page.getByRole("menuitem", { name: "New folder with this workspace…" }).click();
    const folder = page.getByRole("dialog", { name: "New folder" });
    await folder.getByRole("textbox", { name: "Folder name" }).fill("Clients");
    await folder.getByRole("button", { name: "Create folder" }).click();
    await expect(item(page, /^Folder Clients, 1 workspace$/)).toBeVisible();
    // Archive gamma-notes (hidden, not deleted).
    await item(page, /^gamma-notes/).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Archive (hide from the rail)" }).click();
    await expect(item(page, /^Archived, 1$/)).toBeVisible();

    // A display name, from Settings only.
    await nav(page, "Settings").click();
    const profile = page.getByRole("region", { name: "Profile" });
    await profile.getByRole("textbox", { name: "Display name" }).fill("Kaleb");
    await profile.getByRole("button", { name: "Save" }).click();
    await expect(profile.getByRole("status")).toHaveText("Saved");
    await nav(page, "Home").click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Kaleb");
    await shot(page, "e2e-home-session-1");
    const activeBeforeRestart = await invoke<{ id: string; name: string } | null>(page, "workspace_active");
    if (!activeBeforeRestart) throw new Error("The rail fixture did not retain an active workspace");
    await closeGracefully(app);

    // ---- Relaunch: everything is where it was.
    app = await launch(dataDir, env);
    page = app.page;
    await expect(page.getByRole("heading", { level: 1, name: activeBeforeRestart.name })).toBeVisible();
    const activeAfterRestart = await invoke<{ id: string } | null>(page, "workspace_active");
    expect(activeAfterRestart?.id).toBe(activeBeforeRestart.id);
    await showRail(page);
    await expect(item(page, /^Pinned, 1$/)).toBeVisible();
    const pinnedFirst = tree(page).getByRole("treeitem").nth(1);
    await expect(pinnedFirst).toHaveAccessibleName(/^alpha-app/);
    await expect(item(page, /^Folder Clients, 1 workspace$/)).toBeVisible();
    await expect(item(page, /^Beta billing/)).toBeVisible();
    await expect(item(page, /^Archived, 1$/)).toBeVisible();
    await expect(item(page, /^gamma-notes/)).toBeVisible();
    await nav(page, "Home").click();
    const greeting = page.getByRole("heading", { level: 1 });
    await expect(greeting).toContainText("Kaleb");
    await shot(page, "e2e-home-relaunch");

    // ---- The Session Locator, in the real app: "billing" finds the renamed workspace.
    await page.keyboard.press("Control+k");
    await page.keyboard.type("billing");
    const first = page.getByRole("option").first();
    await expect(first).toContainText("Beta billing", { timeout: 15_000 });
    await expect(first).toHaveAttribute("aria-selected", "true");
    await shot(page, "e2e-locator-billing");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "beta-service" })).toBeVisible();
    // Rail search runs on the same index.
    await page.getByRole("searchbox", { name: "Find a workspace or thread" }).fill("alpha");
    await expect(page.getByRole("list", { name: "Search results" })).toContainText("alpha-app");
    await page.getByRole("searchbox", { name: "Find a workspace or thread" }).fill("");

    // ---- The project page of the active workspace, from the rail (real files by handle).
    await item(page, /^alpha-app/).click();
    await expect(page.getByRole("heading", { level: 1, name: "alpha-app" })).toBeVisible();
    await expect(page.getByText("This folder is empty.")).toBeVisible();
    await shot(page, "e2e-project");

    // ---- Remove from KalCode: the folder stays on disk.
    await item(page, /^alpha-app/).focus();
    await page.keyboard.press("Delete");
    await page
      .getByRole("alertdialog", { name: "Remove “alpha-app” from KalCode?" })
      .getByRole("button", { name: "Remove from KalCode" })
      .click();
    await expect(item(page, /^alpha-app/)).toHaveCount(0);
    expect(existsSync(join(root, "alpha-app"))).toBe(true);
    await closeGracefully(app);
  } finally {
    removeDir(dataDir);
    removeDir(root);
  }
});
