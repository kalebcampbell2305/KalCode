import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * Code surface (Z1) against the in-memory runtime: workspaces from the (fake) native folder
 * picker, terminal tabs backed by a fake shell, keyboard flows and accessibility.
 */

const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function open(page: Page, scenario?: string) {
  await page.goto(scenario ? `/?scenario=${scenario}` : "/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
}

async function goToCode(page: Page) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
}

/** Text of the terminal in front. */
const visibleTerminal = (page: Page) => page.locator('[role="tabpanel"]:not([hidden]) .xterm-rows');

async function queueFolders(page: Page, ...folders: (string | null)[]) {
  await page.evaluate((list) => {
    (
      window as unknown as { __kalcodeMemory: { queueFolders: (...f: (string | null)[]) => void } }
    ).__kalcodeMemory.queueFolders(...list);
  }, folders);
}

async function runningProcesses(page: Page): Promise<number> {
  return page.evaluate(() =>
    (
      window as unknown as { __kalcodeMemory: { runningProcessCount: () => number } }
    ).__kalcodeMemory.runningProcessCount(),
  );
}

async function openFolderAndTerminal(page: Page, folder = "kalcode-site") {
  await queueFolders(page, folder);
  await goToCode(page);
  await page.getByRole("button", { name: "Open folder…" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: folder })).toBeVisible();
  await page.getByRole("button", { name: /^New PowerShell 7 terminal$/ }).click();
  await expect(page.getByRole("tab", { name: /PowerShell 7/ })).toHaveAttribute("aria-selected", "true");
  await expect(visibleTerminal(page)).toContainText(`PS C:\\Users\\you\\Projects\\${folder}>`);
}

async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    serious,
    JSON.stringify(
      serious.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
      null,
      2,
    ),
  ).toEqual([]);
}

