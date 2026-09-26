import { expect, type Locator, type Page, test } from "@playwright/test";

function widget(page: Page): Locator {
  return page.getByRole("region", { name: "KalVoice widget" });
}

async function expectVoiceState(page: Page, label: string) {
  await expect(widget(page).locator(':scope > :not([role="status"])').getByText(label, { exact: true })).toBeVisible();
}

async function talk(page: Page) {
  await page.keyboard.down("F8");
  await expectVoiceState(page, "Listening");
  await page.waitForTimeout(300);
  await page.keyboard.up("F8");
}

async function openWorkspace(page: Page, transcript: string, folder: string) {
  await page.goto(`/?transcript=${encodeURIComponent(transcript)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.evaluate((nextFolder) => {
    (
      window as unknown as { __kalcodeMemory: { queueFolders: (...folders: string[]) => void } }
    ).__kalcodeMemory.queueFolders(nextFolder);
  }, folder);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page
    .getByRole("button", { name: /Open folder/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: folder })).toBeVisible();
}

async function runningProcesses(page: Page): Promise<number> {
  return page.evaluate(() =>
    (
      window as unknown as { __kalcodeMemory: { runningProcessCount: () => number } }
    ).__kalcodeMemory.runningProcessCount(),
  );
}

test.describe("KalVoice terminal destinations", () => {
  test("raw-shell dictation never presses Enter or leaks the talk key", async ({ page }) => {
    await openWorkspace(page, "echo dictated-token whoami", "voice-raw");
    await page.getByRole("button", { name: /^New PowerShell 7 terminal$/ }).click();
    const terminal = page.locator('[role="tabpanel"]:not([hidden]) [data-terminal-id]');
    await expect(terminal.locator("textarea")).toBeFocused();
    const before = await runningProcesses(page);

    await talk(page);

    await expect(terminal.locator(".xterm-rows")).toContainText("echo dictated-token whoami");
    await expectVoiceState(page, "Done");
    expect(await runningProcesses(page)).toBe(before);
    const beforeEnter = await terminal.locator(".xterm-rows").innerText();
    expect(beforeEnter.match(/dictated-token/g)).toHaveLength(1);

    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await terminal.locator(".xterm-rows").innerText()).match(/dictated-token/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(2);
  });

  test("an unverified provider prompt receives no text and starts no replacement session", async ({ page }) => {
    await openWorkspace(page, "say voice-provider", "voice-provider");
    await page.getByRole("button", { name: "New Claude Code pane" }).click();
    const pane = page.locator("[data-provider-pane]").first();
    const terminal = pane.locator("[data-pane-terminal]");
    await expect(terminal.locator("textarea")).toBeFocused();
    await expect(pane.locator("[data-pane-status]")).toHaveText("IDLE");
    const threadId = await pane.getAttribute("data-provider-pane");
    const before = await runningProcesses(page);

    await talk(page);

    await expectVoiceState(page, "Error");
    await expect(terminal.locator(".xterm-rows")).not.toContainText("voice-provider");
    await expect(pane).toHaveAttribute("data-provider-pane", threadId ?? "");
    expect(await runningProcesses(page)).toBe(before);
  });

  test("dictation never answers a provider-native permission prompt", async ({ page }) => {
    await openWorkspace(page, "yes approve everything", "voice-permission");
    await page.getByRole("button", { name: "New Codex pane" }).click();
    const pane = page.locator("[data-provider-pane]").first();
    const terminal = pane.locator("[data-pane-terminal]");
    await terminal.locator(".xterm-screen").click();
    await page.keyboard.type("run git push origin main");
    await page.keyboard.press("Enter");
    await expect(pane.locator("[data-pane-status]")).toHaveText("WAITING FOR YOU");
    await expect(terminal.locator(".xterm-rows")).toContainText("Allow Bash? (y/n)");

    await talk(page);

    await expectVoiceState(page, "Error");
    await expect(terminal.locator(".xterm-rows")).not.toContainText("yes approve everything");
    await expect(pane.locator("[data-pane-status]")).toHaveText("WAITING FOR YOU");
  });
});
