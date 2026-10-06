import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./a11y.ts";

/**
 * Provider panes (Z7-W4) against the in-memory runtime: the pane entry point in the Code
 * surface, the pane header (Z7-15), status from the runtime only (never the terminal text),
 * KalCode approvals on the pane (Z7-04), limited status, stop, rename, keyboard and axe (Z7-25).
 */

const OUT = new URL("../../qa/screenshots/", import.meta.url);

async function open(page: Page, query = "") {
  await page.goto(`/${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
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

/**
 * An approval also opens the Agents rail beside Code (the agent now needs the person), which
 * narrows the canvas and moves the pane's approval overlay. Wait for the rail to list this agent
 * under Needs you before answering, so the click lands on the answer the person sees rather than
 * on a button that slides away between pointer down and up.
 */
const railNeedsYou = (page: Page) =>
  page
    .getByRole("complementary", { name: "Agents" })
    .getByRole("button", { name: /, Needs you, Claude Code in pane-site\. Open agent$/ });

async function newPane(page: Page) {
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New agent" })
    .getByRole("button", { name: "Launch Claude Code agent" })
    .click();
  await expect(pane(page)).toBeVisible();
  await expect(paneText(page)).toContainText("KalCode fake provider");
  await expect(status(page)).toHaveText(/^(READY|IDLE)$/);
}

async function typeInPane(page: Page, line: string) {
  await pane(page).locator("[data-pane-terminal] .xterm-screen").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
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
      await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
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
        await expect(terminal.locator("[data-pane-status]")).toHaveText(/^(READY|IDLE)$/);
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
        .getByRole("button", { name: "Activity", exact: true })
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
    await expect(region).toHaveAttribute("aria-label", "Claude Code, Claude Code agent, account Personal");
    const threadId = await region.getAttribute("data-provider-pane");
    const tab = page.locator(`[role="tab"][data-content-key="agent:${threadId}"]`);
    await expect(tab).toHaveText("Claude Code");
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
    await expect(region.locator("[data-pane-mode]")).toHaveText("Permission mode Bypass");

    await typeInPane(page, "run npm test");
    await expect(paneText(page)).toContainText("RAN Bash");
    await expect(status(page)).toHaveText(/^(READY|IDLE)$/);
    // The first prompt titles the thread.
    await expect(region.getByRole("button", { name: /Rename agent/ })).not.toHaveAccessibleName(/^New agent/);

    // Prose that looks like status never changes it.
    await typeInPane(page, "say Status: FAILED. PERMISSION REQUIRED.");
    await expect(paneText(page)).toContainText("Status: FAILED. PERMISSION REQUIRED.");
    await expect(status(page)).toHaveText(/^(READY|IDLE)$/);

    // The supported minimum pane width must keep account usage, the risky permission mode and
    // runtime status readable together. Check actual rendered boxes, including both themes.
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "Code", exact: true })
        .click();
      for (const width of [320, 360, 480, 800]) {
        await region.evaluate((element, size) => {
          element.style.width = `${size}px`;
          element.style.maxWidth = `${size}px`;
        }, width);
        const chips = region.locator("[data-pane-account], [data-pane-usage], [data-pane-mode], [data-pane-status]");
        await expect(chips).toHaveCount(4);
        for (const chip of await chips.all()) await expect(chip).toBeVisible();
        await expect
          .poll(() =>
            region.evaluate((element) => {
              const header = element.querySelector("header")?.getBoundingClientRect();
              if (!header) throw new Error("The provider pane header is missing.");
              const boxes = Array.from(
                element.querySelectorAll(
                  "[data-pane-account], [data-pane-usage], [data-pane-mode], [data-pane-status]",
                ),
                (chip) => chip.getBoundingClientRect(),
              );
              const outside = boxes.some((box) => box.left < header.left - 1 || box.right > header.right + 1);
              const overlaps = boxes.some((box, index) =>
                boxes
                  .slice(index + 1)
                  .some(
                    (other) =>
                      Math.min(box.right, other.right) - Math.max(box.left, other.left) > 1 &&
                      Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > 1,
                  ),
              );
              return { outside, overlaps };
            }),
          )
          .toEqual({ outside: false, overlaps: false });
        if (width === 320 || width === 800) {
          await region.screenshot({ path: fileURLToPath(new URL(`provider-header-${theme}-${width}.png`, OUT)) });
        }
      }
    }
  });

  test("a KalCode approval holds the tool call on the pane until the person answers", async ({ page }) => {
    await open(page);
    await openWorkspace(page);
    await newPane(page);
    await typeInPane(page, "run git push origin main");
    await expect(status(page)).toHaveText("NEEDS YOU");
    const overlay = pane(page).getByRole("region", { name: "KalCode approval for this pane" });
    await expect(overlay).toBeVisible();
    // The one approval UI, with only the answers the engine allows (a push can't be granted).
    const answers = overlay.getByRole("button", { name: /^(Deny|Approve once|Allow for thread|Allow for workspace)$/ });
    await expect(answers).toHaveText(["Deny", "Approve once"]);
    await expect(railNeedsYou(page)).toBeVisible();
    await overlay.getByRole("button", { name: "Approve once" }).click();
    await expect(paneText(page)).toContainText("RAN Bash");
    await expect(status(page)).toHaveText(/^(READY|IDLE)$/);
    await expect(overlay).toBeHidden();
    await expect(railNeedsYou(page)).toHaveCount(0);

    await typeInPane(page, "run npm install lodash");
    await expect(overlay).toBeVisible();
    await expect(overlay.getByRole("button", { name: "Allow for thread" })).toBeVisible();
    await expect(railNeedsYou(page)).toBeVisible();
    await overlay.getByRole("button", { name: "Deny" }).click();
    await expect(paneText(page)).toContainText("BLOCKED BY HOOK");
    await expect(status(page)).toHaveText(/^(READY|IDLE)$/);
  });

  test("limited status: no hook events, approvals in the provider", async ({ page }) => {
    await open(page, "?panes=limited");
    await openWorkspace(page);
    await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
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
    await expect(status(page)).toHaveText("NEEDS YOU");
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
    await typeInPane(page, "run npm test");
    await expect(paneText(page)).toContainText("RAN Bash");
    await expect(region.getByRole("button", { name: "Login flake. Rename agent" })).toBeVisible();
    const threadId = await region.getAttribute("data-provider-pane");
    await expect(page.locator(`[role="tab"][data-content-key="agent:${threadId}"]`)).toHaveText("Login flake");
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Login flake");

    await region.getByRole("button", { name: /More actions/ }).click();
    await page.getByRole("menuitem", { name: "Stop…" }).click();
    const confirm = region.getByRole("alertdialog", { name: "Stop this provider" });
    await confirm.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(status(page)).toHaveText("STOPPED");
    await expect(region.getByText("resumable", { exact: true })).toBeVisible();
    await expect(region.getByText(/^Ended/)).toBeVisible();
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Activity", exact: true })
      .click();
    const card = page.getByRole("article", { name: "Login flake", exact: true });
    await expect(card.getByRole("heading", { name: "Login flake", exact: true })).toBeVisible();
    await expect(card).not.toContainText(/Claude [A-Z](?:\s|$)/);
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
    // The pane's tab close control, after Stop and Close: the agent stops and its tab goes away.
    // Its tab uses the persisted task or provider name.
    const tab = page.locator(`[role="tab"][data-content-key="agent:${threadId}"]`);
    await tab.hover();
    await tab.locator("[data-tab-close]").click();
    await page.getByRole("button", { name: "Stop and Close", exact: true }).click();
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
    await page.getByRole("button", { name: "Stop and Close", exact: true }).click();
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
    await expect(status(page)).toHaveText("NEEDS YOU");
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
    await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("button", { name: "Launch Claude Code agent" })
      .click();
    await expect(launcher(page).getByText("Provider panes aren't available in this build yet.")).toBeVisible();
    await expect(pane(page)).toHaveCount(0);
    // A freshly opened launcher starts clean: the previous launch's refusal isn't shown again.
    await launcher(page).getByRole("button", { name: "Cancel" }).click();
    await expect(launcher(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    await expect(launcher(page)).toBeVisible();
    await expect(page.getByText("Provider panes aren't available in this build yet.")).toHaveCount(0);
  });

  test("a Codex pane: shared states from its hooks, approvals in Codex's own prompt, never an Approve button", async ({
    page,
  }) => {
    await open(page);
    await openWorkspace(page);
    await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    await expect(launcher(page).getByRole("group", { name: "Gemini CLI" })).toBeVisible();
    await launcher(page).getByRole("group", { name: "Codex" }).getByRole("option").first().click();
    await launcher(page).getByRole("button", { name: "Launch Codex agent" }).click();
    const region = pane(page);
    await expect(region).toHaveAttribute("aria-label", /Codex agent, account /);
    await expect(paneText(page)).toContainText("KalCode fake provider");
    await expect(region.locator("[data-pane-identity]")).toHaveAttribute("title", /^Codex · /);
    await expect(region.locator("[data-pane-model]"), "an unknown model shows nothing").toHaveCount(0);
    await expect(status(page)).toHaveText("READY");
    await expect(region.getByText("Approvals in Codex")).toBeVisible();

    await typeInPane(page, "run git push origin main");
    await expect(status(page)).toHaveText("NEEDS YOU");
    await expect(region.getByText("Codex is asking in the pane. Answer there.")).toBeVisible();
    await expect(region.getByRole("region", { name: "KalCode approval for this pane" })).toHaveCount(0);
    await expect(region.getByRole("button", { name: /Approve|Allow for/ })).toHaveCount(0);
    await page.keyboard.type("n");
    await page.keyboard.press("Enter");
    await expect(paneText(page)).toContainText("DENIED IN PROVIDER PROMPT");
    await expect(status(page)).toHaveText("IDLE");
    await expect(region.getByText("Approvals in Codex")).toBeVisible();

    await region.getByRole("button", { name: /More actions/ }).click();
    await page.getByRole("menuitem", { name: "Pane info" }).click();
    const panel = page.getByRole("dialog", { name: "Pane info" });
    await expect(panel).toContainText(
      "KalCode reads Codex's own lifecycle hooks (prompt, tool calls, approval requests, turn end) where this Codex version supports them, otherwise its turn-finished notification and process state. Approvals are answered in Codex's own prompt.",
    );
    await expect(panel).not.toContainText("KalCode always blocks");
    await expectNoSeriousA11yViolations(page);
    await panel.getByRole("button", { name: "Close" }).click();
  });

  test("a Gemini CLI pane shows process state only", async ({ page }) => {
    await open(page);
    await openWorkspace(page);
    await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("group", { name: "Gemini CLI" })
      .getByRole("option")
      .first()
      .click();
    // The default machine's Gemini account checks out as signed out (Providers asserts that);
    // signing in right in the launcher is the one step this pane needs.
    await page.getByRole("dialog", { name: "New agent" }).getByRole("button", { name: "Reconnect" }).click();
    await expect(page.getByRole("dialog", { name: "New agent" })).not.toBeVisible();
    await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
    const region = pane(page);
    await expect(region).toHaveAttribute("aria-label", /Gemini CLI agent, account /);
    await expect(paneText(page)).toContainText("KalCode fake provider");
    await expect(region.getByText("Limited status — approvals in Gemini CLI")).toBeVisible();
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
    await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    await expect(launcher(page).getByRole("group", { name: "Claude Code" })).toBeVisible();
    await expect(launcher(page).getByRole("group", { name: /^(Codex|Gemini CLI)$/ })).toHaveCount(0);
    await launcher(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("menuitem", { name: /^(Codex|Gemini CLI) agent/ })).toHaveCount(0);

    // In the default scenario both are offered, in the launcher and in a pane's add menu.
    await open(page);
    await openWorkspace(page, "pane-offer");
    await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
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
