import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

async function savedDesk(page: Page, failLayout = false, custom = false, corruptLayout = false, pendingInput = false) {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  return page.evaluate(
    async ({ fail, custom, corrupt, pendingInput }) => {
      const path = "/src/ipc/memoryTransport.ts";
      const { sharedMemoryTransport } = await import(path);
      const transport = sharedMemoryTransport();
      transport.workspaces.queueFolders("Continuity Lab");
      const workspace = await transport.invoke("workspace_open_dialog", {});
      const agent = await transport.invoke("provider_pane_create", {
        providerId: "codex",
        workspaceId: workspace.id,
        permissionMode: "bypass",
        model: null,
        effort: null,
        providerAccountId: null,
        name: null,
      });
      await transport.invoke("thread_rename", { threadId: agent.id, name: "Restore project desk" });
      await transport.invoke("thread_stop", { threadId: agent.id });
      const layout = {
        schemaVersion: corrupt ? 999 : 1,
        root: {
          kind: "leaf",
          paneId: "saved-pane",
          tabs: [{ kind: "agent", agentId: agent.id }],
          activeTab: 0,
          collapsed: false,
        },
        maximizedPaneId: null,
        dock: [],
      };
      transport.layouts.seed(workspace.id, layout);
      const original = transport.invoke.bind(transport);
      const resumed: Record<string, unknown>[] = [];
      (window as unknown as { recoveryResumes: Record<string, unknown>[] }).recoveryResumes = resumed;
      const stamp = (row: Record<string, unknown>) =>
        row.id === agent.id && resumed.length === 0
          ? {
              ...row,
              status: "interrupted",
              currentActivity: "KalCode closed",
              resumable: pendingInput,
              restartRecoverable: true,
              resumeHasPendingInput: pendingInput,
              ...(custom ? { permissionMode: "custom" } : {}),
            }
          : row;
      transport.invoke = async (command: string, args: Record<string, unknown>) => {
        if (command === "thread_resume") resumed.push(args);
        if (command === "layout_get" && corrupt) {
          const saved = transport.layouts.stored(workspace.id);
          if (saved?.schemaVersion !== 1) {
            return {
              workspaceId: workspace.id,
              schemaVersion: 999,
              layout: saved,
              updatedAt: new Date().toISOString(),
            };
          }
        }
        if (command === "layout_get" && fail && !(window as unknown as { allowLayoutRead?: boolean }).allowLayoutRead) {
          throw {
            category: "storage",
            code: "temporarily_unavailable",
            message: "Storage is temporarily unavailable.",
            retryable: true,
          };
        }
        if (command === "provider_pane_info" && args.threadId === agent.id) return null;
        const result = await original(command, args);
        if (command === "thread_list") return result.map(stamp);
        if (command === "thread_get") return stamp(result);
        return result;
      };
      return { workspaceId: workspace.id, agentId: agent.id };
    },
    { fail: failLayout, custom, corrupt: corruptLayout, pendingInput },
  );
}

test("manual startup keeps the saved desk one click away", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("kalcode:desk-restore:v1:account_test_owner", "manual"));
  await page.goto("/?scenario=code");
  await expect(page.locator("#main")).toHaveAttribute("data-surface", "dashboard");
  await page.getByRole("button", { name: "Continue where I left off" }).click();
  await expect(page.locator("#main")).toHaveAttribute("data-surface", "code");
  await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
});

