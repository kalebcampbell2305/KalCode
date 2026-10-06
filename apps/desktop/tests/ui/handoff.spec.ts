import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./a11y.ts";

const OUT = new URL("../../qa/screenshots/", import.meta.url);
const MOD = process.platform === "darwin" ? "Meta" : "Control";

// Agent handoff is a MAX feature (packages/protocol/src/features.ts).
async function open(page: Page, scenario = "account-ready-max") {
  await page.goto(`/?scenario=${scenario}`);
  // The scenario can truthfully restore its active Code workspace before the Activity route wins
  // startup. The primary navigation is the stable shell-ready boundary for either outcome.
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }),
  ).toBeVisible();
}

async function openWorkspace(page: Page, folder = "handoff-project") {
  await page.evaluate((name) => {
    (
      window as unknown as {
        __kalcodeMemory: { queueFolders: (...folders: string[]) => void };
      }
    ).__kalcodeMemory.queueFolders(name);
  }, folder);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  // MAX restores a real existing workspace for the Squad fixture, so Open folder is reached from
  // the canonical command palette instead of assuming Code starts empty.
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox").fill("Open folder");
  await palette.getByRole("option", { name: /Open folder/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: folder })).toBeVisible();
}

async function launchAgents(page: Page, count: number) {
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  const launcher = page.getByRole("dialog", { name: "New agent" });
  if (count > 1) await launcher.getByLabel("Agents", { exact: true }).fill(String(count));
  await launcher
    .getByRole("button", {
      name: count === 1 ? "Launch Claude Code agent" : `Launch ${count} Claude Code agents`,
      exact: true,
    })
    .click();
  await expect(page.locator("[data-provider-pane]")).toHaveCount(count);
  await expect(page.locator("[data-pane-terminal] .xterm-rows")).toHaveCount(count);
}

function handoffDialog(page: Page) {
  return page.getByRole("dialog", { name: "Hand off" });
}

async function beginHandoff(page: Page, source: Locator) {
  await source.getByRole("button", { name: /Hand off work from/ }).click();
  const dialog = handoffDialog(page);
  await expect(dialog).toBeVisible();
  const recipients = dialog.getByRole("group", { name: "Handoff recipient" });
  await expect(recipients.getByRole("radio")).toHaveCount(1);
  await recipients.locator("label").click();
  await expect(recipients.getByRole("radio")).toBeChecked();
  return dialog;
}

