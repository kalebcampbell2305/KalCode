import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const OUT = new URL("../../../../docs/release/cursor-provider/", import.meta.url);
mkdirSync(fileURLToPath(OUT), { recursive: true });
// Synthetic discovery result, deliberately not a claim about Cursor's production catalog.
const MODEL = "custom/deepseek-test-9.4?reasoning=high&context=extended";

async function openWorkspace(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.evaluate(async (model) => {
    const path = "/src/ipc/memory/providerAccounts.ts";
    const fixtures = await import(/* @vite-ignore */ path);
    fixtures.cursorModelFixture.splice(0, fixtures.cursorModelFixture.length, {
      id: model,
      displayName: model,
      isDefault: false,
    });
    (
      window as unknown as { __kalcodeMemory: { queueFolders: (...names: string[]) => void } }
    ).__kalcodeMemory.queueFolders("cursor-project");
  }, MODEL);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await page
    .getByRole("button", { name: /^Open folder/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "Workspace cursor-project", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New agent", exact: true })).toBeVisible();
}

for (const [count, width] of [
  [1, 1360],
  [4, 960],
] as const) {
  test(`Cursor launches ${count} independent coding terminals and Fleet focuses them at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 860 });
    await openWorkspace(page);
    await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New agent" });
    const account = dialog.getByRole("group", { name: "Cursor", exact: true }).getByRole("option");
    await expect(account).toHaveCount(1);
    await account.click();
    await expect(account).toHaveAttribute("aria-selected", "true");
    await dialog.getByRole("radio", { name: MODEL, exact: true }).click();
    await expect(dialog.getByRole("radiogroup", { name: "Effort" })).toHaveCount(0);
    await dialog.getByLabel("Agents", { exact: true }).fill(String(count));
    await page.screenshot({ path: fileURLToPath(new URL(`launcher-${width}.png`, OUT)) });
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const violations = (await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(violations).toEqual([]);
    await dialog
      .getByRole("button", { name: count === 1 ? "Launch Cursor agent" : `Launch ${count} Cursor agents`, exact: true })
      .click();
    const panes = page.locator("[data-provider-pane]");
    await expect(panes).toHaveCount(count);
    for (const pane of await panes.all()) {
      await expect(pane).toHaveAttribute("aria-label", /Cursor agent, account Cursor/);
      await expect(pane.locator("[data-pane-terminal] .xterm-rows")).toContainText("KalCode fake provider");
      await expect(pane).toContainText(MODEL);
      await expect(pane.locator("[data-pane-model]")).toBeVisible();
    }
    const ids = await panes.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-provider-pane")));
    expect(new Set(ids).size).toBe(count);
    await page.screenshot({ path: fileURLToPath(new URL(`terminals-${width}.png`, OUT)) });
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Dashboard", exact: true })
      .click();
    await expect(page.getByRole("article")).toHaveCount(count);
    await page.getByRole("article").first().getByRole("heading").getByRole("button").click();
    await expect(page.getByRole("button", { name: "Workspace cursor-project", exact: true })).toBeVisible();
    await expect(panes).toHaveCount(count);
    await expect(panes.first()).toBeVisible();
    await expect(page.getByText("Open in Threads", { exact: true })).toHaveCount(0);
  });
}

test("Cursor account usage remains unavailable and the account center offers no duplicate native sign-in", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Account and usage center" }).click();
  const center = page.getByRole("dialog", { name: "Accounts & usage" });
  const account = center.getByRole("region", { name: /^Cursor .* Cursor$/ });
  await expect(account.getByText("Usage unavailable", { exact: true })).toBeVisible();
  await expect(account).not.toContainText(/\d+% left/);
  await account.getByRole("button", { name: "Account details" }).click();
  await expect(account.getByRole("button", { name: /Sign out/ })).toHaveCount(0);
  await page.screenshot({ path: fileURLToPath(new URL("accounts-1360.png", OUT)) });
  await center.getByRole("button", { name: "Add account", exact: true }).click();
  await expect(center.getByRole("combobox", { name: "Provider" }).locator('option[value="cursor"]')).toHaveCount(0);
});