test("a full saved desk stays interactive while provider metadata is unavailable", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/ipc/memoryTransport.ts";
    const { sharedMemoryTransport } = await import(path);
    const transport = sharedMemoryTransport();
    transport.workspaces.queueFolders("Full saved desk");
    const workspace = await transport.invoke("workspace_open_dialog", {});
    const children = [];
    for (let i = 0; i < 32; i++) {
      const agent = await transport.invoke("provider_pane_create", {
        providerId: "codex",
        workspaceId: workspace.id,
        permissionMode: "bypass",
        model: null,
        effort: null,
        providerAccountId: null,
        name: `Saved agent ${i + 1}`,
      });
      await transport.invoke("thread_stop", { threadId: agent.id });
      children.push({
        kind: "leaf",
        paneId: `full-desk-${i}`,
        tabs: [{ kind: "agent", agentId: agent.id }],
        activeTab: 0,
        collapsed: false,
      });
    }
    const modelPath = "/src/shell/panes/model.ts";
    const { toRatios } = await import(modelPath);
    transport.layouts.seed(workspace.id, {
      schemaVersion: 1,
      root: { kind: "split", axis: "horizontal", ratios: toRatios(children.map(() => 1)), children },
      maximizedPaneId: null,
      dock: [],
    });
    const original = transport.invoke.bind(transport);
    transport.invoke = (command: string, args: Record<string, unknown>) =>
      command === "provider_pane_info" ? new Promise(() => {}) : original(command, args);
    const samples: number[] = [];
    (window as unknown as { deskNavigationSamples: number[] }).deskNavigationSamples = samples;
    let clickedAt = 0;
    document.addEventListener(
      "click",
      () => {
        clickedAt = performance.now();
      },
      true,
    );
    new MutationObserver(() => {
      const started = clickedAt;
      if (started) requestAnimationFrame(() => samples.push(performance.now() - started));
    }).observe(document.querySelector("#main") as Element, {
      attributes: true,
      attributeFilter: ["data-surface"],
    });
  });
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await navigation.getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.locator('[data-pane-id^="full-desk-"]')).toHaveCount(32);
  for (let i = 0; i < 5; i++) {
    await navigation.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator("#main")).toHaveAttribute("data-surface", "settings");
    await navigation.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.locator("#main")).toHaveAttribute("data-surface", "code");
  }
  const samples = await page.evaluate(() =>
    (window as unknown as { deskNavigationSamples: number[] }).deskNavigationSamples.slice().sort((a, b) => a - b),
  );
  expect(samples.length).toBeGreaterThanOrEqual(10);
  await testInfo.attach("full-desk-navigation-latency", {
    body: JSON.stringify({
      panes: 32,
      metadata: "unresolved",
      samples,
      p50: samples[Math.floor(samples.length / 2)],
      p95: samples[Math.ceil(samples.length * 0.95) - 1],
    }),
    contentType: "application/json",
  });
});

test("the startup preference persists through the rendered Settings control", async ({ page }) => {
  await page.goto("/?scenario=code");
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  const restore = page.getByRole("radiogroup", { name: "Restore my desk on startup" });
  await restore.getByRole("radio", { name: "When I choose", exact: true }).click();
  await expect(restore.getByRole("radio", { name: "When I choose", exact: true })).toBeChecked();
  await page.screenshot({ path: "qa/screenshots/smart-resume-settings.png" });
  await page.reload();
  await expect(page.locator("#main")).toHaveAttribute("data-surface", "dashboard");
  await expect(page.getByRole("button", { name: "Continue where I left off", exact: true })).toBeVisible();
});

