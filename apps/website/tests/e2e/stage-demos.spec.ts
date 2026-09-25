import { expect, type Page, test } from "@playwright/test";

/** BeforeAfter, ProviderSwitch, DemoCenter and the phone layout of the window. */
const STAGE_URL = process.env.STAGE_URL ?? "/";

async function has(page: Page, testId: string): Promise<boolean> {
  await page.goto(STAGE_URL);
  return (await page.getByTestId(testId).count()) > 0;
}

test.describe("BeforeAfter", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the switch moves between six loose terminals and one workspace", async ({ page }) => {
    test.skip(!(await has(page, "before-after")), "BeforeAfter is not on this page");
    const block = page.getByTestId("before-after");
    await block.scrollIntoViewIfNeeded();
    await expect(block).toHaveAttribute("data-kc-wired", "true");
    await block.getByTestId("ba-after").click();
    await expect(block).toHaveAttribute("data-state", "after");
    await expect(block.getByTestId("ba-after")).toHaveAttribute("aria-checked", "true");
    await expect(block.locator("[data-kc-ba-stage]")).toHaveAttribute("aria-label", /one KalCode workspace/);
    await block.getByTestId("ba-after").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(block).toHaveAttribute("data-state", "before");
    await expect(block.getByTestId("ba-before")).toBeFocused();
  });

  test("scrolling it into view makes the change once", async ({ page }) => {
    test.skip(!(await has(page, "before-after")), "BeforeAfter is not on this page");
    const block = page.getByTestId("before-after");
    await block.locator("[data-kc-ba-stage]").scrollIntoViewIfNeeded();
    await expect(block).toHaveAttribute("data-state", "after", { timeout: 5000 });
  });
});

test.describe("ProviderSwitch", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("tabs show each provider's own interface", async ({ page }) => {
    test.skip(!(await has(page, "provider-switch")), "ProviderSwitch is not on this page");
    const block = page.getByTestId("provider-switch");
    await block.scrollIntoViewIfNeeded();
    await expect(block).toHaveAttribute("data-kc-wired", "true");
    await block.getByTestId("provider-tab-codex").click();
    await expect(block.getByTestId("provider-tab-codex")).toHaveAttribute("aria-selected", "true");
    await expect(block.getByTestId("provider-panel-codex")).toContainText("context left");
    await expect(block.getByTestId("provider-panel-codex")).not.toHaveAttribute("inert", "");
    await page.keyboard.press("ArrowRight");
    await expect(block.getByTestId("provider-tab-gemini")).toBeFocused();
    await expect(block.getByTestId("provider-panel-gemini")).toContainText("no sandbox");
  });
});

test.describe("ProviderSwitch on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("swiping the strip updates the tabs", async ({ page }) => {
    test.skip(!(await has(page, "provider-switch")), "ProviderSwitch is not on this page");
    const block = page.getByTestId("provider-switch");
    await block.scrollIntoViewIfNeeded();
    await expect(block).toHaveAttribute("data-kc-wired", "true");
    await block.locator("[data-kc-ps-strip]").evaluate((strip) => strip.scrollTo({ left: strip.clientWidth }));
    await expect(block.getByTestId("provider-tab-codex")).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("DemoCenter", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("tabs switch scenes without a reload", async ({ page }) => {
    test.skip(!(await has(page, "demo-center")), "DemoCenter is not on this page");
    const block = page.getByTestId("demo-center");
    const app = block.locator("[data-kc-app]");
    await block.scrollIntoViewIfNeeded();
    await expect(block).toHaveAttribute("data-kc-wired", "true");
    await block.getByTestId("demo-tab-dashboard").click();
    await expect(app).toHaveAttribute("data-view", "dashboard");
    await expect(block.getByTestId("demo-tab-dashboard")).toHaveAttribute("aria-selected", "true");
    await block.getByTestId("demo-tab-permissions").click();
    await expect(app).toHaveAttribute("data-dock", "permissions");
    await expect(app.getByTestId("permissions-compact").getByTestId("approval-zod")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(block.getByTestId("demo-tab-dashboard")).toBeFocused();
    await expect(app).toHaveAttribute("data-view", "dashboard");
    await block.getByTestId("demo-tab-multi-agent").click();
    await expect(app).toHaveAttribute("data-count", "4");
    await expect(app.getByTestId("mission")).toHaveAttribute("data-stage", "5", { timeout: 8000 });
  });
});

test.describe("AppWindow on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("one pane at a time, with tabs that switch panes", async ({ page }) => {
    test.skip(!(await has(page, "try-kalcode")), "TryKalCode is not on this page");
    const block = page.getByTestId("try-kalcode");
    await block.scrollIntoViewIfNeeded();
    await expect(block.locator("[data-kc-app]")).toHaveAttribute("data-kc-bound", "true");
    await expect(block.locator(".kc-rail")).toBeHidden();
    const tabs = block.locator("[data-kc-mtabs]");
    await expect(tabs).toBeVisible();
    await tabs.locator("[data-kc-mtab='codex-signup']").click();
    await expect(block.getByTestId("pane-codex-signup")).toHaveAttribute("data-focus", "true");
    await expect(tabs.locator("[data-kc-mtab='codex-signup']")).toHaveAttribute("aria-selected", "true");
  });
});
