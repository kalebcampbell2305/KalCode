import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const SCREENSHOTS = new URL("../../qa/screenshots/operations/", import.meta.url);
mkdirSync(SCREENSHOTS, { recursive: true });

function screenshotPath(name: string) {
  return new URL(`${name}.png`, SCREENSHOTS).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

async function openOperations(page: Page, scenario = "code") {
  await page.goto(`/?scenario=${scenario}`);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Operations", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Operations" })).toBeVisible();
}

async function tab(page: Page, name: "Runs" | "Queue" | "Services" | "Environments" | "Activity") {
  await page.getByRole("tablist", { name: "Operations views" }).getByRole("tab", { name, exact: true }).click();
}

async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    serious,
    JSON.stringify(
      serious.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) })),
      null,
      2,
    ),
  ).toEqual([]);
}

test("Operations connects real run evidence, queue transitions, services, environments and activity", async ({
  page,
}) => {
  await openOperations(page);

  const history = page.getByRole("region", { name: "Execution history" });
  await expect(history.getByText("Frontend dev server", { exact: true })).toBeVisible();
  await expect(history.getByText("Publish preview build", { exact: true })).toBeVisible();
  await history.getByRole("button", { name: /Publish preview build/ }).click();

  const detail = page.getByRole("complementary", { name: "Run details" });
  await expect(detail.getByRole("heading", { name: "Publish preview build" })).toBeVisible();
  await detail.getByRole("tab", { name: "Logs", exact: true }).click();
  await expect(detail.getByText("Uploading preview artifact", { exact: false })).toBeVisible();
  await detail.getByRole("tab", { name: "Timeline", exact: true }).click();
  await expect(detail.getByText("Preview deployment completed.")).toBeVisible();
  await detail.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(detail.getByText("apps/desktop/src/surfaces/operations/OperationsPage.tsx")).toBeVisible();
  await detail.getByRole("tab", { name: "Artifacts", exact: true }).click();
  await expect(detail.getByText("Desktop preview")).toBeVisible();
  await detail.getByRole("tab", { name: "Tests", exact: true }).click();
  await expect(detail.getByText("Operations UI")).toBeVisible();
  await detail.getByRole("button", { name: "Close run details" }).click();
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(history.getByText("Regression suite", { exact: true })).toBeVisible();

  await tab(page, "Queue");
  await expect(page.getByRole("region", { name: "Engineering queue" })).toContainText("New work is paused");
  const pending = page.getByRole("list", { name: "Pending tasks" });
  const production = pending.getByRole("listitem").filter({ hasText: "Deploy production" });
  const docs = pending.getByRole("listitem").filter({ hasText: "Build docs" });
  await production.dragTo(docs);
  await expect(pending.getByRole("listitem").nth(1)).toContainText("Deploy production");
  await pending
    .getByRole("listitem")
    .filter({ hasText: "Build docs" })
    .getByRole("button", { name: "Move Build docs up" })
    .click();
  await expect(pending.getByRole("listitem").nth(1)).toContainText("Build docs");
  await page.getByRole("button", { name: "Resume queue" }).click();
  await expect(page.getByText("Scheduler active", { exact: true })).toBeVisible();
  const typecheck = pending.getByRole("listitem").filter({ hasText: "Typecheck desktop" });
  await typecheck.getByRole("button", { name: "Run now" }).click();
  await expect(typecheck).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Engineering queue" })).toContainText("Typecheck desktop");
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          __kalcodeMemory: { operations: { lastAction(): string | null } };
        }
      ).__kalcodeMemory.operations.lastAction(),
    ),
  ).toBe("run_now");

  await tab(page, "Runs");
  await expect(page.getByRole("region", { name: "Execution history" }).getByText("Typecheck desktop")).toBeVisible();
  await history.getByRole("button", { name: /Typecheck desktop/ }).click();
  await detail.getByRole("button", { name: "Cancel run" }).click();
  await expect(detail).toContainText("Cancelled by you.");
  await expect(detail.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
  await detail.getByRole("button", { name: "Close run details" }).click();

  await tab(page, "Services");
  const services = page.getByRole("region", { name: "Local development services" });
  const frontend = services.getByRole("row").filter({ hasText: "Frontend" });
  await expect(frontend).toContainText("node · PID 14221");
  await expect(frontend.getByRole("button", { name: "Open in Browser" })).toBeVisible();
  await expect(frontend.getByRole("button", { name: "Logs" })).toBeVisible();
  await expect(frontend.getByRole("button", { name: "Open terminal" })).toBeVisible();
  await frontend.getByRole("button", { name: "Logs" }).click();
  await expect(page.getByRole("complementary", { name: "Run details" })).toContainText("Frontend dev server");
  await page.getByRole("button", { name: "Close run details" }).click();
  await frontend.getByRole("button", { name: "Open in Browser" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __kalcodeMemory: { operations: { lastOpenedUrl(): string | null } };
          }
        ).__kalcodeMemory.operations.lastOpenedUrl(),
      ),
    )
    .toBe("http://localhost:3000/");
  await frontend.getByRole("button", { name: "Restart" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __kalcodeMemory: { operations: { lastAction(): string | null } };
          }
        ).__kalcodeMemory.operations.lastAction(),
      ),
    )
    .toBe("service_restart");
  await frontend.getByRole("button", { name: "Stop" }).click();
  await expect(frontend).toContainText("Stopped");

  await tab(page, "Environments");
  const environments = page.getByRole("region", { name: "Deployment environments" });
  await expect(environments.getByRole("heading", { name: "What is live right now?" })).toBeVisible();
  for (const name of ["Local", "Preview", "Staging", "Production"]) {
    await expect(environments.getByRole("article", { name: `${name} environment` })).toBeVisible();
  }
  await expect(environments.getByRole("article", { name: "Staging environment" })).toContainText("Not observed");
  await expect(environments.getByRole("article", { name: "Preview environment" })).toContainText("Not Probed");
  await expect(environments.getByRole("article", { name: "Production environment" })).toContainText("Not Probed");
  await expect(environments.getByRole("article", { name: "Production environment" })).toContainText("unverified");

  await tab(page, "Activity");
  const activity = page.getByRole("region", { name: "Project activity" });
  await expect(activity.getByRole("heading", { name: "Activity heatmap" })).toBeVisible();
  await expect(activity.getByText("Operations tests passed")).toBeVisible();
  await activity.getByRole("button", { name: "Release", exact: true }).click();
  await expect(activity.getByText("Preview deployed")).toBeVisible();
  await activity
    .getByRole("listitem")
    .filter({ hasText: "Preview deployed" })
    .getByRole("button", { name: "Open run" })
    .click();
  await expect(page.getByRole("complementary", { name: "Run details" })).toContainText("Publish preview build");
});

