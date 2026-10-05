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

async function openWorkspace(page: Page, transcript: string, folder: string, panes?: "limited") {
  const params = new URLSearchParams({ transcript });
  if (panes) params.set("panes", panes);
  await page.goto(`/?${params.toString()}`);
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
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

  test("raw-shell dictation collapses line breaks and escapes into one line and never runs it", async ({ page }) => {
    await openWorkspace(page, "placeholder", "voice-raw-lines");
    await page.getByRole("button", { name: /^New PowerShell 7 terminal$/ }).click();
    const terminal = page.locator('[role="tabpanel"]:not([hidden]) [data-terminal-id]');
    await expect(terminal.locator("textarea")).toBeFocused();
    const before = await runningProcesses(page);
    await page.evaluate(() => {
      (
        window as unknown as { __kalcodeMemory: { kalvoice: { setTranscript: (t: string) => void } } }
      ).__kalcodeMemory.kalvoice.setTranscript("echo first-line\r\nwhoami\u001b[31m second-line");
    });

    await talk(page);

    await expect(terminal.locator(".xterm-rows")).toContainText("echo first-line whoami second-line");
    await expectVoiceState(page, "Done");
    expect(await runningProcesses(page)).toBe(before);
  });

  test("“send that” in a raw shell is refused: nothing is written and Enter is never pressed", async ({ page }) => {
    await openWorkspace(page, "echo keep-me-unsent", "voice-raw-send");
    await page.getByRole("button", { name: /^New PowerShell 7 terminal$/ }).click();
    const terminal = page.locator('[role="tabpanel"]:not([hidden]) [data-terminal-id]');
    await expect(terminal.locator("textarea")).toBeFocused();
    await talk(page);
    await expect(terminal.locator(".xterm-rows")).toContainText("echo keep-me-unsent");
    const before = await runningProcesses(page);
    const screen = await terminal.locator(".xterm-rows").innerText();

    await page.evaluate(() => {
      (
        window as unknown as { __kalcodeMemory: { kalvoice: { setTranscript: (t: string) => void } } }
      ).__kalcodeMemory.kalvoice.setTranscript("send that");
    });
    await terminal.locator("textarea").focus();
    await talk(page);

    await expectVoiceState(page, "Error");
    await expect(
      widget(page).getByText("KalVoice never presses Enter in a terminal. Press Enter yourself to run it.").first(),
    ).toBeVisible();
    expect(await terminal.locator(".xterm-rows").innerText()).toBe(screen);
    expect(await runningProcesses(page)).toBe(before);
  });

  test("a limited Claude hook channel receives no submitted text and starts no replacement session", async ({
    page,
  }) => {
    await openWorkspace(page, "say voice-provider", "voice-provider", "limited");
    await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("button", { name: "Launch Claude Code agent" })
      .click();
    const pane = page.locator("[data-provider-pane]").first();
    const terminal = pane.locator("[data-pane-terminal]");
    await expect(terminal.locator("textarea")).toBeFocused();
    await expect(pane.locator("[data-pane-status]")).toHaveText(/^(READY|IDLE)$/);
    await expect(pane.getByText(/Limited status.*approvals in Claude Code/)).toBeVisible();
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
    await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("group", { name: "Codex" })
      .getByRole("option")
      .first()
      .click();
    await page.getByRole("dialog", { name: "New agent" }).getByRole("button", { name: "Launch Codex agent" }).click();
    const pane = page.locator("[data-provider-pane]").first();
    const terminal = pane.locator("[data-pane-terminal]");
    await terminal.locator(".xterm-screen").click();
    await page.keyboard.type("run git push origin main");
    await page.keyboard.press("Enter");
    await expect(pane.locator("[data-pane-status]")).toHaveText("NEEDS YOU");
    await expect(terminal.locator(".xterm-rows")).toContainText("Allow Bash? (y/n)");

    await talk(page);

    await expectVoiceState(page, "Error");
    await expect(terminal.locator(".xterm-rows")).not.toContainText("yes approve everything");
    await expect(pane.locator("[data-pane-status]")).toHaveText("NEEDS YOU");
  });
});
