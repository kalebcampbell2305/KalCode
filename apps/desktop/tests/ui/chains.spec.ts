import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./a11y.ts";

const OUT = new URL("../../qa/screenshots/", import.meta.url);
const MOD = process.platform === "darwin" ? "Meta" : "Control";

type Outcome = "passed" | "failed" | "changes_requested" | "no_report";

const shot = (name: string) => new URL(name, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// Handoff chains are a MAX feature. `chains=manual` turns off the fake agents' timed progress, so
// every step moves only when the test says so.
async function open(page: Page) {
  await page.goto("/?scenario=account-ready-max&chains=manual");
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }),
  ).toBeVisible();
}

async function openWorkspace(page: Page, folder: string) {
  await page.evaluate((name) => {
    (
      window as unknown as {
        __kalcodeMemory: { queueFolders: (...folders: string[]) => void };
      }
    ).__kalcodeMemory.queueFolders(name);
  }, folder);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox").fill("Open folder");
  await palette.getByRole("option", { name: /Open folder/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: folder })).toBeVisible();
}

async function launchAgent(page: Page) {
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New agent" })
    .getByRole("button", { name: "Launch Claude Code agent", exact: true })
    .click();
  await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
}

async function advance(page: Page, chainId: string, stepKey: string, outcome: Outcome) {
  await page.evaluate(
    ([id, key, result]) =>
      (
        window as unknown as {
          __kalcodeMemory: { chainsAdvance: (chainId: string, stepKey: string, outcome: string) => unknown };
        }
      ).__kalcodeMemory.chainsAdvance(id as string, key as string, result as string),
    [chainId, stepKey, outcome],
  );
}

function node(card: Locator, key: string) {
  return card.locator(`[data-step-key="${key}"]`);
}

