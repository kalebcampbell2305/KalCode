import { mkdirSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Code's Workspace Dock: Agents plus Browser, Needs You, Runs ... as tabs on the right, resized,
 * reordered, collapsed and restored per workspace without ever touching the agents' terminals.
 * Set KALCODE_DOCK_SHOTS to a folder to also write review screenshots.
 */
const SHOTS = process.env.KALCODE_DOCK_SHOTS ?? "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

type MemoryWindow = Window & { __kalcodeMemory: { runningProcessCount(): number } };

const dock = (page: Page) => page.getByRole("complementary", { name: /^Workspace dock, / });
const collapsedDock = (page: Page) => page.getByRole("complementary", { name: "Workspace dock (collapsed)" });
const tabs = (page: Page) => dock(page).getByRole("tablist", { name: "Dock views" }).getByRole("tab");
const tab = (page: Page, label: string) =>
  dock(page)
    .getByRole("tablist", { name: "Dock views" })
    .getByRole("tab", { name: new RegExp(`^${label}\\s*(,|$)`) });

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function order(page: Page): Promise<string[]> {
  return tabs(page).evaluateAll((els) => els.map((el) => (el.querySelector("span")?.textContent ?? "").trim()));
}

async function openCodeWithAgents(page: Page, count: number) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?scenario=code");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Dark" }).click();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
  for (let i = 0; i < count; i++) {
    await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("button", { name: "Launch Claude Code agent" })
      .click();
    await expect(page.locator("[data-provider-pane]")).toHaveCount(i + 1);
  }
  // The dock follows the agents; make sure it is open on Agents whatever they are doing.
  if (await collapsedDock(page).isVisible()) {
    await collapsedDock(page).getByRole("button", { name: "Show dock", exact: true }).click();
  }
  await expect(dock(page)).toBeVisible();
  await tab(page, "Agents").click();
  await expect(dock(page)).toHaveAccessibleName("Workspace dock, Agents");
}

async function addTab(page: Page, label: string) {
  await dock(page).getByRole("button", { name: "Add to dock", exact: true }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  await expect(tab(page, label)).toBeVisible();
}

async function width(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not laid out");
  return box.width;
}

/** Pointer-drags a tab onto the left (before) or right (after) edge of another. */
async function dragTab(page: Page, from: string, to: string, side: "before" | "after") {
  const source = await tab(page, from).boundingBox();
  const dest = await tab(page, to).boundingBox();
  if (!source || !dest) throw new Error("tabs not laid out");
  const sx = source.x + source.width / 2;
  const sy = source.y + source.height / 2;
  const dx = side === "after" ? dest.x + dest.width - 3 : dest.x + 3;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + (dx > sx ? 8 : -8), sy, { steps: 2 });
  await page.mouse.move(dx, sy, { steps: 8 });
  await page.mouse.up();
}

