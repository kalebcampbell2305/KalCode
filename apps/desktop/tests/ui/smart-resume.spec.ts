import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

async function savedDesk(page: Page, failLayout = false, custom = false) {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  return page.evaluate(
    async ({ fail, custom }) => {
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
        schemaVersion: 1,
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
      const stamp = (row: Record<string, unknown>) =>
        row.id === agent.id
          ? {
              ...row,
              status: "interrupted",
              currentActivity: "KalCode closed",
              resumable: false,
              restartRecoverable: true,
              ...(custom ? { permissionMode: "custom" } : {}),
            }
          : row;
      transport.invoke = async (command: string, args: Record<string, unknown>) => {
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
    { fail: failLayout, custom },
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