test.describe("handoff chains", () => {
  test("starts from Hand off, shows the rail in Activity, records an outcome, retries a failure and reaches ready to merge", async ({
    page,
  }) => {
    // Three axe scans and a full chain: give it the budget the handoff spec's flows get on CI.
    test.setTimeout(90_000);
    await open(page);
    await openWorkspace(page, "chain-project");
    await launchAgent(page);

    // Hand off → Chain: prefilled to review this agent's work, then fix it.
    await page.getByRole("button", { name: /Hand off work from/ }).click();
    const dialog = page.getByRole("dialog", { name: "Hand off" });
    await dialog.getByRole("tab", { name: "Chain" }).click();
    const composer = dialog.getByRole("form", { name: "New handoff chain" });
    await expect(composer.getByRole("textbox", { name: "Goal", exact: true })).toHaveValue(/^Review the work in /);
    await expect(composer.getByRole("button", { name: "Review → Fix", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(composer.getByRole("listitem", { name: /^Step \d/ })).toHaveCount(2);

    // A parallel Test branch beside Fix: it shares Fix's dependency, so a failed Fix never blocks it.
    await composer.getByRole("button", { name: "Add step" }).click();
    await expect(composer.getByRole("listitem", { name: "Step 3: Test" })).toBeVisible();
    await composer.getByRole("checkbox", { name: "Runs alongside Fix" }).check();
    await composer.getByRole("button", { name: "Add criterion" }).click();
    await composer.getByRole("textbox", { name: "Acceptance criterion 1" }).fill("The focused test passes");

    await page.setViewportSize({ width: 1100, height: 860 });
    await expectNoSeriousA11yViolations(page);
    await page.screenshot({ path: shot("handoff-chain-composer-dark.png") });
    await page.setViewportSize({ width: 1360, height: 860 });

    await composer.getByRole("button", { name: "Start chain" }).click();
    await expect(dialog).toBeHidden();

    // Starting focuses the chain in Activity.
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    const card = page.locator("[data-chain-card]").first();
    await expect(card).toBeVisible();
    const chainId = await card.getAttribute("data-chain-card");
    if (!chainId) throw new Error("A started chain must expose its id");
    const rail = card.getByRole("list", { name: /^Steps of / });
    await expect(rail.getByRole("button")).toHaveCount(3);
    await expect(node(card, "review")).toHaveAttribute("data-phase", "working");
    await expect(node(card, "review")).toHaveAccessibleName(/^Step 1 of 3, Review, Claude Code .*, working/);
    await expect(node(card, "fix")).toHaveAttribute("data-phase", "waiting");
    await expect(card.locator("[data-chain-next]")).toContainText("Waiting for Review to finish");

    // The review agent ends its turn without a report: the step needs the person.
    await advance(page, chainId, "review", "no_report");
    await expect(node(card, "review")).toHaveAttribute("data-phase", "needs_report");
    await expect(card).toHaveAttribute("data-chain-phase", "needs_you");
    const reviewPanel = card.locator('[data-step-panel="review"]');
    await expect(reviewPanel.getByRole("button", { name: "Open agent" })).toBeVisible();
    await reviewPanel.getByRole("button", { name: "Record outcome" }).click();
    const record = reviewPanel.getByRole("form", { name: "Record the outcome of Review" });
    await record.getByRole("radio", { name: "Changes requested" }).click();
    await record.getByRole("textbox", { name: "Summary" }).fill("Two findings: unclamped width, missing restart test.");
    await expectNoSeriousA11yViolations(page);
    await page.screenshot({ path: shot("handoff-chain-needs-report-dark.png") });
    await record.getByRole("button", { name: "Record outcome" }).click();
    await expect(node(card, "review")).toHaveAttribute("data-phase", "changes_requested");
    await expect(node(card, "fix")).toHaveAttribute("data-phase", "working");
    await expect(node(card, "test")).toHaveAttribute("data-phase", "working");

    // Fix fails: only its dependents would stop. The parallel Test step keeps working.
    await advance(page, chainId, "fix", "failed");
    await expect(node(card, "fix")).toHaveAttribute("data-phase", "failed");
    await expect(node(card, "test")).toHaveAttribute("data-phase", "working");
    await expect(node(card, "review")).toHaveAttribute("data-phase", "changes_requested");
    await expect(card).toHaveAttribute("data-chain-phase", "blocked");
    await advance(page, chainId, "test", "passed");
    await expect(node(card, "test")).toHaveAttribute("data-phase", "passed");
    // The failed step is the one that needs the person, so its details are already open.
    const fixPanel = card.locator('[data-step-panel="fix"]');
    await expect(fixPanel.getByRole("button", { name: "Record outcome" })).toHaveCount(0);
    await page.screenshot({ path: shot("handoff-chain-failed-dark.png") });

    // Retry on the same agent: a second attempt starts.
    await fixPanel.getByRole("button", { name: "Retry" }).click();
    await fixPanel.getByRole("button", { name: "Retry step" }).click();
    await expect(node(card, "fix")).toHaveAttribute("data-phase", "working");
    await expect(node(card, "fix")).toContainText("×2");
    await advance(page, chainId, "fix", "passed");

    await expect(card).toHaveAttribute("data-chain-phase", "ready_to_merge");
    await expect(card.getByText("Ready to merge", { exact: true })).toBeVisible();
    await expect(card.locator("[data-chain-next]")).toContainText("merge");
    await expect(card.getByRole("button", { name: "Pause" })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page);
    await page.screenshot({ path: shot("handoff-chain-ready-dark.png") });
  });

  test("the pane chip opens the compact rail and the palette opens the composer", async ({ page }) => {
    await open(page);
    await openWorkspace(page, "chain-chip");
    await launchAgent(page);
    await page.getByRole("button", { name: /Hand off work from/ }).click();
    const dialog = page.getByRole("dialog", { name: "Hand off" });
    await dialog.getByRole("tab", { name: "Chain" }).click();
    await dialog.getByRole("button", { name: "Start chain" }).click();
    await expect(page.locator("[data-chain-card]")).toHaveCount(1);

    // Open agent focuses the step's coding-agent pane, whose header carries "Chain · Review 1/2".
    await page.locator('[data-step-panel="review"]').getByRole("button", { name: "Open agent" }).click();
    const chip = page.getByRole("button", { name: /^Chain .*: Review, step 1 of 2, working\. Show chain$/ });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Chain · Review 1/2");
    await chip.click();
    const popover = page.locator("[data-chain-popover]");
    await expect(popover.getByRole("list", { name: /^Steps of / }).getByRole("button")).toHaveCount(2);
    await expectNoSeriousA11yViolations(page);
    await popover.screenshot({ path: shot("handoff-chain-pane-chip-dark.png") });
    await popover.getByRole("button", { name: "Open in Activity" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();

    await page.keyboard.press(`${MOD}+k`);
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.getByRole("combobox").fill("New handoff chain");
    await palette.getByRole("option", { name: /New handoff chain/ }).click();
    await expect(page.getByRole("dialog", { name: "New handoff chain" })).toBeVisible();
  });
});
