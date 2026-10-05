import { expect, type Page, test } from "@playwright/test";

async function openWorkspace(page: Page, shell = false) {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { __kalcodeMemory: { queueFolders: (...folders: string[]) => void } }
    ).__kalcodeMemory.queueFolders("attention-site");
  });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "Open folder…" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "attention-site" })).toBeVisible();
  if (shell) {
    await page.getByRole("button", { name: "New PowerShell 7 terminal", exact: true }).click();
    await expect(page.locator(".xterm-rows")).toContainText("PS C:");
  }
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New agent" })
    .getByRole("button", { name: "Launch Claude Code agent" })
    .click();
  const pane = page.locator("[data-provider-pane]").first();
  await expect(pane.locator("[data-pane-status]")).toHaveText(/^(READY|IDLE)$/);
  const id = await pane.getAttribute("data-provider-pane");
  if (!id) throw new Error("Missing coding-agent identity");
  return { pane, id, tab: page.locator(`[role="tab"][data-content-key="agent:${id}"]`) };
}

/** Send native-style provider input without interacting with or focusing its UI. */
async function finishAgent(page: Page, id: string) {
  await page.evaluate(async (threadId) => {
    const modulePath = "/src/ipc/memoryTransport.ts";
    const { sharedMemoryTransport } = await import(modulePath);
    await sharedMemoryTransport().invoke("provider_pane_write", { threadId, data: "exit\r" });
  }, id);
}

test("a background completion traces the agent while another terminal keeps typing focus", async ({
  page,
}, testInfo) => {
  const { pane, id, tab } = await openWorkspace(page, true);
  const shellTab = page.getByRole("tab", { name: /PowerShell 7/ });
  await shellTab.click();
  const shellPane = page.locator("[data-pane-id]").filter({ has: shellTab });
  const shellInput = shellPane.locator(".xterm-helper-textarea").first();
  await expect(shellInput).toBeFocused();
  await page.keyboard.type("echo preserved-");
  await finishAgent(page, id);
  await expect(tab).toHaveAttribute("data-attention", "completed");
  await expect(tab).toHaveAccessibleName(/Done$/);
  await expect(shellInput).toBeFocused();
  await page.keyboard.type("typing");
  await expect(shellPane.locator(".xterm-rows")).toContainText("echo preserved-typing");
  await expect(pane.locator("[data-pane-status]")).toHaveText("DONE");
  const frame = page.locator("[data-pane-id]").filter({ has: tab });
  await expect(frame).toHaveAttribute("data-attention", "completed");
  expect(await frame.evaluate((element) => getComputedStyle(element, "::after").pointerEvents)).toBe("none");
  const screenshot = testInfo.outputPath("agent-completed-attention.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("Completion trace with typing preserved", { path: screenshot, contentType: "image/png" });
  await tab.click();
  await expect(tab).not.toHaveAttribute("data-attention");
});

test("an ended coding agent closes immediately without a confirmation", async ({ page }) => {
  const { pane, id, tab } = await openWorkspace(page);
  await finishAgent(page, id);
  await expect(pane.locator("[data-pane-status]")).toHaveText("DONE");
  await tab.hover();
  await tab.locator("[data-tab-close]").click();
  await expect(tab).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("Smart Close replaces the provider stop confirmation with one concise choice", async ({ page }, testInfo) => {
  const { pane, tab } = await openWorkspace(page);
  await pane.getByRole("button", { name: /More actions/ }).click();
  await page.getByRole("menuitem", { name: "Stop…", exact: true }).click();
  await expect(pane.getByRole("alertdialog", { name: "Stop this provider" })).toBeVisible();
  await tab.hover();
  await tab.locator("[data-tab-close]").click();
  const close = page.getByRole("alertdialog", { name: "Close active work?" });
  await expect(close).toBeVisible();
  await expect(page.locator('[role="alertdialog"]')).toHaveCount(1);
  await expect(close.getByRole("button")).toHaveText(["Cancel", "Keep Running", "Stop and Close"]);
  const screenshot = testInfo.outputPath("single-smart-close.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("Single Smart Close confirmation", { path: screenshot, contentType: "image/png" });
  await close.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(pane).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