test.describe("agent handoff", () => {
  test("previews editable context, distinguishes delivery, records a result, and returns findings", async ({
    page,
  }) => {
    await open(page);
    await openWorkspace(page);
    await launchAgents(page, 2);
    const panes = page.locator("[data-provider-pane]");
    const source = panes.nth(0);
    const sourceId = await source.getAttribute("data-provider-pane");
    const targetId = await panes.nth(1).getAttribute("data-provider-pane");
    expect(sourceId).toBeTruthy();
    expect(targetId).toBeTruthy();
    if (!sourceId || !targetId) throw new Error("Launched coding agents must expose stable thread IDs");
    const target = page.locator(`[data-provider-pane="${targetId}"]`);

    const dialog = await beginHandoff(page, source);
    const instructions = dialog.getByLabel("Instructions");
    await instructions.fill("Review the sidebar persistence change and report exact test evidence.");

    // Opening the canonical launcher never destroys or silently sends the prepared draft.
    await dialog.getByRole("button", { name: "New agent…" }).click();
    const launcher = page.getByRole("dialog", { name: "New recipient agent" });
    await expect(launcher.getByText("One agent · draft returns for review before sending")).toBeVisible();
    await launcher.getByRole("button", { name: "Cancel" }).click();
    await expect(handoffDialog(page).getByLabel("Instructions")).toHaveValue(
      "Review the sidebar persistence change and report exact test evidence.",
    );

    await handoffDialog(page).getByRole("button", { name: "New agent…" }).click();
    await page
      .getByRole("dialog", { name: "New recipient agent" })
      .getByRole("button", { name: "Launch Claude Code agent" })
      .click();
    await expect(panes).toHaveCount(3);
    await expect(handoffDialog(page).getByLabel("Instructions")).toHaveValue(
      "Review the sidebar persistence change and report exact test evidence.",
    );
    const recipients = handoffDialog(page).getByRole("group", { name: "Handoff recipient" });
    await expect(recipients.getByRole("radio")).toHaveCount(2);
    const paneIds = await panes.evaluateAll((elements) =>
      elements.flatMap((element) => element.getAttribute("data-provider-pane") ?? []),
    );
    const newRecipientId = paneIds.find((id) => id !== sourceId && id !== targetId);
    expect(newRecipientId).toBeTruthy();
    if (!newRecipientId) throw new Error("The recipient launcher must create one new coding agent");
    const newRecipient = recipients.locator(`input[type="radio"][value="${newRecipientId}"]`);
    await expect(newRecipient).toBeChecked();

    // Fleet letters are derived from stable creation time plus ID, not pane order. Select the
    // original target by its canonical thread ID so this still proves manual recipient switching.
    const originalRecipient = recipients.locator(`input[type="radio"][value="${targetId}"]`);
    await originalRecipient.locator("..").click();
    await expect(originalRecipient).toBeChecked();

    await handoffDialog(page).getByRole("button", { name: "Prepare handoff" }).click();
    await expect(handoffDialog(page).getByRole("heading", { name: "Review the handoff" })).toBeVisible();
    const context = handoffDialog(page).getByLabel("Prepared context");
    await expect(context).toContainText("Original request and test results: not observed");
    await context.fill("Review only the sidebar persistence change. Run the focused UI test and report findings.");
    await handoffDialog(page).getByRole("button", { name: "Update preview" }).click();
    await expect(handoffDialog(page).getByRole("button", { name: "Send handoff" })).toBeEnabled();

    await page.setViewportSize({ width: 900, height: 720 });
    await expectNoSeriousA11yViolations(page);
    await page.screenshot({
      path: new URL("agent-handoff-preview-dark.png", OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    });
    await page.setViewportSize({ width: 1360, height: 860 });

    await handoffDialog(page).getByRole("button", { name: "Send handoff" }).click();
    await expect(handoffDialog(page).getByText(/Delivered to/)).toBeVisible();
    const delivered = handoffDialog(page).locator('[data-handoff-status="delivered"]');
    await expect(delivered).toBeVisible();
    await expect(delivered).toContainText("Delivered");
    await expect(delivered).not.toContainText("Completed");

    await handoffDialog(page).getByRole("button", { name: "Close" }).click();
    await target.getByRole("button", { name: /Hand off work from/ }).click();
    const incoming = handoffDialog(page).locator('[data-handoff-status="delivered"]');
    await incoming.getByRole("button", { name: "Report result" }).click();
    await incoming.getByLabel("Result").fill("Reviewed the change. Focused persistence test passes with no findings.");
    await incoming.getByRole("button", { name: "Record result" }).click();

    const completed = handoffDialog(page).locator('[data-handoff-status="completed"]');
    await expect(completed).toContainText("Completed");
    await expect(completed).toContainText("Focused persistence test passes");
    await completed.getByRole("button", { name: "Return findings" }).click();
    await expect(handoffDialog(page).getByRole("heading", { name: "Review the handoff" })).toBeVisible();
    const returnedContext = handoffDialog(page).getByLabel("Prepared context");
    await expect(returnedContext).toContainText("Focused persistence test passes");
    await returnedContext.fill(
      "Returned review findings: focused persistence test passes; no defects found in the requested scope.",
    );
    await handoffDialog(page).getByRole("button", { name: "Update preview" }).click();
    await handoffDialog(page).getByRole("button", { name: "Send handoff" }).click();
    await expect(handoffDialog(page).getByText(/Delivered to/)).toBeVisible();
    await expect(handoffDialog(page).locator("[data-handoff-return-of]")).toHaveAttribute(
      "data-handoff-status",
      "delivered",
    );
  });

  test("a busy receiving input queues visibly and can be cancelled before delivery", async ({ page }) => {
    await open(page);
    await openWorkspace(page, "queued-handoff");
    await launchAgents(page, 2);
    const panes = page.locator("[data-provider-pane]");
    const source = panes.nth(0);
    const target = panes.nth(1);

    await target.locator("[data-pane-terminal] .xterm-screen").click();
    await page.keyboard.type("unfinished local prompt");

    const dialog = await beginHandoff(page, source);
    await dialog.getByRole("button", { name: "Prepare handoff" }).click();
    await dialog.getByRole("button", { name: "Send handoff" }).click();
    await expect(dialog.getByText(/Queued for/)).toBeVisible();
    const queued = dialog.locator('[data-handoff-status="queued"]');
    await expect(queued).toContainText("Queued");
    await expect(queued).toContainText("Waiting for the receiving agent's empty, ready input");
    await queued.getByRole("button", { name: "Cancel queued" }).click();
    await expect(dialog.locator('[data-handoff-status="cancelled"]')).toContainText("Cancelled");
  });

  test("Free keeps the Hand Off entry visible and routes the plan boundary through Account settings", async ({
    page,
  }) => {
    await open(page, "account-ready");
    await openWorkspace(page, "free-handoff");
    await launchAgents(page, 1);
    const source = page.locator("[data-provider-pane]").first();
    await source.getByRole("button", { name: /Hand off work from/ }).click();
    const dialog = handoffDialog(page);
    await expect(dialog.getByText("Agent handoff is included with MAX and above.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Prepare handoff" })).toBeDisabled();
    await dialog.getByRole("button", { name: "View plans" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.getByRole("region", { name: "KalCode account" })).toBeVisible();
  });
});
