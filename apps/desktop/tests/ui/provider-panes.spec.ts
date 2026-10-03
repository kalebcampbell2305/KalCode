import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * Provider panes (Z7-W4) against the in-memory runtime: the pane entry point in the Code
 * surface, the pane header (Z7-15), status from the runtime only (never the terminal text),
 * KalCode approvals on the pane (Z7-04), limited status, stop, rename, keyboard and axe (Z7-25).
 */

const OUT = new URL("../../qa/screenshots/", import.meta.url);

async function open(page: Page, query = "") {
  await page.goto(`/${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("radiogroup", { name: "Theme" })
    .getByRole("radio", { name: theme === "light" ? "Light" : "Dark" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function openWorkspace(page: Page, folder = "pane-site") {
  await page.evaluate((f) => {
    (window as unknown as { __kalcodeMemory: { queueFolders: (...f: string[]) => void } }).__kalcodeMemory.queueFolders(
      f,
    );
  }, folder);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "Open folder…" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: folder })).toBeVisible();
}

const pane = (page: Page) => page.locator("[data-provider-pane]").first();
const status = (page: Page) => pane(page).locator("[data-pane-status]");
const paneText = (page: Page) => pane(page).locator("[data-pane-terminal] .xterm-rows");

const launcher = (page: Page) => page.getByRole("dialog", { name: "New agent" });

async function newPane(page: Page) {
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New agent" })
    .getByRole("button", { name: "Launch Claude Code agent" })
    .click();
  await expect(pane(page)).toBeVisible();
  await expect(paneText(page)).toContainText("KalCode fake provider");
  await expect(status(page)).toHaveText("IDLE");
}

async function typeInPane(page: Page, line: string) {
  await pane(page).locator("[data-pane-terminal] .xterm-screen").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
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

test.describe("provider panes", () => {
  for (const [provider, count] of [
    ["Claude Code", 1],
    ["Claude Code", 4],
    ["Claude Code", 6],
    ["Codex", 4],
    ["Codex", 6],
  ] as const) {
    test(`launching ${count} ${provider} agents creates distinct terminal panes in the current workspace`, async ({
      page,
    }) => {
      await open(page);
      await openWorkspace(page, "KalCode");
      await page.getByRole("button", { name: "New agent", exact: true }).click();
      await launcher(page).getByRole("group", { name: provider, exact: true }).getByRole("option").first().click();
      await launcher(page).getByLabel("Agents", { exact: true }).fill(String(count));
      await launcher(page)
        .getByRole("button", {
          name: count === 1 ? `Launch ${provider} agent` : `Launch ${count} ${provider} agents`,
          exact: true,
        })
        .click();
      const terminals = page.locator("[data-provider-pane]");
      await expect(terminals).toHaveCount(count);
      for (const terminal of await terminals.all()) {
        await expect(terminal.locator("[data-pane-status]")).toHaveText("IDLE");
        await expect(terminal).toHaveAttribute("aria-label", /account Personal/);
        await expect(terminal).not.toContainText("earlier run");
        await expect(terminal.locator("[data-pane-terminal] .xterm-rows")).toContainText("KalCode fake provider");
      }
      const ids = await terminals.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-provider-pane")));
      expect(new Set(ids).size).toBe(count);
      await expect(page.getByText("This thread isn't a pane here")).toHaveCount(0);
      await expect(page.getByText("Open in Threads", { exact: true })).toHaveCount(0);
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "Dashboard", exact: true })
        .click();
      await expect(page.getByRole("article")).toHaveCount(count);
      await page.getByRole("article").first().getByRole("heading").getByRole("button").click();
      await expect(page.getByRole("heading", { level: 1, name: "KalCode", exact: true })).toBeVisible();
      await expect(terminals).toHaveCount(count);
      if (count === 4) await page.screenshot({ path: "qa/screenshots/agent-terminals-four.png" });
    });
  }

  test("a pane shows the provider identity, title, model, mode and status from the runtime", async ({ page }) => {
    await open(page);
    await openWorkspace(page);
    await newPane(page);
    const region = pane(page);
    await expect(region).toHaveAttribute("aria-label", "New agent, Claude Code agent, account Personal");
    // One compact header: account · model · effort · usage; the provider is named, never guessed.
    await expect(region.locator("[data-pane-identity]")).toHaveAttribute(
      "title",
      /^Claude Code · Personal · Provider default model/,
    );
    await expect(region.locator("[data-pane-account]")).toContainText("Personal");
    await expect(region.locator("[data-pane-model]"), "an unknown model shows nothing").toHaveCount(0);
    // The header always names the mode the pane runs in. Which start mode is canonical (Auto or
    // Bypass) is owned and asserted by the permissions specs, not by the header.
    await expect(region.locator("[data-pane-mode]")).toBeVisible();
    await expect(region.locator("[data-pane-mode]")).toHaveText(/^Permission mode (Auto|Bypass)$/);

    await typeInPane(page, "run npm test");
    await expect(paneText(page)).toContainText("RAN Bash");
    await expect(status(page)).toHaveText("IDLE");
    // The first prompt titles the thread.
    await expect(region.getByRole("button", { name: /Rename agent/ })).not.toHaveAccessibleName(/^New agent/);

    // Prose that looks like status never changes it.
    await typeInPane(page, "say Status: FAILED. PERMISSION REQUIRED.");
    await expect(paneText(page)).toContainText("Status: FAILED. PERMISSION REQUIRED.");
    await expect(status(page)).toHaveText("IDLE");
  });

  test("a KalCode approval holds the tool call on the pane until the person answers", async ({ page }) => {
    await open(page);
    await openWorkspace(page);
    await newPane(page);
    await typeInPane(page, "run git push origin main");
    await expect(status(page)).toHaveText("PERMISSION REQUIRED");
    const overlay = pane(page).getByRole("region", { name: "KalCode approval for this pane" });
    await expect(overlay).toBeVisible();
    // The one approval UI, with only the answers the engine allows (a push can't be granted).
    const answers = overlay.getByRole("button", { name: /^(Deny|Approve once|Allow for thread|Allow for workspace)$/ });
    await expect(answers).toHaveText(["Deny", "Approve once"]);
    await overlay.getByRole("button", { name: "Approve once" }).click();
    await expect(paneText(page)).toContainText("RAN Bash");
    await expect(status(page)).toHaveText("IDLE");
    await expect(overlay).toBeHidden();

    await typeInPane(page, "run npm install lodash");
    await expect(overlay).toBeVisible();
    await expect(overlay.getByRole("button", { name: "Allow for thread" })).toBeVisible();
    await overlay.getByRole("button", { name: "Deny" }).click();
    await expect(paneText(page)).toContainText("BLOCKED BY HOOK");
    await expect(status(page)).toHaveText("IDLE");
  });

  test("limited status: no hook events, approvals in the provider", async ({ page }) => {
    await open(page, "?panes=limited");
    await openWorkspace(page);
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("button", { name: "Launch Claude Code agent" })
      .click();
    await expect(pane(page).getByText("Limited status — approvals in Claude Code")).toBeVisible();
    await typeInPane(page, "run make");
    await expect(paneText(page)).toContainText("[fake prompt] Allow Bash?");
    await page.keyboard.type("y");
    await page.keyboard.press("Enter");
    await expect(paneText(page)).toContainText("RAN Bash");
    // Pane info explains what KalCode can't see.
    await pane(page)
      .getByRole("button", { name: /More actions/ })
      .click();
    await page.getByRole("menuitem", { name: "Pane info" }).click();
    const panel = page.getByRole("dialog", { name: "Pane info" });
    await expect(panel).toContainText("isn't sending hook events");
    await expect(panel).toContainText("Commands you type into Claude Code yourself");
    await panel.getByRole("button", { name: "Close" }).click();
  });

  test("provider-prompt routing says approvals happen in Claude Code", async ({ page }) => {
    await open(page, "?panes=provider-prompt");
    await openWorkspace(page);
    await newPane(page);
    await expect(pane(page).getByText("Approvals in Claude Code")).toBeVisible();
    await typeInPane(page, "run git push");
    await expect(pane(page).getByText("Claude Code is asking in the pane. Answer there.")).toBeVisible();
    await expect(status(page)).toHaveText("WAITING FOR YOU");
    await page.keyboard.type("n");
    await page.keyboard.press("Enter");
    await expect(paneText(page)).toContainText("DENIED IN PROVIDER PROMPT");
  });

  test("rename inline, then stop with confirmation", async ({ page }) => {
    await open(page);
    await openWorkspace(page);
    await newPane(page);
    const region = pane(page);
    await region.getByRole("button", { name: /Rename agent/ }).click();
    const input = region.getByRole("textbox", { name: "Agent name" });
    await input.fill("Login flake");
    await input.press("Enter");
    await expect(region.getByRole("button", { name: "Login flake. Rename agent" })).toBeVisible();
    await expect(region).toHaveAttribute("aria-label", "Login flake, Claude Code agent, account Personal");

    await region.getByRole("button", { name: /More actions/ }).click();
    await page.getByRole("menuitem", { name: "Stop…" }).click();
    const confirm = region.getByRole("alertdialog", { name: "Stop this provider" });
    await confirm.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(status(page)).toHaveText("IDLE");
    await expect(region.getByText("stopped · resumable")).toBeVisible();
    await expect(region.getByText(/^Ended/)).toBeVisible();
  });

  test("closing an agent pane stops the agent; nothing keeps running in the background", async ({ page }) => {
    await open(page);
    await openWorkspace(page);
    await newPane(page);
    const threadId = await pane(page).getAttribute("data-provider-pane");
    expect(threadId).toBeTruthy();
    const output = () =>
      page.evaluate(
        (id) =>
          (
            window as unknown as { __kalcodeMemory: { panes: { text: (id: string) => string } } }
          ).__kalcodeMemory.panes.text(id as string),
        threadId,
      );
    // The pane's tab close control, with no confirmation: the agent stops and its tab goes away.
    const tab = page.getByRole("tab", { name: /New agent/ }).first();
    await tab.hover();
    await tab.locator("[data-tab-close]").click();
    await expect(page.locator(`[data-provider-pane="${threadId}"]`)).toHaveCount(0);
    await expect.poll(output).toContain("[stopped by KalCode]");
    await expect(page.getByRole("button", { name: /in background/ })).toHaveCount(0);
  });

  test("closing the pane that holds an agent stops the agent", async ({ page }) => {
    await open(page);
    await openWorkspace(page);
    await newPane(page);
    const threadId = await pane(page).getAttribute("data-provider-pane");
    await page.getByRole("button", { name: "Close pane 1" }).click();
    await expect(page.locator(`[data-provider-pane="${threadId}"]`)).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            (
              window as unknown as { __kalcodeMemory: { panes: { text: (id: string) => string } } }
            ).__kalcodeMemory.panes.text(id as string),
          threadId,
        ),
      )
      .toContain("[stopped by KalCode]");
  });

  test("keyboard only: create a pane, type, reach the approval and answer it", async ({ page }) => {
    await open(page);
    await openWorkspace(page);
    const create = page.getByRole("button", { name: "New agent", exact: true });
    await create.focus();
    await page.keyboard.press("Enter");
    // The launcher opens on Claude Code; its Launch button submits with Enter.
    await expect(launcher(page)).toBeVisible();
    const launch = launcher(page).getByRole("button", { name: "Launch Claude Code agent" });
    await expect(launch).toBeEnabled();
    await launch.focus();
    await page.keyboard.press("Enter");
    await expect(paneText(page)).toContainText("KalCode fake provider");
    // The terminal takes focus when the pane opens.
    await expect(pane(page).locator("[data-pane-terminal] textarea")).toBeFocused();
    await page.keyboard.type("run deploy production");
    await page.keyboard.press("Enter");
    await expect(status(page)).toHaveText("PERMISSION REQUIRED");
    await page.keyboard.press("Control+Shift+E");
    const overlay = pane(page).getByRole("region", { name: "KalCode approval for this pane" });
    await expect(overlay).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveText(/Deny|Approve once/);
    await overlay.getByRole("button", { name: "Deny" }).focus();
    await page.keyboard.press("Enter");
    await expect(paneText(page)).toContainText("BLOCKED BY HOOK");
  });

  test("a native refusal (feature off) is shown honestly and nothing starts", async ({ page }) => {
    await open(page, "?panes=off");
    await openWorkspace(page);
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("button", { name: "Launch Claude Code agent" })
      .click();
    await expect(launcher(page).getByText("Provider panes aren't available in this build yet.")).toBeVisible();
    await expect(pane(page)).toHaveCount(0);
    // A freshly opened launcher starts clean: the previous launch's refusal isn't shown again.
    await launcher(page).getByRole("button", { name: "Cancel" }).click();
    await expect(launcher(page)).toHaveCount(0);
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await expect(launcher(page)).toBeVisible();
    await expect(page.getByText("Provider panes aren't available in this build yet.")).toHaveCount(0);
  });

  test("a Codex pane: limited status, approvals in Codex's own prompt, never an Approve button", async ({ page }) => {
    await open(page);
    await openWorkspace(page);
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await expect(launcher(page).getByRole("group", { name: "Gemini CLI" })).toBeVisible();
    await launcher(page).getByRole("group", { name: "Codex" }).getByRole("option").first().click();
    await launcher(page).getByRole("button", { name: "Launch Codex agent" }).click();
    const region = pane(page);
    await expect(region).toHaveAttribute("aria-label", /Codex agent, account /);
    await expect(paneText(page)).toContainText("KalCode fake provider");
    await expect(region.locator("[data-pane-identity]")).toHaveAttribute("title", /^Codex · /);
    await expect(region.locator("[data-pane-model]"), "an unknown model shows nothing").toHaveCount(0);
    await expect(region.getByText("Limited status — no Codex notification yet")).toBeVisible();

    await typeInPane(page, "run git push origin main");
    await expect(status(page)).toHaveText("WAITING FOR YOU");
    await expect(region.getByText("Codex is asking in the pane. Answer there.")).toBeVisible();
    await expect(region.getByRole("region", { name: "KalCode approval for this pane" })).toHaveCount(0);
    await expect(region.getByRole("button", { name: /Approve|Allow for/ })).toHaveCount(0);
    await page.keyboard.type("n");
    await page.keyboard.press("Enter");
    await expect(paneText(page)).toContainText("DENIED IN PROVIDER PROMPT");
    await expect(status(page)).toHaveText("IDLE");
    // Codex's first notification connects the status channel.
    await expect(region.getByText("Limited status — approvals in Codex")).toBeVisible();

    await region.getByRole("button", { name: /More actions/ }).click();
    await page.getByRole("menuitem", { name: "Pane info" }).click();
    const panel = page.getByRole("dialog", { name: "Pane info" });
    await expect(panel).toContainText(
      "Limited status: KalCode reads Codex's notifications (turn finished, approval requested) and process state. Approvals are answered in Codex's own prompt.",
    );
    await expect(panel).not.toContainText("KalCode always blocks");
    await expectNoSeriousA11yViolations(page);
    await panel.getByRole("button", { name: "Close" }).click();
  });

  test("a Gemini CLI pane shows process state only", async ({ page }) => {
    await open(page);
    await openWorkspace(page);
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("group", { name: "Gemini CLI" })
      .getByRole("option")
      .first()
      .click();
    // The default machine's Gemini account checks out as signed out (Providers asserts that);
    // signing in right in the launcher is the one step this pane needs.
    await page.getByRole("dialog", { name: "New agent" }).getByRole("button", { name: "Sign in to Personal" }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("button", { name: "Launch Gemini CLI agent" })
      .click();
    const region = pane(page);
    await expect(region).toHaveAttribute("aria-label", /Gemini CLI agent, account /);
    await expect(paneText(page)).toContainText("KalCode fake provider");
    await expect(region.getByText("Process state only — approvals in Gemini CLI")).toBeVisible();
    await typeInPane(page, "run npm install lodash");
    await expect(paneText(page)).toContainText("[fake prompt] Allow Bash?");
    await expect(region.getByRole("button", { name: /Approve|Allow for/ })).toHaveCount(0);
    await region.getByRole("button", { name: /More actions/ }).click();
    await page.getByRole("menuitem", { name: "Pane info" }).click();
    await expect(page.getByRole("dialog", { name: "Pane info" })).toContainText(
      "Process state only: KalCode can't see Gemini CLI's tool calls yet. Approvals are answered in Gemini CLI's own prompt.",
    );
  });

  test("Codex and Gemini CLI panes are offered only when threads can use them", async ({ page }) => {
    await open(page, "?scenario=providers-signed-out");
    await openWorkspace(page);
    await expect(page.getByRole("button", { name: "New agent", exact: true })).toBeVisible();
    // A Claude Code agent starts only after detection ran, so the offer below is settled.
    await newPane(page);
    // Signed-out Codex and a missing Gemini CLI aren't offered: not in the launcher, not in "Add".
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await expect(launcher(page).getByRole("group", { name: "Claude Code" })).toBeVisible();
    await expect(launcher(page).getByRole("group", { name: /^(Codex|Gemini CLI)$/ })).toHaveCount(0);
    await launcher(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("menuitem", { name: /^(Codex|Gemini CLI) agent/ })).toHaveCount(0);

    // In the default scenario both are offered, in the launcher and in a pane's add menu.
    await open(page);
    await openWorkspace(page, "pane-offer");
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await expect(launcher(page).getByRole("group", { name: "Codex" })).toBeVisible();
    await expect(launcher(page).getByRole("group", { name: "Gemini CLI" })).toBeVisible();
    await launcher(page).getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Add to pane 1" }).click();
    await expect(page.getByRole("menuitem", { name: /^Gemini CLI agent/ })).toBeVisible();
    await page.getByRole("menuitem", { name: /^Codex agent/ }).click();
    await launcher(page).getByRole("button", { name: "Launch Codex agent" }).click();
    await expect(
      page.locator("[data-provider-pane]").filter({ has: page.getByText("Codex", { exact: true }) }),
    ).toHaveCount(1);
  });

  for (const theme of ["dark", "light"] as const) {
    test(`panes pass axe in ${theme} theme, with an approval showing`, async ({ page }) => {
      await open(page);
      await setTheme(page, theme);
      await openWorkspace(page);
      await newPane(page);
      await expectNoSeriousA11yViolations(page);
      await typeInPane(page, "run git push origin main");
      await expect(pane(page).getByRole("region", { name: "KalCode approval for this pane" })).toBeVisible();
      await expectNoSeriousA11yViolations(page);
      await page.screenshot({
        path: new URL(`z7w4-pane-permission-${theme}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      });
    });
  }
});
