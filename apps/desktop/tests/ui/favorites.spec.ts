import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { goTo } from "./nav.ts";

const storageKey = "kalcode:favorites:v1";
async function openPalette(page: Page) {
  await page.keyboard.press("Control+k");
  return page.getByRole("dialog", { name: "Command palette" });
}

test("global pins persist, reorder by keyboard, and open a command without executing it", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#main")).toHaveAttribute("data-surface", "dashboard");
  let palette = await openPalette(page);
  await palette.getByRole("combobox").fill("New agent");
  await palette.getByRole("button", { name: "Pin globally: New agent", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New agent", exact: true })).toHaveCount(0);
  await palette.getByRole("combobox").fill("Browser");
  await palette.getByRole("button", { name: "Pin globally: Browser", exact: true }).click();
  await page.keyboard.press("Escape");
  const pins = page.getByRole("list", { name: "Global pins" });
  await expect(pins.getByRole("button")).toHaveCount(2);
  const agent = pins.getByRole("button", { name: /New agent/ });
  await agent.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(pins.getByRole("button").first()).toHaveText("Browser");
  await page.reload();
  await expect(pins.getByRole("button").first()).toHaveText("Browser");
  await pins.getByRole("button", { name: /New agent/ }).click();
  palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette.getByRole("combobox")).toHaveValue(/New agent/);
  await expect(page.getByRole("dialog", { name: "New agent", exact: true })).toHaveCount(0);
  const audit = await new AxeBuilder({ page }).include("[data-favorites-bar]").include('[role="dialog"]').analyze();
  expect(audit.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "test-results/favorites-strip.png" });
  await pins.getByRole("button", { name: "Browser", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpin globally", exact: true }).click();
  await expect(pins.getByRole("button")).toHaveCount(1);
});

test("missing targets remain visible and recoverable after restart", async ({ page }) => {
  await page.addInitScript((key) => {
    if (!localStorage.getItem(key))
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          entries: [
            {
              target: { kind: "workspace", id: "missing-workspace", workspaceId: "missing-workspace" },
              title: "Old project",
              scopeId: null,
            },
          ],
        }),
      );
  }, storageKey);
  await page.goto("/");
  const missing = page
    .getByRole("list", { name: "Global pins" })
    .getByRole("button", { name: "Old project: Unavailable" });
  await expect(missing).toBeVisible();
  await missing.click();
  await expect(page.getByText(/Your favorite is still saved/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await page.reload();
  await expect(missing).toBeVisible();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").entries.length, storageKey)).toBe(
    1,
  );
});

test("favorites follow the active workspace while global pins remain", async ({ page }) => {
  await page.goto("/?scenario=rail");
  await expect(page.getByRole("button", { name: "Workspace kalcode", exact: true })).toBeVisible();
  const palette = await openPalette(page);
  await palette.getByRole("combobox").fill("Browser");
  await palette.getByRole("button", { name: "Add Favorite: Browser", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("list", { name: "Workspace favorites" }).getByRole("button", { name: "Browser", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Workspace kalcode", exact: true }).click();
  await page.getByRole("menuitemradio", { name: /atlas-api/ }).click();
  await expect(page.getByRole("list", { name: "Workspace favorites" })).toHaveCount(0);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").entries.length, storageKey)).toBe(
    1,
  );
  await page.getByRole("button", { name: "Workspace atlas-api", exact: true }).click();
  await page.getByRole("menuitemradio", { name: /kalcode/ }).click();
  await expect(page.getByRole("list", { name: "Workspace favorites" })).toBeVisible();
});

test("an agent favorite restores its existing Code pane without duplicating the session", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#main")).toHaveAttribute("data-surface", "dashboard");
  await page.evaluate(() => {
    (
      window as unknown as { __kalcodeMemory: { queueFolders: (...names: string[]) => void } }
    ).__kalcodeMemory.queueFolders("favorite-agent");
  });
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await navigation.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: "Open folder…" }).first().click();
  await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New agent" })
    .getByRole("button", { name: "Launch Claude Code agent" })
    .click();
  await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
  const original = await page.locator("[data-provider-pane]").getAttribute("data-provider-pane");
  const tabStar = page.locator("[data-pane-id] [data-favorite-action]").last();
  await tabStar.click();
  const favorite = page.getByRole("list", { name: "Workspace favorites" }).getByRole("button");
  await expect(favorite).toHaveCount(1);
  await goTo(page, "Threads");
  await favorite.click();
  await expect(page.locator("#main")).toHaveAttribute("data-surface", "code");
  await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
  expect(await page.locator("[data-provider-pane]").getAttribute("data-provider-pane")).toBe(original);
  await expect(page.getByRole("dialog", { name: "New agent" })).toHaveCount(0);
  const audit = await new AxeBuilder({ page }).include("[data-favorites-bar]").include('[role="tablist"]').analyze();
  expect(audit.violations).toEqual([]);
});