test("historical agents have a truthful fresh-session action instead of endless Connecting", async ({ page }) => {
  await savedDesk(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.locator('[data-pane-id="saved-pane"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Start fresh session", exact: true })).toBeVisible();
  await expect(page.getByText("Connecting…", { exact: true })).toHaveCount(0);
  const a11y = await new AxeBuilder({ page }).include("#main").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(a11y.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await page.screenshot({ path: "qa/screenshots/smart-resume-historical.png" });
  await page.getByRole("button", { name: "Start fresh session", exact: true }).click();
  await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
  await expect(page.getByText(/Some agents need a fresh start/)).toHaveCount(0);
  await expect(page.locator("[data-pane-terminal] .xterm-rows").last()).toContainText("KalCode fake provider");
});

test("transient layout failure offers recovery without replacing the saved layout", async ({ page }) => {
  const desk = await savedDesk(page, true);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.getByText("Your saved desk couldn't load", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(async (id) => {
      const path = "/src/ipc/memoryTransport.ts";
      return (await import(path)).sharedMemoryTransport().layouts.stored(id).root.paneId;
    }, desk.workspaceId),
  ).toBe("saved-pane");
  await page.evaluate(() => {
    (window as unknown as { allowLayoutRead: boolean }).allowLayoutRead = true;
  });
  await page.getByRole("button", { name: "Retry restore", exact: true }).click();
  await expect(page.locator('[data-pane-id="saved-pane"]')).toBeVisible();
  await expect(page.getByText("Your saved desk couldn't load", { exact: true })).toHaveCount(0);
});

test("a corrupt saved desk can be explicitly reset without stopping its sessions", async ({ page }) => {
  const desk = await savedDesk(page, false, false, true);
  await page.evaluate(async () => {
    const path = "/src/ipc/memoryTransport.ts";
    const transport = (await import(path)).sharedMemoryTransport();
    const invoke = transport.invoke.bind(transport);
    const stopped: string[] = [];
    (window as unknown as { resetStopped: string[] }).resetStopped = stopped;
    transport.invoke = async (command: string, args: Record<string, unknown>) => {
      if (command === "thread_stop" || command === "terminal_stop") stopped.push(command);
      return invoke(command, args);
    };
  });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.getByText("Your saved desk couldn't load", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset saved layout", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Reset saved pane arrangement?" });
  await expect(dialog).toContainText("Running terminals and agents stay open.");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const savedVersion = () =>
    page.evaluate(async (id) => {
      const path = "/src/ipc/memoryTransport.ts";
      return (await import(path)).sharedMemoryTransport().layouts.stored(id).schemaVersion;
    }, desk.workspaceId);
  expect(await savedVersion()).toBe(999);
  await page.getByRole("button", { name: "Reset saved layout", exact: true }).click();
  await page.screenshot({ path: "qa/screenshots/smart-resume-reset-confirm.png" });
  await dialog.getByRole("button", { name: "Reset saved layout", exact: true }).click();
  await expect(page.getByText("Your saved desk couldn't load", { exact: true })).toHaveCount(0);
  expect(await savedVersion()).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { resetStopped: string[] }).resetStopped)).toEqual([]);
  await page.screenshot({ path: "qa/screenshots/smart-resume-reset-desk.png" });
});

test("startup and generic Continue preserve queued input until Resume queued task", async ({ page }) => {
  const desk = await savedDesk(page, false, false, false, true);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await expect(
    page.getByText(
      "1 agent has a queued prompt. Automatic restore leaves it unsent. Choose Resume queued task to continue.",
    ),
  ).toBeVisible();
  const resumeCalls = () =>
    page.evaluate(() => (window as unknown as { recoveryResumes: Record<string, unknown>[] }).recoveryResumes);
  expect(await resumeCalls()).toEqual([]);
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await navigation.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("radiogroup", { name: "Restore my desk on startup" })
    .getByRole("radio", { name: "When I choose", exact: true })
    .click();
  await navigation.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "Continue where I left off", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume queued task", exact: true })).toBeVisible();
  expect(await resumeCalls()).toEqual([]);
  await page.screenshot({ path: "qa/screenshots/smart-resume-queued-task.png" });
  await page.getByRole("button", { name: "Resume queued task", exact: true }).click();
  await expect.poll(async () => (await resumeCalls()).length).toBe(1);
  expect(await resumeCalls()).toEqual([expect.objectContaining({ threadId: desk.agentId, allowPendingInput: true })]);
});

test("historical Custom sessions open the existing launcher for an explicit fresh configuration", async ({ page }) => {
  const desk = await savedDesk(page, false, true);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "Start fresh session", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Choose settings for the fresh session", { exact: true })).toBeVisible();
  await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Launch .* agent$/, exact: false })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
  await expect(page.locator("[data-provider-pane]")).not.toHaveAttribute("data-provider-pane", desk.agentId);
  await expect(
    page.locator("[data-provider-pane]").getByText("Restore project desk", { exact: true }).first(),
  ).toBeVisible();
  const records = await page.evaluate(async (workspaceId) => {
    const path = "/src/ipc/memoryTransport.ts";
    return (await import(path)).sharedMemoryTransport().invoke("thread_list", { workspaceId });
  }, desk.workspaceId);
  expect(records).toHaveLength(2);
  expect(records.find((row: { id: string }) => row.id === desk.agentId).status).toBe("interrupted");
});
