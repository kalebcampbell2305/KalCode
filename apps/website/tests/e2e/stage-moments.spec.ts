import { expect, type Locator, type Page, test } from "@playwright/test";
import { SERVED_STABLE } from "./helpers";

/**
 * The round-3 product moments: WorkspaceStage, CommandCenterStage, MissionGraph, KalVoiceStage
 * (wide and compact), the compact permissions table and provider switch, TimelineStage and the
 * multi-agent wall. Each test skips when its component is not on STAGE_URL.
 */
const STAGE_URL = process.env.STAGE_URL ?? "/";

async function find(page: Page, testId: string): Promise<Locator> {
  await page.goto(STAGE_URL);
  const block = page.getByTestId(testId).first();
  test.skip((await page.getByTestId(testId).count()) === 0, `${testId} is not on ${STAGE_URL}`);
  await block.scrollIntoViewIfNeeded();
  return block;
}

test.describe("product moments", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("WorkspaceStage: three provider terminals, explorer, threads; chips light a terminal", async ({ page }) => {
    const block = await find(page, "workspace-stage");
    await expect(block).toHaveAttribute("data-kc-wired", "true");
    await expect(block.locator(".kc-ws__panes > .kc-pane")).toHaveCount(3);
    await expect(block.locator(".kc-explorer")).toContainText("Planned");
    await expect(block.getByTestId("stage-label")).toContainText("Product preview · sample data");
    await block.getByTestId("ws-chip-codex-signup").click();
    await expect(block.getByTestId("ws-chip-codex-signup")).toHaveAttribute("aria-pressed", "true");
    await expect(block.locator(".kc-pane[data-thread='codex-signup']")).toHaveAttribute("data-lit", "");
  });

  test("CommandCenterStage: KPIs are sample data, statuses move, the approval can be answered", async ({ page }) => {
    const block = await find(page, "command-center");
    await expect(block).toHaveAttribute("data-kc-wired", "true");
    // Stable ships the Dashboard, so once it is served the stage says so (lib/stage-status.ts).
    await expect(block.getByTestId("stage-label")).toContainText(
      SERVED_STABLE ? "the KPI tiles are illustrative" : "KPIs are sample data",
    );
    const codex = block.getByTestId("cc-row-codex-signup");
    await expect(codex).toContainText("Needs approval", { timeout: 12_000 });
    const card = block.getByTestId("approval-zod");
    await expect(card).toHaveAttribute("data-state", "pending");
    await expect(card.locator(".kc-approval__actions button")).toHaveText([
      "Deny",
      "Allow for workspace",
      "Allow for thread",
      "Approve once",
    ]);
    await card.getByRole("button", { name: "Approve once" }).click();
    await expect(card).toHaveAttribute("data-state", "approved");
    await expect(codex).toContainText(/Running command|Testing|Completed/, { timeout: 6000 });
    // The paused runner carries the paused tone.
    await expect(block.getByTestId("cc-row-claude-runner").locator(".kc-status")).toHaveAttribute(
      "data-tone",
      "paused",
    );
    // Hovering a row lights its terminal.
    await block.getByTestId("cc-row-gemini-research").hover();
    await expect(block.getByTestId("cc-thumb-gemini-research")).toHaveAttribute("data-hot", "");
  });

  test("MissionGraph: runs to a verified result; the deploy waits for approval; nodes reveal dependencies", async ({
    page,
  }) => {
    const block = await find(page, "mission-graph");
    await expect(block).toHaveAttribute("data-kc-wired", "true");
    await expect(block.getByTestId("stage-label")).toContainText("Planned");
    await expect(block).toHaveAttribute("data-stage", "verified", { timeout: 12_000 });
    await expect(block.getByTestId("mission-result")).toContainText("3 checks passed");
    await expect(block.getByTestId("mission-node-deployer")).toContainText("Needs approval");
    await block.getByTestId("mission-node-reviewer").focus();
    await expect(block.locator("[data-node='coder']")).toHaveAttribute("data-rel", "up");
    await expect(block.locator("[data-node='tester']")).toHaveAttribute("data-rel", "down");
  });

  test("KalVoiceStage: speech becomes a planned run of steps, voice only", async ({ page }) => {
    await page.goto(STAGE_URL);
    const stages = page.getByTestId("kalvoice-stage");
    test.skip((await stages.count()) === 0, "KalVoiceStage is not on this page");
    const block = stages.first();
    await block.scrollIntoViewIfNeeded();
    await expect(block).toHaveAttribute("data-kc-wired", "true");
    await expect(block.locator("input, textarea")).toHaveCount(0);
    await expect(block.getByTestId("kalvoice-transcript")).toContainText(
      "Build a user authentication system with tests.",
      { timeout: 8000 },
    );
    await expect(block).toHaveAttribute("data-state", "done", { timeout: 15_000 });
    await expect(block.getByTestId("kalvoice-steps").locator("[data-state='done']")).toHaveCount(4);
    await expect(block.getByTestId("kalvoice-result")).toContainText("Done");

    // Hold the key again: listening while held, then the run.
    const key = block.getByTestId("kv-hold");
    const box = await key.boundingBox();
    if (!box) throw new Error("no key");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(block.getByTestId("kalvoice-state")).toHaveText("Listening");
    await page.waitForTimeout(600);
    await page.mouse.up();
    await expect(block.getByTestId("kalvoice-state")).toHaveText(/Processing|Executing/, { timeout: 6000 });
    await block.getByTestId("kalvoice-type-instead").click();
    await expect(block.getByTestId("kalvoice-result")).toContainText("Typed into Claude Code");
  });

  test("compact panels: permissions table and provider switch", async ({ page }) => {
    await page.goto(STAGE_URL);
    const table = page.getByTestId("permissions-table");
    test.skip((await table.count()) === 0, "No compact permissions table on this page");
    await table.first().scrollIntoViewIfNeeded();
    const rows = table.first().locator("tbody tr");
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toContainText("Read files");
    await expect(rows.nth(0)).toContainText("Allow");
    await expect(rows.nth(1)).toContainText("Ask");
    await expect(rows.nth(4)).toContainText("Deploy to production");
    await expect(rows.nth(4)).toContainText("Approval required");
  });

  test("TimelineStage is labelled Planned and scrolls by keyboard", async ({ page }) => {
    const block = await find(page, "timeline-stage");
    await expect(block.getByTestId("stage-label")).toContainText("Planned");
    const track = block.locator(".kc-tl__track");
    await track.focus();
    await expect(track).toBeFocused();
  });

  test("MultiAgentWall: six panes; a provider chip lights its panes", async ({ page }) => {
    const block = await find(page, "multi-agent-wall");
    await expect(block).toHaveAttribute("data-kc-wired", "true");
    await expect(block.locator(".kc-grid > .kc-pane[data-open='true']")).toHaveCount(6);
    await block.getByTestId("wall-chip-codex").click();
    await expect(block).toHaveAttribute("data-lit", "codex");
  });
});

test.describe("product moments, reduced motion", () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

  test("finished stills: mission verified, KalVoice done", async ({ page }) => {
    await page.goto(STAGE_URL);
    const mg = page.getByTestId("mission-graph");
    if ((await mg.count()) > 0) {
      await mg.first().scrollIntoViewIfNeeded();
      await expect(mg.first()).toHaveAttribute("data-stage", "verified");
    }
    const vs = page.getByTestId("kalvoice-stage");
    if ((await vs.count()) > 0) {
      await vs.first().scrollIntoViewIfNeeded();
      await expect(vs.first()).toHaveAttribute("data-state", "done");
    }
    test.skip((await mg.count()) + (await vs.count()) === 0, "No moments on this page");
  });
});