test.describe("opening a workspace", () => {
  test("the empty state opens a folder through the native picker", async ({ page }) => {
    await open(page);
    await goToCode(page);
    await expect(page.getByRole("heading", { level: 1, name: "Code" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Open a project folder" })).toBeVisible();
    await queueFolders(page, "kalcode-site");
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
    await expect(page.getByText("~\\Projects\\kalcode-site", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No terminals open" })).toBeVisible();
    // The sidebar switcher follows the active workspace.
    await expect(page.getByRole("button", { name: /Workspace\s*kalcode-site/ })).toBeVisible();
  });

  test("cancelling the picker changes nothing", async ({ page }) => {
    await open(page);
    await goToCode(page);
    await queueFolders(page, null);
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { name: "Open a project folder" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent workspaces" })).toHaveCount(0);
  });

  test("workspace events appear in the activity feed", async ({ page }) => {
    await open(page);
    await openFolderAndTerminal(page);
    await page.getByRole("button", { name: "Dashboard" }).click();
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity.getByText("Workspace added")).toBeVisible();
    await expect(activity.getByText("Terminal started")).toBeVisible();
  });
});

test.describe("terminals", () => {
  test("runs commands, keeps focus in the terminal and survives navigation", async ({ page }) => {
    await open(page);
    await openFolderAndTerminal(page);
    // Focus moved into the new terminal: typing goes to the shell.
    await page.keyboard.type("echo hello-from-ui");
    await page.keyboard.press("Enter");
    await expect(visibleTerminal(page)).toContainText("hello-from-ui\n", { useInnerText: true });
    await expect(visibleTerminal(page)).toContainText("hello-from-ui");

    // Navigating away detaches; coming back replays the scrollback.
    await page.getByRole("button", { name: "Dashboard" }).click();
    await goToCode(page);
    await expect(visibleTerminal(page)).toContainText("hello-from-ui");
  });

  test("multiple tabs: shell picker, switching with Ctrl+Tab, closing ends the process", async ({ page }) => {
    await open(page);
    await openFolderAndTerminal(page);
    await page.getByRole("button", { name: "Choose a shell" }).click();
    await page.getByRole("menuitem", { name: /Command Prompt/ }).click();
    const cmd = page.getByRole("tab", { name: /Command Prompt/ });
    await expect(cmd).toHaveAttribute("aria-selected", "true");
    await expect(visibleTerminal(page)).toContainText("Microsoft Windows");
    await page.keyboard.type("echo in-cmd");
    await page.keyboard.press("Enter");
    await expect(visibleTerminal(page)).toContainText("in-cmd");

    // A second tab of the same shell is numbered.
    await page.getByRole("button", { name: "New terminal" }).click();
    await expect(page.getByRole("tab", { name: /PowerShell 7 \(2\)/ })).toHaveAttribute("aria-selected", "true");
    expect(await runningProcesses(page)).toBe(3);

    await page.keyboard.press("Control+Tab");
    await expect(page.getByRole("tab", { name: /^PowerShell 7$/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Control+Shift+Tab");
    await expect(page.getByRole("tab", { name: /PowerShell 7 \(2\)/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Control+Shift+Tab");
    await expect(cmd).toHaveAttribute("aria-selected", "true");
    await expect(visibleTerminal(page)).toContainText("in-cmd");

    // Ctrl+Shift+W closes the tab in front and ends its process; the neighbour comes forward.
    await page.keyboard.press("Control+Shift+W");
    await expect(cmd).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /PowerShell 7 \(2\)/ })).toHaveAttribute("aria-selected", "true");
    expect(await runningProcesses(page)).toBe(2);

    // The close control on a tab.
    await page.getByRole("tab", { name: /^PowerShell 7$/ }).hover();
    await page
      .getByRole("tab", { name: /^PowerShell 7$/ })
      .locator('[class*="tabClose"]')
      .click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    expect(await runningProcesses(page)).toBe(1);
  });

  test("an exited shell shows its exit code and restarts in the same tab", async ({ page }) => {
    await open(page);
    await openFolderAndTerminal(page);
    await page.keyboard.type("exit 3");
    await page.keyboard.press("Enter");
    const panel = page.locator('[role="tabpanel"]:not([hidden])');
    await expect(panel.getByRole("status")).toContainText("Exited with code 3");
    await expect(page.getByRole("tab", { name: /PowerShell 7\s*Ended/ })).toBeVisible();

    await panel.getByRole("button", { name: "Restart" }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(page.getByRole("tab", { name: /Ended/ })).toHaveCount(0);
    await expect(visibleTerminal(page)).not.toContainText("exit 3");
    await page.keyboard.type("echo after-restart");
    await page.keyboard.press("Enter");
    await expect(visibleTerminal(page)).toContainText("after-restart");
    const activity = async () => {
      await page.getByRole("button", { name: "Dashboard" }).click();
      return page.getByRole("region", { name: "Activity" });
    };
    await expect((await activity()).getByText("Terminal exited with an error")).toBeVisible();
  });

  test("tabs restored after KalCode closed offer Restart", async ({ page }) => {
    await open(page, "code");
    await page.getByRole("button", { name: /^Workspace\s/ }).click();
    await page.getByRole("menuitemradio", { name: /api-server/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "api-server" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "This terminal ended when KalCode closed" })).toBeVisible();
    await page.getByRole("button", { name: "Restart" }).click();
    await expect(visibleTerminal(page)).toContainText("PS C:\\Users\\you\\Projects\\api-server>");
  });
});

test.describe("keyboard", () => {
  test("Ctrl+Shift+` opens a terminal from anywhere and focus can leave the terminal", async ({ page }) => {
    await open(page, "code");
    await expect(page.getByRole("region", { name: "Terminals" }).getByText("Git Bash")).toBeVisible();
    await page.keyboard.press("Control+Shift+Backquote");
    await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /PowerShell 7 \(2\)/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.type("echo typed-after-shortcut");
    await page.keyboard.press("Enter");
    await expect(visibleTerminal(page)).toContainText("typed-after-shortcut");

    // Ctrl+Shift+E leaves the terminal for its tab; arrow keys move between tabs.
    await page.keyboard.press("Control+Shift+E");
    await expect(page.getByRole("tab", { name: /PowerShell 7 \(2\)/ })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    const cmd = page.getByRole("tab", { name: /Command Prompt/ });
    await expect(cmd).toBeFocused();
    await expect(cmd).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(page.getByRole("tab", { name: /^PowerShell 7$/ })).toBeFocused();
    // Enter moves focus into that terminal.
    await page.keyboard.press("Enter");
    await page.keyboard.type("echo back-in");
    await page.keyboard.press("Enter");
    await expect(visibleTerminal(page)).toContainText("back-in");
    // Delete on a focused tab closes it.
    await expect(page.getByRole("tab")).toHaveCount(4);
    await page.keyboard.press("Control+Shift+E");
    await expect(page.getByRole("tab", { name: /^PowerShell 7$/ })).toBeFocused();
    await page.keyboard.press("Delete");
    await expect(page.getByRole("tab")).toHaveCount(3);
  });

  test("Ctrl+K and Ctrl+B reach the shell while a terminal has focus", async ({ page }) => {
    await open(page);
    await openFolderAndTerminal(page);
    await page.keyboard.press(`${MOD}+k`);
    await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
    await page.keyboard.press(`${MOD}+b`);
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  });

  test("the command palette opens folders, switches workspaces and starts terminals", async ({ page }) => {
    await open(page, "code");
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type("switch to api");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "api-server" })).toBeVisible();

    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type("new terminal");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: /PowerShell 7 \(2\)/ })).toHaveAttribute("aria-selected", "true");

    await queueFolders(page, "design-notes");
    await page.getByRole("button", { name: "Dashboard" }).click();
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type("open folder");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "design-notes" })).toBeVisible();
  });
});

