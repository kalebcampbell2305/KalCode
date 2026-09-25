import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * TryKalCode: the interactive window. Runs against the page that composes the stage components
 * (STAGE_URL, default "/"); skipped when that page does not include the demo.
 */
const STAGE_URL = process.env.STAGE_URL ?? "/";

async function open(page: Page): Promise<Locator> {
  await page.goto(STAGE_URL);
  const block = page.getByTestId("try-kalcode");
  test.skip((await block.count()) === 0, `TryKalCode is not on ${STAGE_URL}`);
  await block.scrollIntoViewIfNeeded();
  // The window initialises when it nears the viewport.
  await expect(block.locator("[data-kc-app]")).toHaveAttribute("data-kc-bound", "true");
  await expect(block).toHaveAttribute("data-kc-wired", "true");
  return block;
}

test.describe("TryKalCode", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("is labelled as a product preview with sample data", async ({ page }) => {
    const block = await open(page);
    await expect(block.getByTestId("stage-label").first()).toContainText("Product preview · sample data");
  });

  test("provider buttons open and focus the matching pane", async ({ page }) => {
    const block = await open(page);
    const app = block.locator("[data-kc-app]");
    // The workspace opens with Claude Code, Codex and Gemini CLI side by side.
    await expect(app).toHaveAttribute("data-count", "3");
    await block.getByTestId("try-provider-gemini").click();
    const gemini = block.getByTestId("pane-gemini-research");
    await expect(gemini).toBeVisible();
    await expect(gemini).toHaveAttribute("data-focus", "true");
    await expect(block.getByTestId("try-provider-gemini")).toHaveAttribute("aria-pressed", "true");
    await expect(block.getByTestId("try-provider-claude")).toHaveAttribute("aria-pressed", "false");

    // Closing Codex, then asking for it again, reopens its pane.
    await block.getByTestId("pane-codex-signup").hover();
    await block
      .getByTestId("pane-codex-signup")
      .getByRole("button", { name: /^Close/ })
      .click();
    await expect(app).toHaveAttribute("data-count", "2");
    await block.getByTestId("try-provider-codex").click();
    await expect(block.getByTestId("pane-codex-signup")).toHaveAttribute("data-focus", "true");
    await expect(app).toHaveAttribute("data-count", "3");
  });

  test("+ New thread adds a pane, a rail entry and a Dashboard row", async ({ page }) => {
    const block = await open(page);
    await block.getByTestId("try-new").click();
    const pane = block.getByTestId("pane-new-1");
    await expect(pane).toBeVisible();
    await expect(pane).toHaveAttribute("data-focus", "true");
    await expect(pane).toContainText("New thread");
    await expect(block.locator("[data-kc-rail-thread='new-1']")).toBeVisible();
    await expect(block.getByTestId("row-new-1")).toHaveCount(1);
    await expect(block.getByTestId("live-try")).toContainText("New Claude Code thread");
  });

  test("never shows more than four panes", async ({ page }) => {
    const block = await open(page);
    for (let i = 0; i < 4; i++) await block.getByTestId("try-new").click();
    await expect(block.locator(".kc-grid > .kc-pane[data-open='true']")).toHaveCount(4);
    await expect(block.locator("[data-kc-app]")).toHaveAttribute("data-count", "4");
  });

  test("Split pane toggles stacked and side by side", async ({ page }) => {
    const block = await open(page);
    const app = block.locator("[data-kc-app]");
    await expect(app).toHaveAttribute("data-layout", "cols");
    await block.getByTestId("try-split").click();
    await expect(app).toHaveAttribute("data-layout", "rows");
    await block.getByTestId("try-split").click();
    await expect(app).toHaveAttribute("data-layout", "cols");
  });

  test("Open browser and Open dashboard switch the dock", async ({ page }) => {
    const block = await open(page);
    await block.getByTestId("try-dashboard").click();
    await expect(block.getByTestId("dock-tab-dashboard")).toHaveAttribute("aria-selected", "true");
    await expect(block.getByTestId("dashboard")).toBeVisible();
    await expect(block.getByTestId("try-dashboard")).toHaveAttribute("aria-pressed", "true");
    await block.getByTestId("try-browser").click();
    await expect(block.getByTestId("dock-tab-browser")).toHaveAttribute("aria-selected", "true");
    await expect(block.getByTestId("browser")).toBeVisible();
    await expect(block.getByTestId("browser")).toContainText("localhost:3000");
  });

  test("clicking a Dashboard thread focuses its terminal", async ({ page }) => {
    const block = await open(page);
    await block.getByTestId("try-dashboard").click();
    await block.getByTestId("row-gemini-research").getByRole("button").click();
    const gemini = block.getByTestId("pane-gemini-research");
    await expect(gemini).toBeVisible();
    await expect(gemini).toHaveAttribute("data-focus", "true");
    await expect(gemini.locator(".kc-pane__title")).toBeFocused();
  });

  test("Dashboard lists the four threads with app status labels", async ({ page }) => {
    const block = await open(page);
    await block.getByTestId("try-dashboard").click();
    const dash = block.getByTestId("dashboard");
    await expect(dash.getByTestId("row-claude-checkout")).toContainText("Running command");
    await expect(dash.getByTestId("row-codex-signup")).toContainText("Reviewing");
    await expect(dash.getByTestId("row-gemini-research")).toContainText("Thinking");
    await expect(dash.getByTestId("row-claude-runner")).toContainText("Needs approval");
  });

  test("Show permissions raises Codex's request; Approve once resolves it", async ({ page }) => {
    const block = await open(page);
    await block.getByTestId("try-permissions").click();
    const card = block.getByTestId("permissions-compact").getByTestId("approval-zod");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Codex wants to run: pnpm add zod");
    // App order: Deny · Allow for thread · Approve once (primary).
    const buttons = card.locator(".kc-approval__actions button");
    await expect(buttons).toHaveText(["Deny", "Allow for workspace", "Allow for thread", "Approve once"]);
    await expect(buttons.nth(3)).toHaveClass(/kc-btn--primary/);
    await expect(block.getByTestId("pane-codex-signup").locator(".kc-pane__head")).toContainText("Needs approval");

    await buttons.nth(3).click();
    await expect(card).toHaveAttribute("data-state", "approved");
    await expect(card.getByTestId("approval-zod-result")).toBeFocused();
    await expect(card.getByTestId("approval-zod-result")).toContainText("Approved once");
    await expect(block.getByTestId("pane-codex-signup").locator(".kc-pane__head")).toContainText("Reviewing");
    await expect(block.getByTestId("pane-codex-signup")).toContainText("Ran pnpm add zod");
    await expect(block.getByTestId("live-try")).toContainText("Approved once");
  });

  test("Deny and Allow for thread have their own outcomes", async ({ page }) => {
    const block = await open(page);
    await block.getByTestId("try-permissions").click();
    const card = block.getByTestId("permissions-compact").getByTestId("approval-zod");
    await card.getByRole("button", { name: "Deny" }).click();
    await expect(card).toHaveAttribute("data-state", "denied");
    await expect(block.getByTestId("pane-codex-signup").locator(".kc-pane__head")).toContainText("Needs your reply");

    await block.getByTestId("try-reset").click();
    await block.getByTestId("try-permissions").click();
    await card.getByRole("button", { name: "Allow for thread" }).click();
    await expect(card).toHaveAttribute("data-state", "allowed");
    await expect(card).toContainText("until it stops");

    await block.getByTestId("try-reset").click();
    await block.getByTestId("try-permissions").click();
    await card.getByRole("button", { name: "Allow for workspace" }).click();
    await expect(card).toHaveAttribute("data-state", "workspace");
    await expect(card).toContainText("for 30 days");
    await expect(block.getByTestId("pane-codex-signup")).toContainText("Ran pnpm add zod");
  });

  test("approvals bind no single-key shortcuts, like the app", async ({ page }) => {
    const block = await open(page);
    await block.getByTestId("try-permissions").click();
    const card = block.getByTestId("permissions-compact").getByTestId("approval-zod");
    await card.getByRole("button", { name: "Allow for thread" }).focus();
    for (const key of ["a", "t", "d", "w"]) await page.keyboard.press(key);
    await expect(card).toHaveAttribute("data-state", "pending");
  });

  test("the Push request offers only Deny and Approve once", async ({ page }) => {
    const block = await open(page);
    await block.getByTestId("try-dashboard").click();
    await block.locator("[data-kc-action='view:dashboard']").click();
    const push = block.getByTestId("approval-push");
    await expect(push.locator(".kc-approval__actions button")).toHaveText(["Deny", "Approve once"]);
    await push.getByRole("button", { name: "Approve once" }).click();
    await expect(push).toHaveAttribute("data-state", "approved");
    await expect(push.getByTestId("approval-push-result")).toBeFocused();
  });

  test("toolbar uses roving focus with arrow keys", async ({ page }) => {
    const block = await open(page);
    await block.getByTestId("try-provider-claude").focus();
    await page.keyboard.press("ArrowRight");
    await expect(block.getByTestId("try-provider-codex")).toBeFocused();
    await page.keyboard.press("End");
    await expect(block.getByTestId("try-reset")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(block.getByTestId("try-provider-claude")).toBeFocused();
  });

  test("dock tabs follow the tabs pattern", async ({ page }) => {
    const block = await open(page);
    await block.getByTestId("dock-tab-browser").focus();
    await page.keyboard.press("ArrowRight");
    await expect(block.getByTestId("dock-tab-dashboard")).toBeFocused();
    await expect(block.getByTestId("dock-tab-dashboard")).toHaveAttribute("aria-selected", "true");
  });

  test("Use KalVoice: hold, release, and the prompt types into the focused pane", async ({ page }) => {
    const block = await open(page);
    const key = block.getByTestId("try-voice");
    const box = await key.boundingBox();
    if (!box) throw new Error("no KalVoice key");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(block.getByTestId("kalvoice-state")).toHaveText("Listening");
    await page.waitForTimeout(1200);
    await page.mouse.up();
    await expect(block.getByTestId("kalvoice-state")).toHaveText("Done", { timeout: 6000 });
    await expect(block.getByTestId("pane-claude-checkout").locator("[data-kc-input]")).toHaveText(
      "also cover the 429 response in the signup test",
      { timeout: 6000 },
    );
  });

  test("Reset returns to the starting window", async ({ page }) => {
    const block = await open(page);
    await block.getByTestId("try-new").click();
    await block.getByTestId("try-split").click();
    await block.getByTestId("try-reset").click();
    await expect(block.getByTestId("pane-new-1")).toHaveCount(0);
    const app = block.locator("[data-kc-app]");
    await expect(app).toHaveAttribute("data-count", "3");
    await expect(app).toHaveAttribute("data-layout", "cols");
  });

  test("workspace chrome: explorer, Threads panel and status bar", async ({ page }) => {
    const block = await open(page);
    await expect(block.locator(".kc-explorer")).toContainText("reserve.ts");
    await expect(block.locator(".kc-explorer")).toContainText("Planned");
    await expect(block.getByTestId("dock-tab-threads")).toHaveAttribute("aria-selected", "true");
    await expect(block.getByTestId("threads-panel")).toContainText("Validate signup input");
    await expect(block.locator(".kc-ws__status")).toContainText("KalVoice ready");
    // A thread in the panel focuses its terminal.
    await block
      .getByTestId("threads-panel")
      .getByRole("button", { name: /Gemini CLI, Research/ })
      .click();
    await expect(block.getByTestId("pane-gemini-research")).toHaveAttribute("data-focus", "true");
  });
});
