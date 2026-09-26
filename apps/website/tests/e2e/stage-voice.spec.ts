import { expect, type Locator, type Page, test } from "@playwright/test";

/** KalVoiceDemo: one push-to-talk key, two outcomes (dictation, then a command). */
const STAGE_URL = process.env.STAGE_URL ?? "/kalvoice";

async function open(page: Page): Promise<Locator> {
  await page.goto(STAGE_URL);
  const block = page.getByTestId("kalvoice-demo");
  await expect(block).toBeAttached();
  await block.scrollIntoViewIfNeeded();
  await expect(block.locator("[data-kc-app]")).toHaveAttribute("data-kc-bound", "true");
  await expect(block).toHaveAttribute("data-kc-wired", "true");
  return block;
}

async function holdKey(page: Page, key: Locator, ms: number): Promise<void> {
  const box = await key.boundingBox();
  if (!box) throw new Error("no push-to-talk key");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

test.describe("KalVoiceDemo", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("shows one key and no chords, text box or send button", async ({ page }) => {
    const block = await open(page);
    await expect(block.getByTestId("kv-hold")).toContainText("F8");
    await expect(block.getByTestId("kalvoice-panel")).toContainText("Hold F8 to talk to KalVoice");
    await expect(block.getByTestId("kalvoice-state")).toHaveText("Ready");
    const text = (await block.textContent()) ?? "";
    expect(text).not.toMatch(/Ctrl\s*\+?\s*Shift/);
    await expect(block.getByTestId("kalvoice-panel").locator("input, textarea")).toHaveCount(0);
  });

  test("hold, speak, release: the prompt types into the focused pane", async ({ page }) => {
    const block = await open(page);
    const key = block.getByTestId("kv-hold");
    const box = await key.boundingBox();
    if (!box) throw new Error("no key");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(block.getByTestId("kalvoice-state")).toHaveText("Listening");
    await expect(block.getByTestId("kalvoice-transcript")).not.toBeEmpty({ timeout: 3000 });
    await page.waitForTimeout(1500);
    await page.mouse.up();
    await expect(block.getByTestId("kalvoice-state")).toHaveText("Done", { timeout: 10_000 });
    await expect(block.getByTestId("kalvoice-result")).toContainText("Typed into Claude Code");
    await expect(block.getByTestId("pane-claude-checkout").locator("[data-kc-input]")).toHaveText(
      "also cover the 429 response in the signup test",
      { timeout: 10_000 },
    );
    await expect(block.getByTestId("live-kalvoice-demo")).toContainText("KalVoice typed");
  });

  test("the same key runs a command: two agents open, with Type it instead", async ({ page }) => {
    const block = await open(page);
    const key = block.getByTestId("kv-hold");
    const panel = block.getByTestId("kalvoice-panel");
    await holdKey(page, key, 1500);
    await expect(panel).toHaveAttribute("data-state", "done", { timeout: 10_000 });

    // Second take (the command) once the widget has settled back to Ready; the next hold is a command.
    await expect(panel).toHaveAttribute("data-state", "off", { timeout: 15_000 });
    await expect(block.locator("[data-kc-vd-next='command']")).toBeVisible();
    await holdKey(page, key, 1400);
    await expect(block.getByTestId("kalvoice-result")).toContainText("Opened 2 agents", { timeout: 15_000 });
    await expect(block.getByTestId("pane-claude-e2e")).toBeVisible();
    await expect(block.getByTestId("pane-codex-review")).toBeVisible();
    await expect(block.locator("[data-kc-app]")).toHaveAttribute("data-count", "4");

    await block.getByTestId("kalvoice-type-instead").click();
    await expect(block.getByTestId("pane-claude-e2e")).toBeHidden();
    await expect(block.getByTestId("pane-codex-review")).toBeHidden();
    await expect(block.locator("[data-kc-app]")).toHaveAttribute("data-count", "2");
    await expect(block.getByTestId("pane-claude-checkout").locator("[data-kc-input]")).toHaveText(
      "Open two more agents",
      {
        timeout: 4000,
      },
    );
  });

  test("F8 works while focus is inside the demo", async ({ page }) => {
    const block = await open(page);
    await block.getByTestId("kv-reset").focus();
    await page.keyboard.down("F8");
    await expect(block.getByTestId("kalvoice-state")).toHaveText("Listening");
    await page.waitForTimeout(1200);
    await page.keyboard.up("F8");
    await expect(block.getByTestId("kalvoice-state")).toHaveText("Done", { timeout: 10_000 });
  });

  test("F8 outside the demo is ignored", async ({ page }) => {
    const block = await open(page);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.down("F8");
    await page.waitForTimeout(300);
    await page.keyboard.up("F8");
    await expect(block.getByTestId("kalvoice-state")).toHaveText("Ready");
  });

  test("Space held on the key works like a press and hold", async ({ page }) => {
    const block = await open(page);
    await block.getByTestId("kv-hold").focus();
    await page.keyboard.down(" ");
    await expect(block.getByTestId("kalvoice-state")).toHaveText("Listening");
    await page.waitForTimeout(1000);
    await page.keyboard.up(" ");
    await expect(block.getByTestId("kalvoice-state")).toHaveText("Done", { timeout: 10_000 });
  });
});
