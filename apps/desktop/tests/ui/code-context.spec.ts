import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

async function openCode(page: Page) {
  await page.goto("/?scenario=code");
  const heading = page.getByRole("heading", { level: 1, name: "kalcode-site" });
  if (!(await heading.isVisible())) {
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  }
  await expect(heading).toBeVisible();
}

test("Code context keeps workspace runs, services and test evidence beside real terminals", async ({ page }) => {
  await openCode(page);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          __kalcodeMemory: { operations: { lastAction(): string | null } };
        }
      ).__kalcodeMemory.operations.lastAction(),
    ),
  ).toBeNull();

  await page.getByRole("button", { name: "Context", exact: true }).click();
  await page.getByRole("menuitem", { name: "Runs, services & tests" }).click();
  const context = page.getByRole("region", { name: "Workspace context for kalcode-site" });
  await expect(context).toBeVisible();
  await expect(context.getByRole("list", { name: "Workspace runs" }).getByText("Frontend dev server")).toBeVisible();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          __kalcodeMemory: { operations: { lastAction(): string | null } };
        }
      ).__kalcodeMemory.operations.lastAction(),
    ),
  ).toBeNull();

  await context.getByRole("tab", { name: /Services/ }).click();
  const services = context.getByRole("list", { name: "Workspace services" });
  const frontend = services.getByRole("listitem").filter({ hasText: "Frontend" });
  await expect(frontend).toContainText("node · PID 14221");
  await frontend.getByRole("button", { name: "Logs" }).click();
  const detail = page.getByRole("dialog", { name: "Run details" });
  await expect(detail.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
  await expect(detail.getByText("vite ready in 412 ms", { exact: false })).toBeVisible();
  await detail.getByRole("button", { name: "Close run details" }).click();

  await context.getByRole("tab", { name: /Tests/ }).click();
  const tests = context.getByRole("list", { name: "Test runs" });
  await expect(tests.getByText("Typecheck desktop")).toBeVisible();
  await tests.getByRole("button", { name: "Open run Typecheck desktop" }).click();
  await expect(detail.getByRole("tab", { name: "Tests" })).toHaveAttribute("aria-selected", "true");
  await expect(detail.getByText("No test results were attached.")).toBeVisible();
  await detail.getByRole("button", { name: "Close run details" }).click();

  await context.getByRole("tab", { name: /Services/ }).click();
  await frontend.getByRole("button", { name: "Stop" }).click();
  await expect(frontend).toContainText("Stopped");
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
    .toBe("service_stop");
});

test("Code context stays usable in a narrow pane and is accessibility clean", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openCode(page);
  await page.getByRole("button", { name: "Context", exact: true }).click();
  await page.getByRole("menuitem", { name: "Runs, services & tests" }).click();
  const context = page.getByRole("region", { name: "Workspace context for kalcode-site" });
  await expect(context).toBeVisible();
  await context.getByRole("tab", { name: /Services/ }).click();
  await expect(context.getByRole("list", { name: "Workspace services" })).toBeVisible();
  expect(await context.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("code-context-narrow.png") });

  const results = await new AxeBuilder({ page })
    .include('[aria-label="Workspace context for kalcode-site"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
  ).toEqual([]);
});

test("run evidence stays inside a narrow window with the Agent rail open", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openCode(page);
  await page.getByRole("button", { name: "Context", exact: true }).click();
  await page.getByRole("menuitem", { name: "Runs, services & tests" }).click();
  await page.getByRole("button", { name: "Show agents", exact: true }).click();

  const context = page.getByRole("region", { name: "Workspace context for kalcode-site" });
  await context.getByRole("button", { name: "Open run Frontend dev server" }).click();
  const detail = page.getByRole("dialog", { name: "Run details" });
  await expect(detail).toBeVisible();
  const bounds = await detail.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
  const close = detail.getByRole("button", { name: "Close run details" });
  const closeBounds = await close.boundingBox();
  expect(closeBounds).not.toBeNull();
  expect((closeBounds?.x ?? 0) + (closeBounds?.width ?? 0)).toBeLessThanOrEqual(
    (bounds?.x ?? 0) + (bounds?.width ?? 0),
  );
  await page.screenshot({ path: testInfo.outputPath("code-context-detail-open-rail.png") });
  await close.click();
  await expect(detail).toHaveCount(0);
});
