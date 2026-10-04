import { expect, type Locator, type Page, test } from "@playwright/test";

const widget = (page: Page): Locator => page.getByRole("region", { name: "KalVoice widget" });
const shown = (page: Page): Locator => widget(page).locator(':scope > :not([role="status"])');

async function providerText(page: Page, threadId: string): Promise<string> {
  return page.evaluate(
    (id) =>
      (
        window as unknown as { __kalcodeMemory: { panes: { text: (thread: string) => string } } }
      ).__kalcodeMemory.panes.text(id),
    threadId,
  );
}

async function hears(page: Page, text: string) {
  await page.evaluate((next) => {
    (
      window as unknown as { __kalcodeMemory: { kalvoice: { setTranscript: (value: string) => void } } }
    ).__kalcodeMemory.kalvoice.setTranscript(next);
  }, text);
}

async function talk(page: Page, text: string) {
  await hears(page, text);
  await page.keyboard.down("F8");
  await expect(shown(page).getByText("Listening", { exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  await page.keyboard.up("F8");
  await expect(shown(page).getByText(/^(Done|Error)$/)).toBeVisible();
}

async function openCode(page: Page) {
  await page.goto("/?scenario=code");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
}

test.describe("KalVoice Operations control layer", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?scenario=code");
    // Choose Dashboard explicitly: a returning user is otherwise sent to Code after restore.
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Dashboard", exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  });

  test("opens every Operations view and leaves the requested tab focused and illuminated", async ({ page }) => {
    for (const [spoken, tab] of [
      ["take me to Operations", "Runs"],
      ["show the queue", "Queue"],
      ["open services", "Services"],
      ["show environments", "Environments"],
      ["open activity", "Activity"],
    ] as const) {
      await talk(page, spoken);
      await expect(page.getByRole("heading", { level: 1, name: "Operations" })).toBeVisible();
      const selected = page.getByRole("tablist", { name: "Operations views" }).getByRole("tab", {
        name: tab,
        exact: true,
      });
      await expect(selected).toHaveAttribute("aria-selected", "true");
      await expect(selected).toHaveAttribute("data-kalvoice-focused", "true");
      await expect(selected).toBeFocused();
    }
  });

  test("opens the latest failed run, shows production, and follows 'open it' to the last answer", async ({ page }) => {
    await talk(page, "open the last failed run");
    const failed = page.locator('[data-operations-run-id="op-failed"]');
    await expect(failed).toHaveAttribute("data-kalvoice-focused", "true");
    await expect(page.getByRole("complementary", { name: "Run details" })).toContainText("Package desktop");

    await page.getByRole("button", { name: "Close run details" }).click();
    await talk(page, "show production");
    const production = page.locator('[data-operations-environment="production"]');
    await expect(production).toHaveAttribute("data-kalvoice-focused", "true");
    await expect(production).toBeFocused();

    await talk(page, "what just finished");
    await expect(shown(page)).toContainText("Package desktop finished: Type check failed in the desktop package.");
    await page.getByRole("button", { name: "Dashboard", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

    await talk(page, "open it");
    await expect(page.getByRole("heading", { level: 1, name: "Operations" })).toBeVisible();
    await expect(page.locator('[data-operations-run-id="op-failed"]')).toHaveAttribute("data-kalvoice-focused", "true");
    await expect(page.getByRole("complementary", { name: "Run details" })).toContainText("Package desktop");
  });
});

test.describe("KalVoice provider-pane delivery", () => {
  test("Type inserts only, Send that submits the captured draft, and navigation never enters the terminal", async ({
    page,
  }) => {
    await openCode(page);
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("button", { name: "Launch Claude Code agent" })
      .click();
    const pane = page.locator("[data-provider-pane]").first();
    const threadId = await pane.getAttribute("data-provider-pane");
    if (!threadId) throw new Error("provider pane has no thread identity");
    const terminal = pane.locator("[data-pane-terminal]");
    const input = terminal.locator("textarea");
    await expect(input).toBeFocused();

    const rawTerminal = page.locator("[data-terminal-id]").first().locator("textarea");
    const rawBefore = await page.locator("[data-terminal-id]").first().locator(".xterm-rows").innerText();
    await hears(page, "Type Open Dashboard and explain it.");
    await page.keyboard.down("F8");
    await expect(shown(page).getByText("Listening", { exact: true })).toBeVisible();
    await rawTerminal.focus();
    await page.waitForTimeout(250);
    await page.keyboard.up("F8");
    await expect(shown(page).getByText(/^(Done|Error)$/)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
    await expect(terminal.locator(".xterm-rows")).toContainText("Open Dashboard and explain it.");
    await expect(terminal.locator(".xterm-rows")).not.toContainText("(fake) ok");
    expect(await page.locator("[data-terminal-id]").first().locator(".xterm-rows").innerText()).toBe(rawBefore);

    await input.focus();
    await talk(page, "Send that");
    await expect(terminal.locator(".xterm-rows")).toContainText("(fake) ok");

    const beforeNavigation = await providerText(page, threadId);
    await input.focus();
    await talk(page, "Open Dashboard");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    expect(await providerText(page, threadId)).toBe(beforeNavigation);
  });

  test("a natural direct prompt reaches the named open agent and sends exactly once", async ({ page }) => {
    await openCode(page);
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("button", { name: "Launch Claude Code agent" })
      .click();
    const pane = page.locator("[data-provider-pane]").first();
    const threadId = await pane.getAttribute("data-provider-pane");
    if (!threadId) throw new Error("provider pane has no thread identity");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    await talk(page, "Tell Claude to review the updater tests.");

    await expect.poll(() => providerText(page, threadId)).toContain("review the updater tests.");
    const output = await providerText(page, threadId);
    expect(output.match(/review the updater tests\./g)).toHaveLength(1);
    await expect(pane.locator("[data-pane-terminal] .xterm-rows")).toContainText("(fake) ok");
  });

  test("a focused provider accepts a bare work instruction exactly once", async ({ page }) => {
    await openCode(page);
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("button", { name: "Launch Claude Code agent" })
      .click();
    const pane = page.locator("[data-provider-pane]").first();
    const threadId = await pane.getAttribute("data-provider-pane");
    if (!threadId) throw new Error("provider pane has no thread identity");
    await expect(pane.locator("[data-pane-terminal] textarea")).toBeFocused();
    const rawTerminal = page.locator("[data-terminal-id]").first().locator(".xterm-rows");
    const rawBefore = await rawTerminal.innerText();

    await talk(page, "Refactor navigation and run the tests.");

    await expect.poll(() => providerText(page, threadId)).toContain("Refactor navigation and run the tests.");
    const output = await providerText(page, threadId);
    expect(output.match(/Refactor navigation and run the tests\./g)).toHaveLength(1);
    await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
    expect(await rawTerminal.innerText()).toBe(rawBefore);
    await expect(pane.locator("[data-pane-terminal] .xterm-rows")).toContainText("(fake) ok");
  });
});