test.describe("workspaces list", () => {
  test("recent workspaces show missing folders honestly and can be removed", async ({ page }) => {
    await open(page);
    await goToCode(page);
    await queueFolders(page, "first-project", "second-project");
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "first-project" })).toBeVisible();
    await page.getByRole("button", { name: "Open folder…" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "second-project" })).toBeVisible();
    await page.evaluate(() =>
      (
        window as unknown as { __kalcodeMemory: { makeUnavailable: (n: string) => void } }
      ).__kalcodeMemory.makeUnavailable("second-project"),
    );
    // The active workspace's folder disappeared: explained, with a way out.
    await page.getByRole("button", { name: "Dashboard" }).click();
    await goToCode(page);
    await expect(page.getByRole("heading", { name: "This folder can't be found" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New terminal" })).toBeDisabled();
    await page.getByRole("button", { name: "Remove from KalCode" }).click();
    await expect(page.getByText("second-project removed from KalCode")).toBeVisible();
    await expect(page.getByText("The folder and its files were not changed.")).toBeVisible();

    // No active workspace: recents are listed.
    const recents = page.getByRole("region", { name: "Recent workspaces" });
    await expect(recents.getByText("first-project", { exact: true })).toBeVisible();
    await recents.getByRole("button", { name: "Open first-project" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "first-project" })).toBeVisible();
  });

  test("the sidebar switcher lists workspaces and marks missing folders", async ({ page }) => {
    await open(page, "code");
    await page.getByRole("button", { name: /^Workspace\s/ }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitemradio", { name: /kalcode-site/ })).toHaveAttribute("aria-checked", "true");
    await expect(menu.getByRole("menuitemradio", { name: /old-prototype.*Folder not found/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });
});

test.describe("dashboard", () => {
  test("lists running terminals per workspace and opens them in Code", async ({ page }) => {
    await open(page, "code");
    const section = page.getByRole("region", { name: "Terminals" });
    await expect(section.getByRole("heading", { name: /kalcode-site/ })).toBeVisible();
    await expect(section.getByRole("listitem")).toHaveCount(2);
    await section.getByRole("button", { name: /Show Git Bash/ }).click();
    await expect(page.getByRole("tab", { name: /Git Bash/ })).toHaveAttribute("aria-selected", "true");
    await expect(visibleTerminal(page)).toContainText("build.sh");

    // Live: a new terminal appears on the Dashboard.
    await page.getByRole("button", { name: "New terminal" }).click();
    await page.getByRole("button", { name: "Dashboard" }).click();
    await expect(section.getByRole("listitem")).toHaveCount(3);
  });

  test("says so when nothing is running", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("region", { name: "Terminals" }).getByText("No terminals are running.")).toBeVisible();
  });
});

test.describe("accessibility", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`Code surface passes axe in ${theme} theme`, async ({ page }) => {
      await open(page, "code");
      if (theme === "light") {
        await page.getByRole("button", { name: "Settings" }).click();
        await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
      }
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.getByRole("button", { name: "Dashboard" }).click();
      await expect(page.getByRole("region", { name: "Terminals" }).getByText("Git Bash")).toBeVisible();
      await expectNoSeriousA11yViolations(page);

      await goToCode(page);
      await expect(visibleTerminal(page)).toContainText("First release");
      await expectNoSeriousA11yViolations(page);

      await page.getByRole("tab", { name: /Command Prompt/ }).click();
      await expect(page.locator('[role="tabpanel"]:not([hidden])').getByRole("status")).toContainText("Exited");
      await expectNoSeriousA11yViolations(page);

      await page.getByRole("button", { name: "Choose a shell" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await expectNoSeriousA11yViolations(page);
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: /^Workspace\s/ }).click();
      await expect(page.getByRole("menu").getByText("Workspaces")).toBeVisible();
      await expectNoSeriousA11yViolations(page);
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: /^Workspace\s/ }).click();
      await page.getByRole("menuitemradio", { name: /api-server/ }).click();
      await expect(page.getByRole("heading", { name: "This terminal ended when KalCode closed" })).toBeVisible();
      await expectNoSeriousA11yViolations(page);
    });

    test(`Code empty state passes axe in ${theme} theme`, async ({ page }) => {
      await open(page);
      if (theme === "light") {
        await page.getByRole("button", { name: "Settings" }).click();
        await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
      }
      await goToCode(page);
      await expect(page.getByRole("heading", { name: "Open a project folder" })).toBeVisible();
      await expectNoSeriousA11yViolations(page);
    });
  }
});
