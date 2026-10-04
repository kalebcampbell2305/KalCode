import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// This suite verifies the real frontend and pane IPC contract against the labelled memory
// provider. Native authentication, process isolation and persistence have separate Rust proofs.
async function workspace(page: Page, metadata: "available" | "unavailable" | "plan-unavailable") {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.evaluate(async (metadata) => {
    const path = "/src/ipc/memoryTransport.ts";
    const { sharedMemoryTransport } = await import(path);
    const transport = sharedMemoryTransport();
    const invoke = transport.invoke.bind(transport);
    transport.invoke = async (command: string, args: Record<string, unknown>) => {
      const result = await invoke(command, args);
      if (command === "thread_options") {
        // The in-memory adapter's catalog must agree with the UI discovery fixture.
        const codex = result.providers.find((provider: { id: string }) => provider.id === "codex");
        if (codex)
          codex.models.splice(0, codex.models.length, {
            id: "code-test-exact",
            displayName: "Code test exact",
            isDefault: false,
          });
        return result;
      }
      if (command !== "provider_account_usage") return result;
      return result.map((usage: { accountId: string }) => ({
        ...usage,
        status: metadata === "unavailable" ? "unavailable" : "available",
        plan: metadata === "available" ? "Pro" : null,
        windows:
          metadata === "unavailable"
            ? []
            : [
                {
                  id: "weekly",
                  label: "Weekly",
                  remainingPercent: 62,
                  resetsAt: new Date(Date.now() + 3600_000).toISOString(),
                },
              ],
        checkedAt: metadata === "unavailable" ? null : new Date().toISOString(),
        reason: metadata === "unavailable" ? "Provider usage API unavailable" : null,
      }));
    };
    (
      window as unknown as { __kalcodeMemory: { queueFolders: (...names: string[]) => void } }
    ).__kalcodeMemory.queueFolders("account-state-project");
  }, metadata);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page
    .getByRole("button", { name: /^Open folder/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "account-state-project" })).toBeVisible();
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  return page.getByRole("dialog", { name: "New agent" });
}

for (const metadata of ["available", "unavailable", "plan-unavailable"] as const) {
  test(`valid Codex session launches when metadata is ${metadata}`, async ({ page }) => {
    const launcher = await workspace(page, metadata);
    const account = launcher
      .getByRole("group", { name: "Codex", exact: true })
      .getByRole("option", { name: /Personal/ });
    await account.click();
    await expect(account).toContainText(metadata === "unavailable" ? "Usage unavailable" : "62% left");
    await expect(account).toContainText(metadata === "available" ? "Pro" : "Plan unavailable");
    await expect(account).toContainText("Ready");
    await expect(account).not.toContainText(/0%|Low|Exhausted/);
    await expect(launcher).not.toContainText(/resume this thread|couldn't verify.*plan/i);
    await expect(launcher.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
    if (metadata === "unavailable") {
      const results = await new AxeBuilder({ page })
        .include('[role="dialog"]')
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(results.violations).toEqual([]);
      await page.screenshot({ path: "qa/screenshots/provider-launch-usage-unavailable.png" });
    }
    await launcher.getByRole("button", { name: "Launch Codex agent" }).click();
    await expect(launcher).not.toBeVisible();
    await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
    await expect(page.locator("[data-provider-pane]")).toHaveAttribute("aria-label", /Codex agent, account Personal/);
    await expect(page.locator("[data-pane-terminal] .xterm-rows")).toContainText("KalCode fake provider");
  });
}

test("expired Codex reconnect continues the preserved three-agent request in this workspace", async ({ page }) => {
  const launcher = await workspace(page, "unavailable");
  await launcher.getByRole("group", { name: "Codex", exact: true }).getByRole("option", { name: /Work/ }).click();
  await launcher.getByRole("spinbutton", { name: "Agents" }).fill("3");
  await launcher.getByRole("radio", { name: "High", exact: true }).click();
  const models = launcher.getByRole("radiogroup", { name: "Model" }).getByRole("radio");
  await models.last().click();
  const selectedModel = await models.last().textContent();
  await expect(launcher.getByText("Work needs to reconnect.")).toBeVisible();
  await expect(launcher.getByRole("button", { name: "Launch 3 Codex agents" })).toBeDisabled();
  await page.screenshot({ path: "qa/screenshots/provider-launch-inline-reconnect.png" });
  await launcher.getByRole("button", { name: "Reconnect" }).click();
  await expect(launcher).not.toBeVisible();
  const panes = page.locator("[data-provider-pane]");
  await expect(panes).toHaveCount(3);
  const ids = await panes.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-provider-pane")));
  expect(new Set(ids).size).toBe(3);
  for (const pane of await panes.all()) {
    await expect(pane).toHaveAttribute("aria-label", /Codex agent, account .*Work/);
    await expect(pane.locator("[data-pane-terminal] .xterm-rows")).toContainText("KalCode fake provider");
  }
  const sessions = await page.evaluate(async (ids) => {
    const path = "/src/ipc/memoryTransport.ts";
    const { sharedMemoryTransport } = await import(path);
    const transport = sharedMemoryTransport();
    return Promise.all(
      ids.map(async (id) => ({
        record: await transport.invoke("thread_get", { threadId: id }),
        terminal: await transport.invoke("provider_pane_info", { threadId: id }),
      })),
    );
  }, ids);
  expect(new Set(sessions.map(({ terminal }) => terminal.instanceId)).size).toBe(3);
  for (const { record, terminal } of sessions) {
    expect(record.providerId).toBe("codex");
    expect(record.providerAccountId).toBe("0192f3c4-0000-7000-8000-000000000202");
    expect(record.effort).toBe("high");
    expect(record.workspaceName).toBe("account-state-project");
    expect(record.runtimeKind).toBe("interactive_pty");
    expect(record.workspaceId).toBe(sessions[0]?.record.workspaceId);
    expect(terminal).not.toBeNull();
  }
  expect(selectedModel).toBe("Code test exact");
  expect(sessions.map(({ record }) => record.model)).toEqual(["code-test-exact", "code-test-exact", "code-test-exact"]);
  await expect(page.getByText("Open in Threads", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "qa/screenshots/provider-launch-three-terminals.png" });
});
