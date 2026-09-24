import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * KalVoice UI tests against the in-memory transport. Speech here comes from the transport's
 * labelled TEST DOUBLE (a fake recognizer that returns `?transcript=`); the global shortcuts are
 * emulated with key events because a browser has no OS-level shortcuts.
 */

const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function open(page: Page, query = "") {
  await page.goto(`/${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(assistant(page)).toBeVisible();
}

function assistant(page: Page): Locator {
  return page.getByRole("region", { name: "KalVoice assistant" });
}

/** The assistant's visible content (excludes its screen-reader live region). */
function shown(page: Page): Locator {
  return assistant(page).locator(':scope > :not([role="status"])');
}

async function expand(page: Page) {
  const panel = assistant(page);
  if (await panel.getByRole("button", { name: "Expand the assistant" }).isVisible()) {
    await panel.getByRole("button", { name: "Expand the assistant" }).click();
  }
  await expect(panel.getByRole("textbox", { name: "Request for KalVoice" })).toBeVisible();
}

async function ask(page: Page, text: string) {
  await expand(page);
  const input = assistant(page).getByRole("textbox", { name: "Request for KalVoice" });
  await input.fill(text);
  await input.press("Enter");
}

async function holdDictation(page: Page) {
  await page.keyboard.down(MOD);
  await page.keyboard.down("Shift");
  await page.keyboard.down("Space");
}

async function releaseDictation(page: Page) {
  await page.keyboard.up("Space");
  await page.keyboard.up("Shift");
  await page.keyboard.up(MOD);
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

async function panelBox(page: Page) {
  const box = await assistant(page).boundingBox();
  if (!box) throw new Error("assistant not rendered");
  return box;
}

test.describe("KalVoice commands", () => {
  test("a typed command navigates, reports the result and counts once", async ({ page }) => {
    await open(page);
    await ask(page, "Go to settings");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    const panel = assistant(page);
    await expect(shown(page).getByText("Opened Settings.")).toBeVisible();
    await expect(shown(page).getByText("Used 1 of 250 · resets")).toBeVisible();
    await expect(shown(page).getByText("DONE", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Dashboard" }).click();
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity.getByText("KalVoice ran a command")).toBeVisible();
    // Activity never shows what was asked.
    await expect(activity.getByText(/go to settings/i)).toHaveCount(0);
  });

  test("requests that need reasoning ask to connect a provider and aren't counted", async ({ page }) => {
    await open(page);
    await ask(page, "Plan the migration to Postgres");
    const panel = assistant(page);
    await expect(
      shown(page).getByText("Connect a supported AI provider to use KalVoice reasoning for this request."),
    ).toBeVisible();
    await expect(shown(page).getByText("Used 0 of 250 · resets")).toBeVisible();
    await panel.getByRole("button", { name: "Open Providers" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();
  });

  test("commands for runtimes not in this build say so honestly", async ({ page }) => {
    await open(page);
    await ask(page, "Open four Codex threads");
    await expect(shown(page).getByText("Threads aren't available in this build yet")).toBeVisible();
    await ask(page, "what needs permission");
    await expect(shown(page).getByText("Approvals aren't available in this build yet")).toBeVisible();
    await expect(shown(page).getByText("Used 0 of 250 · resets")).toBeVisible();
  });

  test("the monthly limit stops requests before any work", async ({ page }) => {
    await open(page, "?scenario=kalvoice-limit");
    await ask(page, "Go to settings");
    await expect(shown(page).getByText("You've used this month's KalVoice Requests.")).toBeVisible();
    await expect(shown(page).getByText("Dictation keeps working.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  });

  test("a command that needs approval waits, then finishes", async ({ page }) => {
    await open(page, "?scenario=kalvoice-approvals");
    await ask(page, "stop all threads");
    const panel = assistant(page);
    await expect(shown(page).getByText("WAITING FOR PERMISSION", { exact: true })).toBeVisible();
    await page.evaluate(() => (window as unknown as { __kalvoiceTest: { approveAll(): void } }).__kalvoiceTest.approveAll());
    await expect(shown(page).getByText("Done: the approved command ran (test double).")).toBeVisible();
  });
});

test.describe("KalVoice dictation (fake recognizer)", () => {
  test("inserts the transcript at the caret of the focused text box", async ({ page }) => {
    await open(page, "?transcript=add%20a%20unit%20test%20for%20the%20parser");
    await page.getByRole("button", { name: "KalVoice", exact: true }).click();
    const box = page.getByRole("main").getByRole("textbox", { name: "Request for KalVoice" });
    await box.fill("Please");
    await box.focus();
    await holdDictation(page);
    await expect(shown(page).getByText("LISTENING", { exact: true })).toBeVisible();
    await expect(shown(page).getByText("Listening… release to insert")).toBeVisible();
    await releaseDictation(page);
    await expect(box).toHaveValue("Please add a unit test for the parser");
    await expect(shown(page).getByText("Inserted 31 characters.")).toBeVisible();
    // Dictation is never counted.
    await expect(page.locator("#kalvoice-status").getByText("Used 0 of 250 · resets")).toBeVisible();
  });

  test("the target is fixed when the shortcut goes down", async ({ page }) => {
    await open(page, "?scenario=kalvoice-slow&transcript=hello");
    await page.getByRole("button", { name: "KalVoice", exact: true }).click();
    const pageBox = page.getByRole("main").getByRole("textbox", { name: "Request for KalVoice" });
    await pageBox.focus();
    await holdDictation(page);
    await releaseDictation(page);
    await expect(shown(page).getByText("TRANSCRIBING", { exact: true })).toBeVisible();
    // Focus moves while transcribing; the text still goes where dictation started.
    await expand(page);
    await assistant(page).getByRole("textbox", { name: "Request for KalVoice" }).focus();
    await expect(pageBox).toHaveValue("hello");
    await expect(assistant(page).getByRole("textbox", { name: "Request for KalVoice" })).toHaveValue("");
  });

  test("explains when no text box has focus", async ({ page }) => {
    await open(page);
    await page.locator("body").click({ position: { x: 700, y: 20 } });
    await holdDictation(page);
    await releaseDictation(page);
    await expect(shown(page).getByText("Click into a text box first")).toBeVisible();
  });

  test("Escape cancels and nothing is inserted", async ({ page }) => {
    await open(page, "?transcript=should%20not%20appear");
    await expand(page);
    const input = assistant(page).getByRole("textbox", { name: "Request for KalVoice" });
    await input.focus();
    await holdDictation(page);
    await expect(shown(page).getByText("LISTENING", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await releaseDictation(page);
    await expect(shown(page).getByText("Cancelled.")).toBeVisible();
    await expect(input).toHaveValue("");
  });

  test("shows how to set up dictation when no speech model is installed", async ({ page }) => {
    await open(page, "?scenario=kalvoice-no-model");
    await expand(page);
    await assistant(page).getByRole("textbox", { name: "Request for KalVoice" }).focus();
    await holdDictation(page);
    await releaseDictation(page);
    const panel = assistant(page);
    await expect(shown(page).getByText("Download a speech model in Settings, KalVoice, to use dictation.")).toBeVisible();
    await panel.getByRole("button", { name: "Open KalVoice settings" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  });

  test("reports a blocked microphone", async ({ page }) => {
    await open(page, "?scenario=kalvoice-mic-denied");
    await expand(page);
    await assistant(page).getByRole("textbox", { name: "Request for KalVoice" }).focus();
    await holdDictation(page);
    await releaseDictation(page);
    await expect(shown(page).getByText("Microphone access is blocked.")).toBeVisible();
  });
});

test.describe("KalVoice command shortcut", () => {
  test("a tap opens the assistant ready to type; holding speaks a command", async ({ page }) => {
    await open(page, "?transcript=go%20to%20settings");
    await page.keyboard.press(`${MOD}+Shift+K`);
    const input = assistant(page).getByRole("textbox", { name: "Request for KalVoice" });
    await expect(input).toBeFocused();

    await page.keyboard.down(MOD);
    await page.keyboard.down("Shift");
    await page.keyboard.down("KeyK");
    await expect(shown(page).getByText("Listening… release to send")).toBeVisible();
    await page.waitForTimeout(600);
    await page.keyboard.up("KeyK");
    await page.keyboard.up("Shift");
    await page.keyboard.up(MOD);
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(shown(page).getByText("Opened Settings.")).toBeVisible();
  });

  test("the shortcut reopens a closed assistant", async ({ page }) => {
    await open(page);
    await assistant(page).getByRole("button", { name: /Close the assistant/ }).click();
    await expect(assistant(page)).toHaveCount(0);
    await page.keyboard.press(`${MOD}+Shift+K`);
    await expect(assistant(page).getByRole("textbox", { name: "Request for KalVoice" })).toBeFocused();
  });
});

test.describe("KalVoice floating assistant", () => {
  test("drags anywhere, clamps to the window and docks to corners", async ({ page }) => {
    await open(page);
    const handle = assistant(page).getByRole("button", { name: "Move the assistant" });
    const start = await handle.boundingBox();
    if (!start) throw new Error("no handle");
    await page.mouse.move(start.x + 10, start.y + 10);
    await page.mouse.down();
    await page.mouse.move(700, 400, { steps: 8 });
    await page.mouse.up();
    let box = await panelBox(page);
    expect(box.x).toBeGreaterThan(300);
    expect(box.x + box.width).toBeLessThan(1200);

    // Past the top-left corner: clamped inside the margin and docked there.
    const h = await handle.boundingBox();
    if (!h) throw new Error("no handle");
    await page.mouse.move(h.x + 10, h.y + 10);
    await page.mouse.down();
    await page.mouse.move(1, 1, { steps: 8 });
    await page.mouse.up();
    box = await panelBox(page);
    expect(box.x).toBeGreaterThanOrEqual(16);
    expect(box.x).toBeLessThan(40);
    expect(box.y).toBeGreaterThanOrEqual(16);
    await expect(assistant(page)).toHaveAttribute("data-anchor", "top_left");

    // The placement survives the assistant closing and reopening.
    await assistant(page).getByRole("button", { name: /Close the assistant/ }).click();
    await page.keyboard.press(`${MOD}+Shift+K`);
    await expect(assistant(page)).toHaveAttribute("data-anchor", "top_left");
  });

  test("docks from the menu and remembers a placement per window size", async ({ page }) => {
    await open(page);
    await assistant(page).getByRole("button", { name: "Dock the assistant" }).click();
    await page.getByRole("menuitemradio", { name: "Top left" }).click();
    await expect(assistant(page)).toHaveAttribute("data-anchor", "top_left");
    const topLeft = await panelBox(page);
    expect(topLeft.y).toBeLessThan(40);
    await page.waitForTimeout(400); // the placement is saved shortly after a move

    await page.setViewportSize({ width: 1024, height: 700 });
    await expect(assistant(page)).toHaveAttribute("data-anchor", "bottom_right");
    await page.setViewportSize({ width: 1360, height: 860 });
    await expect(assistant(page)).toHaveAttribute("data-anchor", "top_left");
  });

  test("collapses to the orb, expands, minimizes and closes with the keyboard", async ({ page }) => {
    await open(page);
    const panel = assistant(page);
    await panel.getByRole("button", { name: "Collapse to the orb" }).focus();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveAttribute("data-view", "orb");
    const orb = panel.getByRole("button", { name: /Open the assistant/ });
    await orb.focus();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveAttribute("data-view", "compact");
    await panel.getByRole("button", { name: "Expand the assistant" }).focus();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveAttribute("data-view", "expanded");
    await panel.getByRole("button", { name: "Minimize the assistant" }).focus();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveAttribute("data-view", "compact");
    await panel.getByRole("button", { name: /Close the assistant/ }).focus();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveCount(0);
  });

  test("moves with the arrow keys", async ({ page }) => {
    await open(page);
    const before = await panelBox(page);
    const handle = assistant(page).getByRole("button", { name: "Move the assistant" });
    await handle.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Shift+ArrowUp");
    const after = await panelBox(page);
    expect(Math.round(before.x - after.x)).toBeGreaterThanOrEqual(78);
    expect(Math.round(before.y - after.y)).toBeGreaterThanOrEqual(62);
    await expect(handle).toBeFocused();
  });

  test("announces each state to screen readers", async ({ page }) => {
    await open(page);
    const live = assistant(page).getByRole("status");
    await expect(live).toHaveText("KalVoice: Ready");
    await ask(page, "Go to settings");
    await expect(live).toHaveText("KalVoice: Done. Opened Settings.");
  });

  test("decorative motion follows the motion setting", async ({ page }) => {
    // The suite runs with prefers-reduced-motion: reduce.
    await open(page);
    const mark = assistant(page).locator("img").first();
    await expect(mark).toHaveCSS("animation-name", "none");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("radiogroup", { name: "Motion" }).getByRole("radio", { name: "Full" }).click();
    await expect(mark).not.toHaveCSS("animation-name", "none");
  });
});

test.describe("Settings, KalVoice", () => {
  test("changes a shortcut and detects conflicts", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Settings" }).click();
    const section = page.getByRole("region", { name: "KalVoice", exact: true });
    await section.getByRole("button", { name: "Change command shortcut" }).click();
    await page.keyboard.press(`${MOD}+Alt+KeyJ`);
    await expect(section.getByText("J", { exact: true })).toBeVisible();
    await expect(section.getByRole("button", { name: "Change command shortcut" })).toBeVisible();

    await section.getByRole("button", { name: "Change dictation shortcut" }).click();
    await page.keyboard.press(`${MOD}+KeyK`);
    await expect(section.getByRole("alert")).toHaveText(
      `${process.platform === "darwin" ? "⌘K" : "Ctrl+K"} is already used for KalCode command palette.`,
    );
    await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);

    await section.getByRole("button", { name: "Change dictation shortcut" }).click();
    await page.keyboard.press(`${MOD}+Alt+KeyJ`);
    await expect(section.getByRole("alert")).toContainText("is already your other KalVoice shortcut.");

    await section.getByRole("button", { name: "Change dictation shortcut" }).click();
    await page.keyboard.press(`${MOD}+Alt+KeyO`);
    await expect(section.getByRole("alert")).toContainText("is already used by another app.");
  });

  test("downloads a speech model only after consent", async ({ page }) => {
    await open(page, "?scenario=kalvoice-no-model");
    await page.getByRole("button", { name: "Settings" }).click();
    const section = page.getByRole("region", { name: "KalVoice", exact: true });
    const english = section.getByRole("listitem").filter({ hasText: "English (compact)" });
    await english.getByRole("button", { name: "Download" }).click();
    const dialog = page.getByRole("alertdialog", { name: /Download English \(compact\) speech model\?/ });
    await expect(dialog).toContainText("148 MB from Hugging Face, ggerganov/whisper.cpp");
    await expect(dialog).toContainText("SHA-256");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(english.getByRole("progressbar")).toHaveCount(0);

    await english.getByRole("button", { name: "Download" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Download" }).click();
    await expect(english.getByRole("progressbar")).toBeVisible();
    await expect(english.getByText("In use")).toBeVisible();
    await expect(page.getByText("Speech model installed").first()).toBeVisible();
  });
});

test.describe("KalVoice accessibility", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`assistant, KalVoice page and settings pass axe in ${theme} theme`, async ({ page }) => {
      await open(page);
      if (theme === "light") {
        await page.getByRole("button", { name: "Settings" }).click();
        await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
      }
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await ask(page, "plan the release");
      await expect(shown(page).getByText("ERROR", { exact: true })).toBeVisible();
      await expectNoSeriousA11yViolations(page);

      await page.getByRole("button", { name: "KalVoice", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: "KalVoice" })).toBeVisible();
      await expectNoSeriousA11yViolations(page);

      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(page.getByRole("region", { name: "KalVoice", exact: true })).toBeVisible();
      await expectNoSeriousA11yViolations(page);

      await assistant(page).getByRole("button", { name: "Collapse to the orb" }).click();
      await expectNoSeriousA11yViolations(page);
    });
  }
});