test("Operations empty states never invent live state", async ({ page }) => {
  await openOperations(page, "empty");
  await expect(page.getByText("No runs recorded")).toBeVisible();

  await tab(page, "Queue");
  await expect(page.getByText("The queue is clear")).toBeVisible();
  await expect(page.getByText("No work is running.")).toBeVisible();

  await tab(page, "Services");
  await expect(page.getByText("No workspace services detected")).toBeVisible();

  await tab(page, "Environments");
  await expect(page.getByRole("article")).toHaveCount(4);
  await expect(page.getByText("Not observed", { exact: true })).toHaveCount(8);
  await expect(page.getByText("Live", { exact: true })).toHaveCount(0);

  await tab(page, "Activity");
  await expect(page.getByText("No activity in this range")).toBeVisible();
  await expect(page.getByText("There is no observed execution evidence to plot.")).toBeVisible();
});

test("Operations tab navigation is keyboard accessible and passes axe", async ({ page }) => {
  await openOperations(page);
  const runs = page.getByRole("tab", { name: "Runs", exact: true });
  await runs.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Queue", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Services", exact: true })).toHaveAttribute("aria-selected", "true");
  await expectNoSeriousA11yViolations(page);
});

test("@screenshots Operations rich evidence in dark and light themes", async ({ page }) => {
  await openOperations(page);
  await tab(page, "Activity");
  await page.screenshot({ path: screenshotPath("operations-activity-dark-1360") });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await tab(page, "Environments");
  await page.screenshot({ path: screenshotPath("operations-environments-light-1360") });
});