test("the dock carries Agents, a Browser, Needs You and Runs, and the arrangement survives a reload without restarting agents", async ({
  page,
}) => {
  await openCodeWithAgents(page, 2);
  const paneIds = () =>
    page
      .locator("[data-provider-pane]")
      .evaluateAll((els) => els.map((el) => el.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? ""));
  const beforeIds = await paneIds();
  expect(beforeIds).toHaveLength(2);
  const processes = () =>
    page.evaluate(() => (window as unknown as MemoryWindow).__kalcodeMemory.runningProcessCount());
  const processesBefore = await processes();

  // Fresh agents are idle, and the Idle group starts folded: open it so the rows are on screen.
  await dock(page).getByRole("button", { name: /^Idle/ }).click();
  const agentRows = dock(page).getByRole("button", { name: /Open agent$/ });
  await expect(agentRows.first()).toBeVisible();
  const rowCount = await agentRows.count();
  expect(rowCount).toBeGreaterThanOrEqual(2);
  const defaultWidth = await width(dock(page));
  await shot(page, "1-dock-agents-default");

  // + -> Browser opens the Live Browser right in the dock.
  await addTab(page, "Browser");
  await expect(dock(page)).toHaveAccessibleName("Workspace dock, Browser");
  const browser = dock(page).locator("[data-browser-id]");
  await expect(browser.getByRole("toolbar", { name: "Browser controls" })).toBeVisible();
  await expect(browser.getByLabel("Web address")).toBeVisible();

  // Drag the resize separator wider; terminals keep their room.
  const startWidth = await width(dock(page));
  const handle = dock(page).getByRole("separator", { name: "Resize workspace dock" });
  const hb = await handle.boundingBox();
  if (!hb) throw new Error("no handle");
  const hx = hb.x + Math.min(hb.width / 2, 3);
  const hy = hb.y + hb.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx - 150, hy, { steps: 6 });
  await page.mouse.move(hx - 220, hy, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => width(dock(page))).toBeGreaterThan(startWidth + 40);
  const widened = await width(dock(page));
  expect(await width(page.locator("main#main"))).toBeGreaterThanOrEqual(470);
  await shot(page, "2-dock-browser-widened");

  // Back to Agents: the rows are there at once.
  await tab(page, "Agents").click();
  await expect(agentRows.first()).toBeVisible();
  expect(await agentRows.count()).toBe(rowCount);

  await addTab(page, "Needs You");
  await addTab(page, "Runs");
  expect(await order(page)).toEqual(["Agents", "Browser", "Needs You", "Runs"]);

  // Reorder to Browser | Agents | Runs | Needs You: a pointer drag, then Alt+Arrow.
  await dragTab(page, "Browser", "Agents", "before");
  await expect.poll(() => order(page)).toEqual(["Browser", "Agents", "Needs You", "Runs"]);
  await tab(page, "Runs").focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect.poll(() => order(page)).toEqual(["Browser", "Agents", "Runs", "Needs You"]);

  // Review shot mid-drag: lift Needs You and hold it over Agents, then cancel.
  const lifted = await tab(page, "Needs You").boundingBox();
  const over = await tab(page, "Agents").boundingBox();
  if (lifted && over) {
    await page.mouse.move(lifted.x + lifted.width / 2, lifted.y + lifted.height / 2);
    await page.mouse.down();
    await page.mouse.move(lifted.x + lifted.width / 2 - 12, lifted.y + lifted.height / 2, { steps: 3 });
    await page.mouse.move(over.x + 4, over.y + over.height / 2, { steps: 6 });
    await expect(dock(page).locator("[data-dock-tab][data-drop]")).toHaveCount(1);
    await shot(page, "3-dock-four-tabs-dragging");
    await page.keyboard.press("Escape");
    await page.mouse.up();
  }
  await expect.poll(() => order(page)).toEqual(["Browser", "Agents", "Runs", "Needs You"]);
  await tab(page, "Agents").click();
  await expect(dock(page)).toHaveAccessibleName("Workspace dock, Agents");
  await page.mouse.move(2, 600);
  await shot(page, "3b-dock-four-tabs");

  // Collapse: the rail keeps the four tabs.
  await dock(page).getByRole("button", { name: "Collapse dock" }).click();
  const rail = collapsedDock(page);
  await expect(rail).toBeVisible();
  for (const name of [/^Agents/, /^Browser/, /^Runs/, /^Needs You/]) {
    await expect(rail.getByRole("group", { name: "Dock views" }).getByRole("button", { name })).toBeVisible();
  }
  await page.mouse.move(2, 600);
  await shot(page, "4-dock-collapsed-rail");
  await rail.getByRole("button", { name: "Show dock", exact: true }).click();
  await expect(dock(page)).toBeVisible();
  await expect.poll(async () => Math.abs((await width(dock(page))) - widened)).toBeLessThanOrEqual(2);
  expect(widened).toBeGreaterThan(defaultWidth);

  // Nothing above restarted an agent: the same terminals, the same rows, the same processes.
  expect(await paneIds()).toEqual(beforeIds);
  await expect(page.locator("[data-provider-pane]")).toHaveCount(2);
  await expect(agentRows.first()).toBeVisible();
  expect(await agentRows.count()).toBe(rowCount);
  expect(await processes()).toBe(processesBefore);

  // Reload: the same arrangement, active tab, width and open state come back. The in-memory
  // harness mints a fresh workspace id (and fresh panes) on every load, so the saved layout is
  // handed to the new id's storage read, standing in for the real app's stable workspace id.
  const saved = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("kalcode.workspaceDock.v1.") && !k.endsWith("._"));
    return key ? localStorage.getItem(key) : null;
  });
  expect(saved).not.toBeNull();
  expect(JSON.parse(saved ?? "{}")).toMatchObject({
    tabs: ["browser", "agents", "runs", "needs-you"],
    active: "agents",
    collapsed: false,
  });
  await page.addInitScript((blob) => {
    const read = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key: string) {
      const value = read.call(this, key);
      return value === null && key.startsWith("kalcode.workspaceDock.v1.") && !key.endsWith("._") ? blob : value;
    };
  }, saved);
  await page.reload();
  await expect(dock(page)).toBeVisible();
  await expect.poll(() => order(page)).toEqual(["Browser", "Agents", "Runs", "Needs You"]);
  await expect(dock(page)).toHaveAccessibleName("Workspace dock, Agents");
  await expect(tab(page, "Agents")).toHaveAttribute("aria-selected", "true");
  expect(Math.abs((await width(dock(page))) - widened)).toBeLessThanOrEqual(2);
  expect(await width(page.locator("main#main"))).toBeGreaterThanOrEqual(470);
});

test("a tab's context menu moves it left, and closing Browser's X removes it", async ({ page }) => {
  await openCodeWithAgents(page, 1);
  await addTab(page, "Browser");
  await addTab(page, "Runs");
  expect(await order(page)).toEqual(["Agents", "Browser", "Runs"]);

  await tab(page, "Runs").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move left", exact: true }).click();
  await expect.poll(() => order(page)).toEqual(["Agents", "Runs", "Browser"]);

  await dock(page).getByRole("button", { name: "Close Browser", exact: true }).click();
  await expect(tab(page, "Browser")).toHaveCount(0);
  expect(await order(page)).toEqual(["Agents", "Runs"]);
  await expect(dock(page).locator("[data-browser-id]")).toHaveCount(0);
});
