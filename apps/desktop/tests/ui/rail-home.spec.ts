import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * Z7-W2: the workspace rail, the returning-user home, the project surface and the Session
 * Locator, against the in-memory transport (src/ipc/memory/rail.ts). Scenarios: `rail` (many
 * workspaces, threads across providers, no display name), `home` (the same, with the display
 * name "Kaleb"); without a scenario the transport is a first run.
 */

// Wide enough for the full rail (narrower windows start with the collapsed strip).
test.use({ viewport: { width: 1600, height: 900 } });

async function open(page: Page, scenario?: "rail" | "home") {
  await page.goto(scenario ? `/?scenario=${scenario}` : "/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
}

const tree = (page: Page) => page.getByRole("tree", { name: "Workspaces" });
const item = (page: Page, name: RegExp) => tree(page).getByRole("treeitem", { name });
const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name, exact: true });

async function goHome(page: Page) {
  await nav(page, "Home").click();
  await expect(page.locator("#main")).toHaveAttribute("data-surface", "home");
}

async function expectNoSeriousA11yViolations(page: Page, where: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    serious,
    `${where}: ${JSON.stringify(
      serious.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
      null,
      2,
    )}`,
  ).toEqual([]);
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await nav(page, "Settings").click();
  await page
    .getByRole("radiogroup", { name: "Theme" })
    .getByRole("radio", { name: theme === "light" ? "Light" : "Dark" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

test.describe("workspace rail", () => {
  test("groups pinned, folder and recent workspaces with provider rows, counts and badges", async ({ page }) => {
    await open(page, "rail");
    await expect(item(page, /^Pinned, 2$/)).toBeVisible();
    await expect(item(page, /^Folders, 2$/)).toBeVisible();
    await expect(item(page, /^Recent, \d+$/)).toBeVisible();
    await expect(item(page, /^Archived, 1$/)).toHaveAttribute("aria-expanded", "true");
    // The active workspace, its badges in words, and its tree of providers and threads.
    const kalcode = item(page, /^kalcode, active workspace/);
    await expect(kalcode).toHaveAttribute("aria-selected", "true");
    await expect(kalcode).toHaveAccessibleName("kalcode, active workspace, 1 needs you, 2 working");
    await expect(item(page, /^Claude Code, 2 threads, 2 working$/).first()).toBeVisible();
    await expect(item(page, /^Workspace rail persistence, working/)).toBeVisible();
    await expect(item(page, /^Folder surface Git status, waiting for you/)).toBeVisible();
    // A folder group and a missing folder, said plainly.
    await expect(item(page, /^Folder Client work, 2 workspaces$/)).toBeVisible();
    await expect(item(page, /^old-prototype, folder missing$/)).toBeVisible();
    // A collapsed workspace hides its threads.
    await expect(item(page, /^mobile-app/)).toHaveAttribute("aria-expanded", "false");
    await expect(item(page, /^Offline sync spike/)).toHaveCount(0);
  });

  test("is a keyboard tree: arrows move, Right and Left expand and collapse, Enter opens", async ({ page }) => {
    await open(page, "rail");
    const kalcode = item(page, /^kalcode, active workspace/);
    await kalcode.focus();
    await expect(kalcode).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const claude = item(page, /^Claude Code, 2 threads, 2 working$/);
    await expect(claude).toBeFocused();
    // Left on an open row closes it; Left again goes to the parent.
    await page.keyboard.press("ArrowLeft");
    await expect(claude).toHaveAttribute("aria-expanded", "false");
    await expect(item(page, /^Workspace rail persistence/)).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await expect(item(page, /^Workspace rail persistence/)).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(kalcode).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(kalcode).toHaveAttribute("aria-expanded", "false");
    await expect(claude).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await expect(kalcode).toHaveAttribute("aria-expanded", "true");
    await expect(claude).toBeVisible();
    // Enter on a workspace opens its project page.
    const atlas = item(page, /^atlas-api/);
    await atlas.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "atlas-api" })).toBeVisible();
    await expect(page.locator("#main")).toHaveAttribute("data-surface", "folder");
    await expect(item(page, /^atlas-api, active workspace/)).toBeVisible();
    // Enter on a thread opens it.
    await item(page, /^Authentication Refactor/).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toHaveAttribute("data-surface", "threads");
  });

  test("pins, renames, files into folders, archives, and removes only with explicit wording", async ({ page }) => {
    await open(page, "rail");
    // Unpin atlas-api from its menu (right click); it moves to Recent.
    await item(page, /^atlas-api/).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Unpin" }).click();
    await expect(item(page, /^Pinned, 1$/)).toBeVisible();
    // Rename it in the rail only (F2).
    await item(page, /^atlas-api/).focus();
    await page.keyboard.press("F2");
    const rename = page.getByRole("dialog", { name: "Rename in the rail" });
    await expect(rename).toContainText("The folder on disk keeps its name");
    await rename.getByRole("textbox", { name: "Name" }).fill("Atlas API (prod)");
    await rename.getByRole("button", { name: "Save name" }).click();
    await expect(item(page, /^Atlas API \(prod\)/)).toBeVisible();
    // Into the Client work folder.
    await item(page, /^Atlas API \(prod\)/).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to Client work" }).click();
    await expect(item(page, /^Folder Client work, 3 workspaces$/)).toBeVisible();
    // Archive hides it; unarchive brings it back.
    await item(page, /^Atlas API \(prod\)/).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Archive (hide from the rail)" }).click();
    await expect(item(page, /^Archived, 2$/)).toBeVisible();
    await item(page, /^Atlas API \(prod\)/).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Unarchive" }).click();
    await expect(item(page, /^Archived, 1$/)).toBeVisible();
    // Remove from KalCode: the dialog says files stay; cancelling changes nothing.
    await item(page, /^docs-site/).focus();
    await page.keyboard.press("Delete");
    const remove = page.getByRole("alertdialog", { name: "Remove “docs-site” from KalCode?" });
    await expect(remove).toContainText("Nothing is deleted.");
    await expect(remove).toContainText("stay on your disk");
    await remove.getByRole("button", { name: "Cancel" }).click();
    await expect(item(page, /^docs-site/)).toBeVisible();
    // Confirming removes it from the rail (and from KalCode's list).
    await item(page, /^docs-site/).focus();
    await page.keyboard.press("Delete");
    await page
      .getByRole("alertdialog", { name: "Remove “docs-site” from KalCode?" })
      .getByRole("button", { name: "Remove from KalCode" })
      .click();
    await expect(item(page, /^docs-site/)).toHaveCount(0);
    await expect(page.getByText("The folder and its files were not changed.")).toBeVisible();
  });

  test("new rail folders, collapse of sections and folders, and the collapsed strip", async ({ page }) => {
    await open(page, "rail");
    await page.getByRole("button", { name: "Add a workspace" }).click();
    await page.getByRole("menuitem", { name: "New rail folder…" }).click();
    const dialog = page.getByRole("dialog", { name: "New folder" });
    await dialog.getByRole("textbox", { name: "Folder name" }).fill("Side projects");
    await dialog.getByRole("button", { name: "Create folder" }).click();
    await expect(item(page, /^Folder Side projects, 0 workspaces$/)).toBeVisible();
    // Collapse a section.
    await item(page, /^Recent, \d+$/).click();
    await expect(item(page, /^Recent, \d+$/)).toHaveAttribute("aria-expanded", "false");
    await expect(item(page, /^data-pipeline/)).toHaveCount(0);
    // Hide the rail (Ctrl+Shift+B): a strip of tiles remains; show it again.
    await page.keyboard.press("Control+Shift+B");
    const strip = page.getByRole("navigation", { name: "Workspaces (collapsed rail)" });
    await expect(strip).toBeVisible();
    await expect(tree(page)).toHaveCount(0);
    await expect(strip.getByRole("button", { name: /^kalcode, active workspace/ })).toBeVisible();
    await strip.getByRole("button", { name: "Show the workspace rail" }).click();
    await expect(tree(page)).toBeVisible();
    await expect(item(page, /^Recent, \d+$/)).toHaveAttribute("aria-expanded", "false");
  });

  test("a narrow window starts with the strip; expanding it there lasts for the session", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await open(page, "rail");
    const strip = page.getByRole("navigation", { name: "Workspaces (collapsed rail)" });
    await expect(strip).toBeVisible();
    await strip.getByRole("button", { name: "Show the workspace rail" }).click();
    await expect(tree(page)).toBeVisible();
    await nav(page, "Threads").click();
    await expect(tree(page)).toBeVisible();
    await page.setViewportSize({ width: 1600, height: 900 });
    await expect(tree(page)).toBeVisible();
  });

  test("rail search runs on the Session Locator and opens what it finds", async ({ page }) => {
    await open(page, "rail");
    await page.getByRole("searchbox", { name: "Find a workspace or thread" }).fill("auth");
    const results = page.getByRole("list", { name: "Search results" });
    await expect(results.getByRole("button").first()).toContainText("Authentication Refactor");
    await results.getByRole("button", { name: /Authentication Refactor/ }).click();
    await expect(page.locator("#main")).toHaveAttribute("data-surface", "threads");
    await expect(page.getByRole("searchbox", { name: "Find a workspace or thread" })).toHaveValue("");
  });
});

