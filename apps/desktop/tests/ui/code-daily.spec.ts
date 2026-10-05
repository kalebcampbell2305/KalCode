import { expect, test } from "@playwright/test";

test("New agent keeps the last selected provider, account, model and effort", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { __kalcodeMemory: { queueFolders: (...folders: string[]) => void } }
    ).__kalcodeMemory.queueFolders("daily-code");
  });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  const launcher = page.getByRole("dialog", { name: "New agent" });
  await launcher.getByRole("group", { name: "Codex", exact: true }).getByRole("option").first().click();
  const accountName = await launcher.getByRole("option", { selected: true }).innerText();
  const model = launcher.getByRole("radiogroup", { name: "Model", exact: true }).getByRole("radio").last();
  await model.click();
  const modelName = await model.innerText();
  await launcher.getByRole("radiogroup", { name: "Effort" }).getByRole("radio", { name: "High", exact: true }).click();
  await launcher.getByRole("button", { name: "Launch Codex agent", exact: true }).click();
  await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  await expect(launcher.getByRole("button", { name: "Launch Codex agent", exact: true })).toBeVisible();
  await expect(launcher.getByRole("option", { selected: true })).toHaveText(accountName, { useInnerText: true });
  await expect(
    launcher.getByRole("radiogroup", { name: "Model", exact: true }).getByRole("radio", { checked: true }),
  ).toHaveText(modelName);
  await expect(
    launcher.getByRole("radiogroup", { name: "Effort" }).getByRole("radio", { name: "High", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  // Fleet, the rail and voice all use this canonical pane command.
  await page.evaluate(async () => {
    const modulePath = "/src/shell/panes/paneCommands.ts";
    const { dispatchPaneCommand } = await import(/* @vite-ignore */ modulePath);
    dispatchPaneCommand({ kind: "open-agent-launcher" });
  });
  await expect(launcher.getByRole("button", { name: "Launch Codex agent", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    const modulePath = "/src/shell/panes/paneCommands.ts";
    const { dispatchPaneCommand } = await import(/* @vite-ignore */ modulePath);
    dispatchPaneCommand({ kind: "open-agent-launcher", providerId: "claude-code" });
  });
  await expect(launcher.getByRole("button", { name: "Launch Claude Code agent", exact: true })).toBeVisible();
});

test("New agent starts the remembered agent in one click; an explicit count starts that many", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { __kalcodeMemory: { queueFolders: (...folders: string[]) => void } }
    ).__kalcodeMemory.queueFolders("one-click-agents");
  });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  // First launch: choose Codex, an exact model and High effort once.
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  const launcher = page.getByRole("dialog", { name: "New agent" });
  await launcher.getByRole("group", { name: "Codex", exact: true }).getByRole("option").first().click();
  await launcher.getByRole("radiogroup", { name: "Effort" }).getByRole("radio", { name: "High", exact: true }).click();
  await launcher.getByRole("button", { name: "Launch Codex agent", exact: true }).click();
  const panes = page.locator("[data-provider-pane]");
  await expect(panes).toHaveCount(1);

  // Then New agent is one click: no launcher, one more Codex agent with the same choices.
  const newAgent = page.getByRole("button", { name: "New agent", exact: true });
  await expect(newAgent).toHaveAccessibleDescription(/^Starts Codex · .+ · High$/);
  await newAgent.hover();
  await expect(page.getByRole("tooltip")).toContainText(/Start Codex · .+ · High/);
  await page.screenshot({ path: testInfo.outputPath("new-agent-one-click.png") });
  await newAgent.click();
  await expect(panes).toHaveCount(2);
  await expect(launcher).toHaveCount(0);

  // "Start three Codex agents": the same canonical command with an explicit count.
  await page.evaluate(async () => {
    const modulePath = "/src/shell/panes/paneCommands.ts";
    const { dispatchPaneCommand } = await import(/* @vite-ignore */ modulePath);
    dispatchPaneCommand({ kind: "launch-agents", providerId: "codex", count: 3 });
  });
  await expect(panes).toHaveCount(5);
  await expect(launcher).toHaveCount(0);

  // A provider with no obvious account opens the launcher pre-filled instead of guessing.
  await page.evaluate(async () => {
    const modulePath = "/src/shell/panes/paneCommands.ts";
    const { dispatchPaneCommand } = await import(/* @vite-ignore */ modulePath);
    dispatchPaneCommand({ kind: "launch-agents", providerId: "gemini-cli", count: 2 });
  });
  await expect(launcher).toBeVisible();
  await expect(launcher.getByLabel("Agents", { exact: true })).toHaveValue("2");
  await expect(panes).toHaveCount(5);
});

test("returning workspaces open directly in Code", async ({ page }) => {
  await page.goto("/?scenario=code");
  await expect(page.locator('main[data-surface="code"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "New agent", exact: true })).toBeVisible();
});

test("Fleet focuses the exact live terminal after four agents launch", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { __kalcodeMemory: { queueFolders: (...folders: string[]) => void } }
    ).__kalcodeMemory.queueFolders("four-live-agents");
  });
  const primary = page.getByRole("navigation", { name: "Primary" });
  await primary.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  const launcher = page.getByRole("dialog", { name: "New agent" });
  await launcher.getByLabel("Agents", { exact: true }).fill("4");
  await launcher.getByRole("button", { name: "Launch 4 Claude Code agents", exact: true }).click();
  const terminals = page.locator("[data-provider-pane]");
  await expect(terminals).toHaveCount(4);
  const ids = await terminals.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-provider-pane")),
  );
  expect(new Set(ids).size).toBe(4);
  await primary.getByRole("button", { name: "Dashboard", exact: true }).click();
  const agent = page.getByRole("article").last();
  const id = await agent.getAttribute("data-thread-id");
  await agent.getByRole("heading").getByRole("button").click();
  await expect(page.locator(`[data-pane-id][data-focused="true"] [data-provider-pane="${id}"]`)).toBeVisible();
  await expect(terminals).toHaveCount(4);
  expect(
    await terminals.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-provider-pane"))),
  ).toEqual(ids);
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("button", { name: "New agent", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`code-four-agents-${width}.png`) });
  }
});
