import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * KalVoice UI tests against the in-memory transport. Speech here comes from the transport's
 * labelled TEST DOUBLE (a fake recognizer that "hears" `?transcript=` and reveals it word by
 * word); the push-to-talk key is emulated with key events because a browser has no OS hotkeys.
 */

async function open(page: Page, query = "") {
  await page.goto(`/${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(widget(page)).toBeVisible();
}

function widget(page: Page): Locator {
  return page.getByRole("region", { name: "KalVoice widget" });
}

/** The widget's visible content (excludes its screen-reader live region). */
function shown(page: Page): Locator {
  return widget(page).locator(':scope > :not([role="status"])');
}

async function expectState(page: Page, label: string) {
  await expect(shown(page).getByText(label, { exact: true })).toBeVisible();
}

/** Holds the push-to-talk key long enough for a partial, then lets go. */
async function talk(page: Page, key = "F8", holdMs = 300) {
  await page.keyboard.down(key);
  await expectState(page, "Listening");
  await page.waitForTimeout(holdMs);
  await page.keyboard.up(key);
}

async function openKalVoicePage(page: Page) {
  await page.getByRole("button", { name: "KalVoice", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "KalVoice" })).toBeVisible();
}

function pageRequestBox(page: Page): Locator {
  return page.getByRole("main").getByRole("textbox", { name: "Type a request for KalVoice" });
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

async function widgetBox(page: Page) {
  const box = await widget(page).boundingBox();
  if (!box) throw new Error("widget not rendered");
  return box;
}

test.describe("Push to talk (fake recognizer)", () => {
  test("holding F8 streams the words, runs a command on release and counts it once", async ({ page }) => {
    await open(page, "?transcript=go%20to%20settings");
    await expectState(page, "Ready");
    await page.keyboard.down("F8");
    await expectState(page, "Listening");
    // Partials arrive while the key is still held.
    await expect(shown(page).getByText("go to", { exact: false })).toBeVisible();
    await expect(shown(page).getByText("go to settings")).toBeVisible();
    await page.keyboard.up("F8");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expectState(page, "Done");
    await expect(shown(page).getByText("Opened Settings.")).toBeVisible();
    // Nothing had focus, so there's nowhere to type it instead.
    await expect(widget(page).getByRole("button", { name: "Type it instead" })).toHaveCount(0);
    // The result collapses back to Ready on its own.
    await expectState(page, "Ready");
    await expect(shown(page).getByText("Opened Settings.")).toHaveCount(0);

    await openKalVoicePage(page);
    await expect(page.locator("#kalvoice-status").getByText("1 / 75 used · 74 remaining · renews")).toBeVisible();
    await page.getByRole("button", { name: "Dashboard" }).click();
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity.getByText("KalVoice ran a command")).toBeVisible();
    // Activity never shows what was said.
    await expect(activity.getByText(/go to settings/i)).toHaveCount(0);
  });

  test("words that aren't a command go into the focused text box and are never counted", async ({ page }) => {
    await open(page, "?transcript=add%20a%20unit%20test%20for%20the%20parser");
    await openKalVoicePage(page);
    const box = pageRequestBox(page);
    await box.fill("Please");
    await box.focus();
    await talk(page);
    await expect(box).toHaveValue("Please add a unit test for the parser");
    await expect(shown(page).getByText("Inserted 31 characters.")).toBeVisible();
    await expect(page.locator("#kalvoice-status").getByText("0 / 75 used · 75 remaining · renews")).toBeVisible();
  });

  test("a clear command wins in a text box; Type it instead types the words and refunds", async ({ page }) => {
    await open(page, "?transcript=go%20to%20settings");
    await openKalVoicePage(page);
    await pageRequestBox(page).focus();
    await talk(page);
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(shown(page).getByText("Opened Settings.")).toBeVisible();
    await widget(page).getByRole("button", { name: "Type it instead" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "KalVoice" })).toBeVisible();
    await expect(pageRequestBox(page)).toHaveValue("go to settings");
    await expect(shown(page).getByText("Typed instead.")).toBeVisible();
    await expect(page.locator("#kalvoice-status").getByText("0 / 75 used · 75 remaining · renews")).toBeVisible();
  });

  test("unavailable local interpretation never falls back to a provider and is not counted", async ({ page }) => {
    await open(page, "?transcript=plan%20the%20migration%20to%20postgres");
    await talk(page);
    await expectState(page, "Error");
    await expect(
      shown(page).getByText("On-device KalVoice interpretation isn't available in this build."),
    ).toBeVisible();
    await widget(page).getByRole("button", { name: "Open KalVoice settings" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await openKalVoicePage(page);
    await expect(page.locator("#kalvoice-status").getByText("0 / 75 used · 75 remaining · renews")).toBeVisible();
  });

  test("key repeat doesn't restart listening", async ({ page }) => {
    await open(page, "?transcript=go%20to%20settings");
    await page.keyboard.down("F8");
    await expectState(page, "Listening");
    // A held key auto-repeats; Playwright sends repeat keydowns for a key that's already down.
    for (let i = 0; i < 5; i++) await page.keyboard.down("F8");
    await expect(shown(page).getByText("go to settings")).toBeVisible();
    await page.keyboard.up("F8");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await openKalVoicePage(page);
    await expect(page.locator("#kalvoice-status").getByText("1 / 75 used · 74 remaining · renews")).toBeVisible();
  });

  test("losing the window mid-hold finishes the take (missed release)", async ({ page }) => {
    await open(page, "?transcript=go%20to%20settings");
    await page.keyboard.down("F8");
    await expectState(page, "Listening");
    await page.waitForTimeout(300);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await page.keyboard.up("F8");
    await expectState(page, "Done");
  });

  test("Escape cancels while listening and nothing is inserted", async ({ page }) => {
    await open(page, "?transcript=should%20not%20appear");
    await openKalVoicePage(page);
    const box = pageRequestBox(page);
    await box.focus();
    await page.keyboard.down("F8");
    await expectState(page, "Listening");
    await page.keyboard.press("Escape");
    await page.keyboard.up("F8");
    await expectState(page, "Ready");
    await expect(box).toHaveValue("");
  });

  test("the orb is a press-and-hold alternative to the key", async ({ page }) => {
    await open(page, "?transcript=go%20to%20settings");
    const orb = widget(page).getByRole("button", { name: "Hold to talk" });
    const box = await orb.boundingBox();
    if (!box) throw new Error("no orb");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expectState(page, "Listening");
    await page.waitForTimeout(300);
    await page.mouse.up();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  });

  test("shows how to set up speech when no model is installed", async ({ page }) => {
    await open(page, "?scenario=kalvoice-no-model");
    await page.keyboard.down("F8");
    await page.keyboard.up("F8");
    await expectState(page, "Error");
    await expect(
      shown(page).getByText("Download a speech model in Settings, KalVoice, to use dictation."),
    ).toBeVisible();
    await widget(page).getByRole("button", { name: "Set up speech" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  });

  test("reports a blocked microphone with one click to the privacy settings", async ({ page }) => {
    await open(page, "?scenario=kalvoice-mic-denied");
    await page.keyboard.down("F8");
    await page.keyboard.up("F8");
    await expect(shown(page).getByText("Microphone access is blocked.", { exact: false })).toBeVisible();
    const settingsButton = shown(page).getByRole("button", { name: "Open privacy settings" });
    await expect(settingsButton).toBeVisible();
    await settingsButton.click();
    // Native opens only the OS microphone page; nothing fails in the app.
    await expect(page.getByText("Couldn't open privacy settings")).toHaveCount(0);
  });

  test("a brand-new install prepares its speech model with no setup click, then is Ready", async ({ page }) => {
    await open(page, "?scenario=kalvoice-first-run&transcript=go%20to%20settings");
    await page.getByRole("button", { name: "Settings" }).click();
    const readiness = page.getByRole("status", { name: "Push-to-talk readiness" });
    // Truthful states while it downloads and verifies; never Ready early.
    await expect(readiness).toContainText(/Preparing speech|Verifying speech/);
    await expect(readiness).not.toContainText(/^Ready/);
    await expect(page.getByText("Speech model installed").first()).toBeVisible();
    await expect(readiness).toContainText("Ready. Hold F8 to talk to KalVoice.");
    const section = page.getByRole("region", { name: "KalVoice", exact: true });
    await expect(section.getByText("signed component catalog on kalcoded.com", { exact: false })).toBeVisible();
    await expect(section.getByRole("switch", { name: "Prepare local intelligence automatically" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("the monthly limit stops requests before any work; dictation keeps working", async ({ page }) => {
    await open(page, "?scenario=kalvoice-limit&transcript=go%20to%20settings");
    await talk(page);
    await expect(shown(page).getByText("You've used this month's KalVoice Requests.", { exact: false })).toBeVisible();
    await expect(shown(page).getByText("Dictation keeps working.", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  });
});

test.describe("Immediate app control", () => {
  test("a command that adds work runs immediately without a KalVoice approval", async ({ page }) => {
    await open(page, "?scenario=kalvoice-approvals&transcript=open%20four%20codex%20threads");
    await talk(page);
    await expect(shown(page).getByText("Opened 4 Codex threads (test double).")).toBeVisible();
    await expectState(page, "Done");
    const w = widget(page);
    await expect(w.getByRole("button", { name: "Deny" })).toHaveCount(0);
    await expect(w.getByRole("button", { name: "Allow for thread" })).toHaveCount(0);
    await expect(w.getByRole("button", { name: "Approve once" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approvals, none waiting" })).toBeVisible();
  });

  test("dictation stays free and never creates an app-control approval", async ({ page }) => {
    await open(page, "?scenario=kalvoice-approvals&transcript=write%20the%20release%20notes");
    await openKalVoicePage(page);
    const box = pageRequestBox(page);
    await box.focus();
    await talk(page);
    await expect(box).toHaveValue("write the release notes");
    await expect(page.locator("#kalvoice-status").getByText("0 / 75 used · 75 remaining · renews")).toBeVisible();
    await expect(widget(page).getByRole("button", { name: /Approve|Deny/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approvals, none waiting" })).toBeVisible();
  });

  test("making things safer runs straight away", async ({ page }) => {
    await open(page, "?scenario=kalvoice-approvals&transcript=pause%20all%20threads");
    await talk(page);
    await expect(shown(page).getByText("Paused all threads (test double).")).toBeVisible();
    await expect(widget(page).getByRole("button", { name: "Approve once" })).toHaveCount(0);
  });
});

test.describe("Commands that open other parts of KalCode", () => {
  test("show approvals opens the approvals panel", async ({ page }) => {
    await open(page, "?transcript=show%20approvals");
    await talk(page);
    await expect(page.getByRole("dialog", { name: "Approvals" })).toBeVisible();
    await expect(shown(page).getByText("Nothing is waiting for your approval.")).toBeVisible();
  });

  test("a terminal needs a workspace first, and says how to get one", async ({ page }) => {
    await open(page, "?transcript=new%20terminal");
    await talk(page);
    await expect(shown(page).getByText("Open a workspace first", { exact: false })).toBeVisible();
  });
});

test.describe("KalVoice voice widget", () => {
  test("compact: orb, KALVOICE and the state on one line at the top; no text box", async ({ page }) => {
    await open(page);
    const w = widget(page);
    await expect(w).toHaveAttribute("data-view", "compact");
    await expect(w).toHaveAttribute("data-anchor", "top");
    const box = await widgetBox(page);
    expect(box.y).toBeLessThan(24);
    expect(box.height).toBeLessThan(56);
    await expect(w.getByRole("img", { name: "KalVoice" })).toBeVisible();
    await expectState(page, "Ready");
    await expect(w.getByRole("textbox")).toHaveCount(0);
    await expect(w.getByRole("button", { name: /send/i })).toHaveCount(0);
    await expect(w.getByRole("button", { name: "Hold to talk" })).toBeVisible();
  });

  test("hiding keeps push to talk; the key and the palette bring it back", async ({ page }) => {
    await open(page, "?transcript=go%20to%20settings");
    await widget(page).getByRole("button", { name: "Hide the widget (F8 still works)" }).click();
    await expect(widget(page)).toHaveCount(0);
    await page.keyboard.down("F8");
    await expect(widget(page)).toBeVisible();
    await expectState(page, "Listening");
    await page.keyboard.up("F8");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

    await widget(page).getByRole("button", { name: "Hide the widget (F8 still works)" }).click();
    await expect(widget(page)).toHaveCount(0);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.getByRole("option", { name: "Show the KalVoice widget" }).click();
    await expect(widget(page)).toBeVisible();
  });

  test("drags anywhere, clamps to the window and docks to corners", async ({ page }) => {
    await open(page);
    const handle = widget(page).getByRole("button", { name: "Move the widget" });
    const start = await handle.boundingBox();
    if (!start) throw new Error("no handle");
    await page.mouse.move(start.x + 10, start.y + 10);
    await page.mouse.down();
    await page.mouse.move(700, 400, { steps: 8 });
    await page.mouse.up();
    let box = await widgetBox(page);
    expect(box.x).toBeGreaterThan(300);
    expect(box.x + box.width).toBeLessThan(1200);

    // Past the top-left corner: clamped right of the sidebar and docked there, inside the band
    // the shell reserves for it (Z7-W1), so it never covers the page header.
    const h = await handle.boundingBox();
    if (!h) throw new Error("no handle");
    await page.mouse.move(h.x + 10, h.y + 10);
    await page.mouse.down();
    await page.mouse.move(1, 1, { steps: 8 });
    await page.mouse.up();
    box = await widgetBox(page);
    const main = await page.locator("main").boundingBox();
    if (!main) throw new Error("no main");
    expect(box.x).toBeGreaterThanOrEqual(main.x + 16);
    expect(box.x).toBeLessThan(main.x + 40);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(main.y + 1);
    await expect(widget(page)).toHaveAttribute("data-anchor", "top_left");

    // The placement survives hiding and the key bringing it back.
    await page.waitForTimeout(400); // the placement is saved shortly after a move
    await widget(page).getByRole("button", { name: "Hide the widget (F8 still works)" }).click();
    await page.keyboard.down("F8");
    await expect(widget(page)).toHaveAttribute("data-anchor", "top_left");
    await page.keyboard.press("Escape");
    await page.keyboard.up("F8");
  });

  test("docks from the menu and remembers a placement per window size", async ({ page }) => {
    await open(page);
    await widget(page).getByRole("button", { name: "Dock the widget" }).click();
    await page.getByRole("menuitemradio", { name: "Top left" }).click();
    await expect(widget(page)).toHaveAttribute("data-anchor", "top_left");
    const topLeft = await widgetBox(page);
    expect(topLeft.y).toBeLessThan(40);
    await page.waitForTimeout(400);

    await page.setViewportSize({ width: 1024, height: 700 });
    await expect(widget(page)).toHaveAttribute("data-anchor", "top");
    await page.setViewportSize({ width: 1360, height: 860 });
    await expect(widget(page)).toHaveAttribute("data-anchor", "top_left");
  });

  test("collapses to the orb, opens, shows more and hides with the keyboard", async ({ page }) => {
    await open(page);
    const w = widget(page);
    await w.getByRole("button", { name: "Collapse to the orb" }).focus();
    await page.keyboard.press("Enter");
    await expect(w).toHaveAttribute("data-view", "orb");
    const orb = w.getByRole("button", { name: /Open the widget/ });
    await orb.focus();
    await page.keyboard.press("Enter");
    await expect(w).toHaveAttribute("data-view", "compact");
    await w.getByRole("button", { name: "Show more" }).focus();
    await page.keyboard.press("Enter");
    await expect(w).toHaveAttribute("data-view", "expanded");
    await expect(shown(page).getByText("Hold F8 to talk to KalVoice.")).toBeVisible();
    await expect(shown(page).getByText("0 / 75 used · 75 remaining · renews", { exact: false })).toBeVisible();
    await w.getByRole("button", { name: "Show less" }).focus();
    await page.keyboard.press("Enter");
    await expect(w).toHaveAttribute("data-view", "compact");
    await w.getByRole("button", { name: "Hide the widget (F8 still works)" }).focus();
    await page.keyboard.press("Enter");
    await expect(w).toHaveCount(0);
  });

  test("moves with the arrow keys", async ({ page }) => {
    await open(page);
    const before = await widgetBox(page);
    const handle = widget(page).getByRole("button", { name: "Move the widget" });
    await handle.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Shift+ArrowDown");
    const after = await widgetBox(page);
    expect(Math.round(before.x - after.x)).toBeGreaterThanOrEqual(78);
    expect(Math.round(after.y - before.y)).toBeGreaterThanOrEqual(62);
    await expect(handle).toBeFocused();
  });

  test("announces each state to screen readers", async ({ page }) => {
    await open(page, "?scenario=kalvoice-slow&transcript=go%20to%20settings");
    const live = widget(page).getByRole("status");
    await expect(live).toHaveText("KalVoice: Ready.");
    await page.keyboard.down("F8");
    await expect(live).toHaveText("KalVoice: Listening.");
    await page.waitForTimeout(300);
    await page.keyboard.up("F8");
    await expect(live).toHaveText("KalVoice: Processing.");
    await expect(live).toHaveText("KalVoice: Executing.");
    await expect(live).toHaveText("KalVoice: Done. Opened Settings.");
  });

  test("orb motion follows the motion setting", async ({ page }) => {
    // The suite runs with prefers-reduced-motion: reduce.
    await open(page);
    const halo = widget(page).locator("span[data-phase] > span").first();
    await expect(halo).toHaveCSS("animation-name", "none");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("radiogroup", { name: "Motion" }).getByRole("radio", { name: "Full" }).click();
    await expect(halo).not.toHaveCSS("animation-name", "none");
  });
});

test.describe("Settings, KalVoice", () => {
  test("changes the push-to-talk key and explains keys it can't use", async ({ page }) => {
    await open(page, "?transcript=go%20to%20settings");
    await page.getByRole("button", { name: "Settings" }).click();
    const section = page.getByRole("region", { name: "KalVoice", exact: true });
    const change = section.getByRole("button", { name: "Change the push-to-talk key" });
    const alert = section.getByRole("alert");

    await change.click();
    await page.keyboard.press("F5");
    await expect(alert).toHaveText("F5 is used for reloading the window in KalCode.");

    await change.click();
    await page.keyboard.press("Shift+KeyK");
    await expect(alert).toHaveText("Push to talk uses one key on its own, without Command/Ctrl, Option/Alt or Shift.");

    await change.click();
    await page.keyboard.press("Shift");
    await expect(alert).toContainText("A modifier key can't be the push-to-talk key");

    await change.click();
    await page.keyboard.press("CapsLock");
    await expect(alert).toContainText("A lock key can't be the push-to-talk key");

    await change.click();
    await page.keyboard.press("F9");
    await expect(alert).toHaveText("F9 is already used by another app. Choose a different key.");

    await change.click();
    await page.keyboard.press("F10");
    await expect(alert).toHaveCount(0);
    await expect(section.locator("kbd", { hasText: "F10" })).toBeVisible();
    await expect(section.getByText("F1–F24, Pause, Scroll Lock or Insert", { exact: false })).toBeVisible();

    // The new key works; the old one no longer does.
    await page.keyboard.down("F8");
    await page.keyboard.up("F8");
    await expectState(page, "Ready");
    await page.getByRole("button", { name: "Dashboard" }).click();
    await talk(page, "F10");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  });

  test("push to talk can be switched off", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("switch", { name: "Push to talk" }).click();
    await expect(page.getByRole("switch", { name: "Push to talk" })).toHaveAttribute("aria-checked", "false");
    await page.keyboard.down("F8");
    await page.keyboard.up("F8");
    // Truthful: the widget no longer claims Ready while the key is off.
    await expectState(page, "Off");
    await expect(shown(page).getByText("Push to talk is off. Turn it on in Settings, KalVoice.")).toBeVisible();
  });

  test("downloads a speech model only after consent", async ({ page }) => {
    await open(page, "?scenario=kalvoice-no-model");
    await page.getByRole("button", { name: "Settings" }).click();
    const section = page.getByRole("region", { name: "KalVoice", exact: true });
    const english = section.getByRole("listitem").filter({ hasText: "English (fastest)" });
    await english.getByRole("button", { name: "Download" }).click();
    const dialog = page.getByRole("alertdialog", { name: /Download English \(fastest\) speech model\?/ });
    await expect(dialog).toContainText("78 MB from KalCode's signed component catalog on kalcoded.com");
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
    test(`widget, KalVoice page and settings pass axe in ${theme} theme`, async ({ page }) => {
      await open(page, "?scenario=kalvoice-approvals&transcript=open%20four%20codex%20threads");
      if (theme === "light") {
        await page.getByRole("button", { name: "Settings" }).click();
        await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
      }
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expectNoSeriousA11yViolations(page);

      await talk(page);
      await expectState(page, "Done");
      await expectNoSeriousA11yViolations(page);
      await expectState(page, "Ready");
      await expectNoSeriousA11yViolations(page);

      await openKalVoicePage(page);
      await expectNoSeriousA11yViolations(page);

      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(page.getByRole("region", { name: "KalVoice", exact: true })).toBeVisible();
      await expectNoSeriousA11yViolations(page);

      await widget(page).getByRole("button", { name: "Show more" }).click();
      await expectNoSeriousA11yViolations(page);
      await widget(page).getByRole("button", { name: "Collapse to the orb" }).click();
      await expectNoSeriousA11yViolations(page);
    });
  }
});