test.describe("home", () => {
  test("a first run is honest, greets without a name and shows the next steps", async ({ page }) => {
    await open(page);
    await goHome(page);
    await expect(page.getByRole("heading", { level: 1, name: "Welcome to KalCode." })).toBeVisible();
    await expect(page.getByText("Nothing has run yet. This page fills in as you work.")).toBeVisible();
    const steps = page.getByRole("list", { name: "Get started" });
    await expect(steps.getByRole("heading")).toHaveText([
      "Open a project folder",
      "Connect a provider",
      "Start a thread",
    ]);
    // No invented activity anywhere.
    await expect(page.getByRole("region", { name: /Running now|Needs you/ })).toHaveCount(0);
  });

  test("returning: greets by the Settings display name and summarises real state", async ({ page }) => {
    await open(page, "home");
    await goHome(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Kaleb");
    await expect(page.getByText("3 threads need you · 3 working · 1 finished since your last visit")).toBeVisible();
    const needs = page.getByRole("list", { name: "Needs you" });
    await expect(needs.getByRole("button")).toHaveCount(3);
    await expect(needs).toContainText("Rate limiter for login");
    await expect(needs).toContainText("Permission required");
    await expect(page.getByRole("list", { name: "Running now" }).getByRole("button")).toHaveCount(3);
    await expect(page.getByRole("list", { name: "Finished since your last visit" })).toContainText("Greeting rotation");
    await expect(page.getByRole("list", { name: "Pick up where you left off" })).toContainText("Invoice PDF layout");
    const workspaces = page.getByRole("list", { name: "Recent workspaces" });
    await expect(workspaces.getByRole("button", { name: "Continue in kalcode" })).toBeVisible();
    // Recent work by day, from the event log.
    await expect(page.getByRole("list", { name: "Recent work, today" })).toContainText("Authentication Refactor");
    await page.getByRole("tab", { name: "Yesterday" }).click();
    const yesterday = page.getByRole("list", { name: "Recent work, yesterday" });
    await expect(yesterday).toContainText("Invoice PDF layout");
    await expect(yesterday).toContainText("src/invoice/pdf.ts");
    // Continue takes you back to work in that workspace.
    await workspaces.getByRole("button", { name: "Continue in atlas-api" }).click();
    await expect(page.locator("#main")).toHaveAttribute("data-surface", "code");
  });

  test("with no display name the greeting is exactly “Welcome back.”", async ({ page }) => {
    await open(page, "rail");
    await goHome(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome back.");
  });

  test("the greeting rotates and never repeats one of the last five", async ({ page }) => {
    await open(page, "home");
    const shown: string[] = [];
    for (let visit = 0; visit < 12; visit++) {
      await goHome(page);
      const greeting = (await page.getByRole("heading", { level: 1 }).textContent()) ?? "";
      expect(greeting).toContain("Kaleb");
      expect(shown.slice(-5), `visit ${visit}: ${greeting}`).not.toContain(greeting);
      shown.push(greeting);
      await nav(page, "Dashboard").click();
    }
  });

  test("the display name is set in Settings, validated, and clearing it returns to “Welcome back.”", async ({
    page,
  }) => {
    await open(page, "rail");
    await nav(page, "Settings").click();
    const profile = page.getByRole("region", { name: "Profile" });
    const field = profile.getByRole("textbox", { name: "Display name" });
    await field.fill("x".repeat(61));
    await expect(profile.getByRole("alert")).toHaveText("Use at most 60 characters.");
    await expect(profile.getByRole("button", { name: "Save" })).toBeDisabled();
    await field.fill("Ada");
    await profile.getByRole("button", { name: "Save" }).click();
    await expect(profile.getByRole("status")).toHaveText("Saved");
    await goHome(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Ada");
    await nav(page, "Settings").click();
    await page.getByRole("region", { name: "Profile" }).getByRole("button", { name: "Clear" }).click();
    await goHome(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome back.");
  });
});

test.describe("project surface", () => {
  test("shows files by handle, Git status, recent files, threads and the message-search opt-in", async ({ page }) => {
    await open(page, "rail");
    await item(page, /^atlas-api/).click();
    await expect(page.getByRole("heading", { level: 1, name: "atlas-api" })).toBeVisible();
    await expect(page.getByText("feature/oauth-race").first()).toBeVisible();
    // Files: folders first; ignored entries labelled; folders open by keyboard.
    const files = page.getByRole("tree", { name: "Files" });
    await expect(files.getByRole("treeitem", { name: "node_modules, folder, ignored" })).toBeVisible();
    const src = files.getByRole("treeitem", { name: "src, folder" });
    await src.focus();
    await page.keyboard.press("ArrowRight");
    await expect(src).toHaveAttribute("aria-expanded", "true");
    await expect(files.getByRole("treeitem", { name: "auth, folder" })).toBeVisible();
    // Git status in words, not only letters.
    const changes = page.getByRole("list", { name: "Changed files" });
    await expect(changes).toContainText("modified: src/auth/callback.ts");
    await expect(changes).toContainText("untracked: docs/notes-draft.md");
    await expect(page.getByRole("list", { name: "Recent commits" })).toContainText("Check the OAuth state");
    await expect(page.getByRole("list", { name: "Files changed by threads" })).toContainText("src/auth/callback.ts");
    await expect(page.getByRole("list", { name: "Threads in this workspace" })).toContainText(
      "Authentication Refactor",
    );
    await expect(page.getByRole("region", { name: "Also in this workspace" })).toContainText("arrive with Agents");
    // Message-text search is off by default and can be turned on.
    const optIn = page.getByRole("checkbox", { name: /Search message text in this workspace/ });
    await expect(optIn).not.toBeChecked();
    await optIn.check();
    await expect(optIn).toBeChecked();
  });

  test("a plain folder says it isn't a Git repository", async ({ page }) => {
    await open(page, "rail");
    await item(page, /^design-notes/).click();
    await expect(page.getByText("This folder isn't a Git repository.")).toBeVisible();
  });
});

test.describe("search", () => {
  test("the palette finds “auth” → Authentication Refactor first, and Enter opens it", async ({ page }) => {
    await open(page, "rail");
    await page.keyboard.press("Control+k");
    await page.keyboard.type("auth");
    const first = page.getByRole("option").first();
    await expect(first).toContainText("Authentication Refactor");
    await expect(first).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Also matching authentication")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toHaveAttribute("data-surface", "threads");
  });

  test("filter words become filters and the kind filter narrows", async ({ page }) => {
    await open(page, "rail");
    await page.keyboard.press("Control+k");
    await page.keyboard.type("codex waiting");
    await expect(page.getByRole("option").first()).toContainText("Rate limiter for login");
    await expect(page.getByText("Filters")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Workspaces", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Workspaces", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByText("Nothing in threads, workspaces, terminals or activity matches that.")).toBeVisible();
  });

  test("KalVoice “search for auth” opens the palette with the query", async ({ page }) => {
    await open(page, "rail");
    await nav(page, "KalVoice").click();
    const box = page.getByRole("main").getByRole("textbox", { name: "Type a request for KalVoice" });
    await box.fill("search for auth");
    await box.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox")).toHaveValue("auth");
    await expect(page.getByRole("option").first()).toContainText("Authentication Refactor");
  });
});

test.describe("in panes (Z7-W1 pane system)", () => {
  async function command(page: Page, name: string) {
    await page.keyboard.press("Control+k");
    await page.keyboard.type(name);
    await page.getByRole("option", { name }).click();
  }

  test("Home, the project page, Git status and the workspace list open as pane contents", async ({ page }) => {
    await open(page, "home");
    // Home in a pane: its greeting steps down to h2; the page keeps a single h1 (Code's).
    await command(page, "Show Home in a pane");
    await expect(page.locator("#main")).toHaveAttribute("data-surface", "code");
    await expect(page.getByRole("tab", { name: /^Home/ })).toHaveAttribute("aria-selected", "true");
    const home = page.getByRole("tabpanel", { name: "Home" });
    await expect(home.getByRole("heading", { level: 2 }).first()).toContainText("Kaleb");
    await expect(home.getByRole("region", { name: "Recent workspaces" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

    // The project page of another workspace, from the rail's menu, in a pane of that workspace.
    await item(page, /^atlas-api/).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open project in a pane" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "atlas-api" })).toBeVisible();
    // The menu is gone although the active workspace changed while it closed.
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /^Project/ })).toHaveAttribute("aria-selected", "true");
    const project = page.getByRole("tabpanel", { name: "Project" });
    await expect(project.getByRole("heading", { level: 2, name: "atlas-api" })).toBeVisible();
    await expect(project.getByRole("list", { name: "Changed files" })).toContainText("modified: src/auth/callback.ts");
    await expect(project.getByRole("button", { name: "Open in Code" })).toHaveCount(0);

    // Its Git status in a pane of its own (read-only), beside it.
    await project.getByRole("button", { name: "Open Git status in a pane" }).click();
    await expect(page.getByRole("tab", { name: /^Git/ })).toHaveAttribute("aria-selected", "true");
    const git = page.getByRole("tabpanel", { name: "Git" });
    await expect(git.getByRole("list", { name: "Changed files" })).toContainText("untracked: docs/notes-draft.md");
    await expect(git.getByRole("list", { name: "Recent commits" })).toContainText("Check the OAuth state");

    // The workspace list in a pane works like the rail.
    await command(page, "Show workspaces in a pane");
    const list = page.getByRole("tree", { name: "Workspaces in this pane" });
    await expect(list.getByRole("treeitem", { name: /^Pinned, 2$/ })).toBeVisible();
    await expect(list.getByRole("treeitem", { name: /^atlas-api, active workspace/ })).toBeVisible();
  });

  for (const theme of ["dark", "light"] as const) {
    test(`axe is clean with Home, the project page and Git status in panes (${theme})`, async ({ page }) => {
      await open(page, "home");
      await setTheme(page, theme);
      await item(page, /^atlas-api/).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Open project in a pane" }).click();
      await expect(page.getByRole("tab", { name: /^Project/ })).toBeVisible();
      await command(page, "Show Home in a pane");
      await expect(page.getByRole("tab", { name: /^Home/ })).toBeVisible();
      await command(page, "Show Git status in a pane");
      await expect(page.getByRole("tab", { name: /^Git/ })).toBeVisible();
      await expect(
        page.getByRole("tabpanel", { name: "Git" }).getByRole("list", { name: "Local branches" }),
      ).toBeVisible();
      await expectNoSeriousA11yViolations(page, "surfaces in panes");
    });
  }
});

test.describe("accessibility", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`axe is clean on the rail, home, project page and search (${theme})`, async ({ page }) => {
      await open(page, "home");
      await setTheme(page, theme);
      await expectNoSeriousA11yViolations(page, "settings with the profile");
      await goHome(page);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Kaleb");
      await expectNoSeriousA11yViolations(page, "home + rail");
      await item(page, /^atlas-api/).click();
      await expect(page.getByRole("heading", { level: 1, name: "atlas-api" })).toBeVisible();
      await expect(page.getByRole("list", { name: "Changed files" })).toBeVisible();
      await expectNoSeriousA11yViolations(page, "project page");
      await page.keyboard.press("Control+k");
      await page.keyboard.type("auth");
      await expect(page.getByRole("option").first()).toContainText("Authentication Refactor");
      await expectNoSeriousA11yViolations(page, "palette with results");
      await page.keyboard.press("Escape");
      await item(page, /^atlas-api/).click({ button: "right" });
      await expect(page.getByRole("menu")).toBeVisible();
      await expectNoSeriousA11yViolations(page, "workspace actions menu");
    });

    test(`axe is clean on a first run (${theme})`, async ({ page }) => {
      await open(page);
      await setTheme(page, theme);
      await goHome(page);
      await expect(page.getByRole("heading", { level: 1, name: "Welcome to KalCode." })).toBeVisible();
      await expectNoSeriousA11yViolations(page, "first-run home + empty rail");
    });
  }
});
