import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * The pane system (Z7-W1) against the in-memory runtime: splits, keyboard and pointer resizing,
 * focus traversal, maximize / collapse / close / reopen (processes keep running), tabs moved
 * between panes, presets, saved layouts, per-workspace persistence, 20+ panes with offscreen
 * views suspended, the KalVoice shell slot, and axe in both themes (Z7-13, Z7-14, Z7-22, Z7-25).
 */

type Memory = {
  runningProcessCount: () => number;
  layouts: {
    stored: (workspaceId: string) => unknown;
    saves: () => number;
    seed: (workspaceId: string, layout: unknown) => void;
  };
};

async function openCode(page: Page, query = "?scenario=code") {
  await page.goto(`/${query}`);
  await expect(page.locator("#main")).toHaveAttribute("data-surface", "code");
  await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
  await expect(panes(page)).toHaveCount(1);
}

const canvas = (page: Page) => page.getByRole("group", { name: /^Panes in / });
const panes = (page: Page) => page.locator("[data-pane-id]:not([hidden])");
const pane = (page: Page, n: number) => panes(page).nth(n);
const focusedPane = (page: Page) => page.locator("[data-pane-id][data-focused]");
const separators = (page: Page) => page.getByRole("separator");
const terminalText = (scope: Locator) => scope.locator('[role="tabpanel"] .xterm-rows');

const memory = <T>(page: Page, fn: (m: Memory) => T) =>
  page.evaluate(`(${fn.toString()})(window.__kalcodeMemory)`) as Promise<T>;

async function workspaceId(page: Page): Promise<string> {
  const id = await page.locator("[data-workspace-id]").getAttribute("data-workspace-id");
  if (!id) throw new Error("no workspace id");
  return id;
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not visible");
  return b;
}

async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    serious,
    JSON.stringify(
      serious.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
      null,
      2,
    ),
  ).toEqual([]);
}

test.describe("splitting and resizing", () => {
  test("splits side by side and stacked, from the keyboard and the pane controls", async ({ page }) => {
    await openCode(page);
    await page.keyboard.press("Control+Alt+d");
    await expect(panes(page)).toHaveCount(2);
    const a = await box(pane(page, 0));
    const b = await box(pane(page, 1));
    expect(b.x).toBeGreaterThan(a.x + a.width - 1);
    // The new pane has focus and offers what can be opened there.
    await expect(focusedPane(page).getByRole("heading", { name: "Empty pane" })).toBeVisible();

    await page.keyboard.press("Control+Alt+Shift+D");
    await expect(panes(page)).toHaveCount(3);
    const c = await box(pane(page, 2));
    expect(c.y).toBeGreaterThan(b.y + 20);

    await pane(page, 0).getByRole("button", { name: "Actions for pane 1" }).click();
    await page.getByRole("menuitem", { name: "Split down" }).click();
    await expect(panes(page)).toHaveCount(4);
    // Every pane shows its own tab strip; the terminals stayed in the first pane.
    await expect(pane(page, 0).getByRole("tab", { name: /PowerShell 7/ })).toBeVisible();
  });

  test("a divider resizes with the arrow keys (Alt too), Home/End and Enter, and reports its value", async ({
    page,
  }) => {
    await openCode(page);
    await page.keyboard.press("Control+Alt+d");
    const divider = separators(page).first();
    await expect(divider).toHaveAttribute("aria-orientation", "vertical");
    await expect(divider).toHaveAttribute("aria-valuenow", "50");
    await expect(divider).toHaveAccessibleName(/Resize PowerShell 7 and Empty pane/);
    await divider.focus();
    const before = (await box(pane(page, 0))).width;
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Alt+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    expect((await box(pane(page, 0))).width).toBeCloseTo(before + 24 + 24 + 96, -1);
    expect(Number(await divider.getAttribute("aria-valuenow"))).toBeGreaterThan(55);
    await page.keyboard.press("End");
    expect((await box(pane(page, 1))).width).toBeCloseTo(320, 0);
    await page.keyboard.press("Home");
    expect((await box(pane(page, 0))).width).toBeCloseTo(320, 0);
    await page.keyboard.press("Enter");
    await expect(divider).toHaveAttribute("aria-valuenow", "50");
  });

  test("a divider drags with the pointer and panes keep a minimum size", async ({ page }) => {
    await openCode(page);
    await page.keyboard.press("Control+Alt+d");
    const divider = separators(page).first();
    const d = await box(divider);
    const before = (await box(pane(page, 0))).width;
    await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
    await page.mouse.down();
    await page.mouse.move(d.x + d.width / 2 - 200, d.y + d.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await box(pane(page, 0))).width).toBeLessThan(before - 150);
    // Dragging far past the edge stops at the minimum.
    const d2 = await box(divider);
    await page.mouse.move(d2.x + 3, d2.y + 100);
    await page.mouse.down();
    await page.mouse.move(-500, d2.y + 100, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await box(pane(page, 0))).width)).toBeGreaterThanOrEqual(139);
  });

  test("Ctrl+Alt+Shift+arrows grow the focused pane; Ctrl+Alt+arrows move focus", async ({ page }) => {
    await openCode(page);
    await page.keyboard.press("Control+Alt+d");
    await expect(focusedPane(page)).toHaveAttribute(
      "data-pane-id",
      (await pane(page, 1).getAttribute("data-pane-id")) ?? "",
    );
    const before = (await box(pane(page, 1))).width;
    await page.keyboard.press("Control+Alt+Shift+ArrowLeft");
    await page.keyboard.press("Control+Alt+Shift+ArrowLeft");
    expect((await box(pane(page, 1))).width).toBeCloseTo(before + 64, -1);
    await page.keyboard.press("Control+Alt+ArrowLeft");
    await expect(focusedPane(page)).toHaveAttribute(
      "data-pane-id",
      (await pane(page, 0).getAttribute("data-pane-id")) ?? "",
    );
    await expect(page.getByRole("status").filter({ hasText: "PowerShell 7 pane." })).toHaveCount(1);
    // Focus landed in the pane's terminal: typing reaches the shell.
    await page.keyboard.type("echo in-left-pane");
    await page.keyboard.press("Enter");
    await expect(terminalText(pane(page, 0))).toContainText("in-left-pane");
  });
});

test.describe("maximize, collapse, close and reopen never stop a process", () => {
  test("maximize shows one pane; the others' views stay mounted but hidden and come back with their output", async ({
    page,
  }) => {
    await openCode(page);
    await pane(page, 0).locator(".xterm-screen").click();
    await page.keyboard.type("echo before-maximize");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+Alt+d");
    await page.getByRole("button", { name: "New terminal" }).click();
    await expect(page.locator(".xterm")).toHaveCount(2);
    const running = await memory(page, (m) => m.runningProcessCount());

    await page.keyboard.press("Control+Alt+Enter");
    await expect(panes(page)).toHaveCount(1);
    // The other terminal keeps its view (no rebuild on restore), hidden behind the maximized pane.
    await expect(page.locator(".xterm:visible")).toHaveCount(1);
    await expect(page.locator(".xterm")).toHaveCount(2);
    await expect(panes(page).first()).toHaveAttribute("data-maximized", "true");
    expect(await memory(page, (m) => m.runningProcessCount())).toBe(running);

    await page.getByRole("button", { name: /^Restore pane/ }).click();
    await expect(panes(page)).toHaveCount(2);
    await expect(terminalText(pane(page, 0))).toContainText("before-maximize");
  });

  test("collapse leaves the header; expanding brings the terminal back", async ({ page }) => {
    await openCode(page);
    await page.keyboard.press("Control+Alt+d");
    await pane(page, 0).getByRole("button", { name: "Actions for pane 1" }).click();
    await page.getByRole("menuitem", { name: "Collapse" }).click();
    const collapsed = page.locator("[data-pane-id][data-collapsed]");
    await expect(collapsed).toHaveCount(1);
    expect((await box(collapsed)).width).toBeLessThan(40);
    // The collapsed pane's terminal keeps its view, hidden; nothing is shown in it.
    await expect(page.locator("[data-pane-id][data-collapsed] .xterm:visible")).toHaveCount(0);
    const expand = collapsed.getByRole("button", { name: /^Expand PowerShell 7/ });
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expand.click();
    await expect(page.locator("[data-pane-id][data-collapsed]")).toHaveCount(0);
    await expect(terminalText(pane(page, 0))).toContainText("First release");
  });

  test("closing a pane ends its shells; nothing keeps running in the background", async ({ page }) => {
    await openCode(page);
    await page.keyboard.press("Control+Alt+d");
    await page.getByRole("button", { name: "New terminal" }).click();
    await expect(pane(page, 1).getByRole("tab", { name: /PowerShell 7 \(2\)/ })).toBeVisible();
    await page.keyboard.type("echo end-me");
    await page.keyboard.press("Enter");
    const running = await memory(page, (m) => m.runningProcessCount());

    await page.getByRole("button", { name: "Close pane 2" }).click();
    await page.getByRole("button", { name: "Stop and Close", exact: true }).click();
    await expect(panes(page)).toHaveCount(1);
    await expect.poll(() => memory(page, (m) => m.runningProcessCount())).toBe(running - 1);
    await expect(page.getByRole("status").filter({ hasText: /keeps running/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /in background/ })).toHaveCount(0);
  });
});

test.describe("tabs and drag and drop", () => {
  test("a tab dragged onto another pane's edge gets its own pane; onto its tabs it joins them", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openCode(page);
    await page.keyboard.press("Control+Alt+d");
    await expect(panes(page)).toHaveCount(2);
    const gitBash = pane(page, 0).getByRole("tab", { name: /Git Bash/ });
    // The header settles once the agent launcher is offered; measure only after it appears and the
    // tab holds still as the element under its own centre.
    await expect(page.getByRole("button", { name: "New agent", exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        const before = await box(gitBash);
        await page.waitForTimeout(100);
        const after = await box(gitBash);
        if (before.x !== after.x || before.y !== after.y) return false;
        const centre = { x: after.x + after.width / 2, y: after.y + after.height / 2 };
        return gitBash.evaluate((tab, point) => tab.contains(document.elementFromPoint(point.x, point.y)), centre);
      })
      .toBe(true);
    const target = await box(pane(page, 1));
    const from = await box(gitBash);
    // Onto the bottom edge of the right pane: a new pane below it.
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // A resize/render between pointerdown and the first move must not retain stale hit-test geometry.
    // Window and wrapping-header changes can produce the same two-dimensional resize in production.
    const surface = canvas(page);
    const surfaceBefore = await box(surface);
    await surface.evaluate(
      (element, next) => {
        const htmlElement = element as HTMLElement;
        htmlElement.style.flex = "none";
        htmlElement.style.width = `${next.width}px`;
        htmlElement.style.height = `${next.height}px`;
      },
      { width: surfaceBefore.width - 40, height: surfaceBefore.height - 180 },
    );
    await expect.poll(async () => (await box(pane(page, 1))).width).toBeLessThan(target.width - 10);
    await expect.poll(async () => (await box(pane(page, 1))).height).toBeLessThan(target.height - 150);
    const resizedSurface = await box(surface);
    const resizedTarget = await box(pane(page, 1));
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("The desktop UI test must have a bounded viewport.");
    const reachable = {
      left: Math.max(resizedSurface.x, resizedTarget.x, 0),
      right: Math.min(resizedSurface.x + resizedSurface.width, resizedTarget.x + resizedTarget.width, viewport.width),
      top: Math.max(resizedSurface.y, resizedTarget.y, 0),
      bottom: Math.min(
        resizedSurface.y + resizedSurface.height,
        resizedTarget.y + resizedTarget.height,
        viewport.height,
      ),
    };
    expect(reachable.right - reachable.left).toBeGreaterThan(60);
    expect(reachable.bottom - reachable.top).toBeGreaterThan(60);
    const reachableBottomPoint = {
      x: (reachable.left + reachable.right) / 2,
      y: reachable.bottom - 30,
    };
    expect(reachableBottomPoint.x).toBeGreaterThan(reachable.left);
    expect(reachableBottomPoint.x).toBeLessThan(reachable.right);
    expect(reachableBottomPoint.y).toBeGreaterThan(reachable.top);
    expect(reachableBottomPoint.y).toBeLessThan(reachable.bottom);
    await page.mouse.move(reachableBottomPoint.x, reachableBottomPoint.y, { steps: 12 });
    await expect(page.locator('[class*="dropZone"]')).toHaveAttribute("data-zone", "bottom");
    await page.mouse.up();
    await expect(panes(page)).toHaveCount(3);
    await expect(pane(page, 2).getByRole("tab", { name: /Git Bash/ })).toHaveAttribute("aria-selected", "true");
    await expect(pane(page, 0).getByRole("tab", { name: /Git Bash/ })).toHaveCount(0);

    // Onto the first pane's tab strip: it joins those tabs; the emptied pane closes.
    const back = await box(pane(page, 2).getByRole("tab", { name: /Git Bash/ }));
    const strip = await box(pane(page, 0).getByRole("tablist"));
    await page.mouse.move(back.x + back.width / 2, back.y + back.height / 2);
    await page.mouse.down();
    await page.mouse.move(strip.x + strip.width + 20, strip.y + strip.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(panes(page)).toHaveCount(2);
    await expect(pane(page, 0).getByRole("tab", { name: /Git Bash/ })).toHaveAttribute("aria-selected", "true");
  });

  test("keyboard: tabs move with the arrow keys, Ctrl+Alt+PageDown cycles, panes swap from the menu", async ({
    page,
  }) => {
    await openCode(page);
    await page.keyboard.press("Control+Shift+E");
    await expect(pane(page, 0).getByRole("tab", { name: /^PowerShell 7/ })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(pane(page, 0).getByRole("tab", { name: /Git Bash/ })).toBeFocused();
    await page.keyboard.press("Control+Alt+PageDown");
    await expect(pane(page, 0).getByRole("tab", { name: /Command Prompt/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Control+Alt+d");
    await pane(page, 1).getByRole("button", { name: "Actions for pane 2" }).click();
    await page.getByRole("menuitem", { name: "Move pane left" }).click();
    await expect(pane(page, 1).getByRole("tab", { name: /Command Prompt/ })).toBeVisible();
    await expect(pane(page, 0).getByRole("heading", { name: "Empty pane" })).toBeVisible();
  });
});

test.describe("the side dock", () => {
  test("a pane moved to the dock keeps running and opens back into a pane", async ({ page }) => {
    await openCode(page);
    await page.keyboard.press("Control+Alt+d");
    await page.getByRole("button", { name: "New terminal" }).click();
    await expect(pane(page, 1).getByRole("tab", { name: /PowerShell 7 \(2\)/ })).toBeVisible();
    const running = await memory(page, (m) => m.runningProcessCount());
    await pane(page, 1).getByRole("button", { name: "Actions for pane 2" }).click();
    await page.getByRole("menuitem", { name: "Move to the dock" }).click();
    const dock = page.getByRole("complementary", { name: "Dock" });
    await expect(dock).toBeVisible();
    await expect(panes(page)).toHaveCount(1);
    expect(await memory(page, (m) => m.runningProcessCount())).toBe(running);
    // The canvas makes room for the dock.
    expect((await box(pane(page, 0))).x + (await box(pane(page, 0))).width).toBeLessThan((await box(dock)).x);
    await dock.getByRole("button", { name: "Open PowerShell 7 (2)" }).click();
    await expect(dock).toHaveCount(0);
    await expect(pane(page, 0).getByRole("tab", { name: /PowerShell 7 \(2\)/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

test.describe("content from other surfaces", () => {
  test("the live Dashboard and a widget open as panes; a Dashboard card focuses a provider pane", async ({ page }) => {
    await openCode(page);
    await page.keyboard.press("Control+Alt+d");
    await pane(page, 1).getByRole("button", { name: "Add to pane 2" }).click();
    await page.getByRole("menuitem", { name: "Dashboard" }).click();
    await expect(pane(page, 1).locator("[data-dashboard-pane]")).toBeVisible();
    await expect(pane(page, 1).getByRole("tab", { name: "Dashboard" })).toHaveAttribute("aria-selected", "true");
    await pane(page, 1).getByRole("button", { name: "Add to pane 2" }).click();
    await page.getByRole("menuitem", { name: "Provider health" }).click();
    await expect(pane(page, 1).locator("[data-widget-pane]")).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    // A provider pane, hidden in the background, is brought back and focused by its focus request.
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New agent" })
      .getByRole("button", { name: "Launch Claude Code agent" })
      .click();
    const provider = page.locator("[data-provider-pane]");
    await expect(provider).toBeVisible();
    const threadId = await provider.getAttribute("data-provider-pane");
    await page.keyboard.press("Control+Alt+w");
    await page.getByRole("button", { name: "Keep Running", exact: true }).click();
    await expect(provider).toHaveCount(0);
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Dashboard" }).click();
    const card = page.locator(`article[data-thread-id="${threadId}"]:visible`);
    await expect(card).toBeVisible();
    await card.click({ position: { x: 6, y: 6 } });
    await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
    await expect(page.locator("[data-provider-pane]")).toBeVisible();
    await expect(page.locator("[data-pane-id][data-focused] [data-provider-pane]")).toHaveCount(1);
  });
});

test.describe("presets and saved layouts", () => {
  test("presets 2, 3, 4 and 6 rearrange the panes without closing anything", async ({ page }) => {
    await openCode(page);
    const running = await memory(page, (m) => m.runningProcessCount());
    for (const [key, n] of [
      ["6", 6],
      ["4", 4],
      ["3", 3],
      ["2", 2],
    ] as const) {
      await page.keyboard.press(`Control+Alt+${key}`);
      await expect(panes(page)).toHaveCount(n);
      await expect(page.getByRole("status").filter({ hasText: `Arranged ${n} panes` })).toHaveCount(1);
    }
    await expect(pane(page, 0).getByRole("tab")).toHaveCount(3);
    expect(await memory(page, (m) => m.runningProcessCount())).toBe(running);
    await page.getByRole("button", { name: "Layout" }).click();
    await expect(page.getByRole("menuitemradio", { name: "2 panes" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("menuitemradio", { name: /6 panes/ }).click();
    await expect(panes(page)).toHaveCount(6);
  });

  test("a layout is saved by name and applied later", async ({ page }) => {
    await openCode(page);
    await page.keyboard.press("Control+Alt+3");
    await page.getByRole("button", { name: "Layout" }).click();
    await page.getByRole("menuitem", { name: "Save this layout…" }).click();
    await page.getByRole("textbox", { name: "Layout name" }).fill("Three up");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved the layout as Three up." })).toHaveCount(1);
    await page.keyboard.press("Control+Alt+2");
    await expect(panes(page)).toHaveCount(2);
    await page.getByRole("button", { name: "Layout" }).click();
    await page.getByRole("menuitem", { name: /^Three up/ }).click();
    await expect(panes(page)).toHaveCount(3);
    // A duplicate name is refused with the reason.
    await page.getByRole("button", { name: "Layout" }).click();
    await page.getByRole("menuitem", { name: "Save this layout…" }).click();
    await page.getByRole("textbox", { name: "Layout name" }).fill("Three up");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "already exists" })).toBeVisible();
  });
});

test.describe("persistence", () => {
  test("each workspace keeps its own layout, restored when it is opened again", async ({ page }) => {
    await openCode(page);
    const first = await workspaceId(page);
    await page.keyboard.press("Control+Alt+d");
    const divider = separators(page).first();
    await divider.focus();
    await page.keyboard.press("Shift+ArrowRight");
    const ratio = await divider.getAttribute("aria-valuenow");
    await expect.poll(() => memory(page, (m) => m.layouts.saves())).toBeGreaterThan(0);

    await page.getByRole("button", { name: /^Workspace\s/ }).click();
    await page.getByRole("menuitemradio", { name: /api-server/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "api-server" })).toBeVisible();
    await expect(panes(page)).toHaveCount(1);

    await page.getByRole("button", { name: /^Workspace\s/ }).click();
    await page.getByRole("menuitemradio", { name: /kalcode-site/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
    await expect(panes(page)).toHaveCount(2);
    await expect(separators(page).first()).toHaveAttribute("aria-valuenow", ratio ?? "");
    const stored = await page.evaluate(
      (id) => (window as unknown as { __kalcodeMemory: Memory }).__kalcodeMemory.layouts.stored(id),
      first,
    );
    expect(JSON.stringify(stored)).toContain('"kind":"split"');
  });
});

test.describe("scale", () => {
  test("24 panes: every pane renders, offscreen views are suspended, processes keep running", async ({ page }) => {
    await openCode(page);
    const id = await workspaceId(page);
    const keys = await pane(page, 0)
      .getByRole("tab")
      .evaluateAll((tabs) => tabs.map((t) => t.getAttribute("data-content-key") ?? ""));
    const terminals = keys.map((k) => ({ kind: "terminal", terminalId: k.split(":")[1] }));
    const leaf = (n: number, tabs: unknown[] = []) => ({
      kind: "leaf",
      paneId: `p${n}`,
      tabs,
      activeTab: 0,
      collapsed: false,
    });
    const row = (start: number, withTabs: boolean) => ({
      kind: "split",
      axis: "horizontal",
      ratios: [167, 167, 167, 167, 166, 166],
      children: Array.from({ length: 6 }, (_, i) =>
        leaf(start + i, withTabs && i < terminals.length ? [terminals[i]] : []),
      ),
    });
    const layout = {
      schemaVersion: 1,
      root: {
        kind: "split",
        axis: "vertical",
        ratios: [250, 250, 250, 250],
        children: [row(0, true), row(6, false), row(12, false), row(18, false)],
      },
      maximizedPaneId: null,
      dock: [],
    };
    const running = await memory(page, (m) => m.runningProcessCount());
    // The default layout is saved first. Code stays mounted across pages, so the seed (a layout
    // from a previous run) is written while another workspace is open, and loads on switching back.
    await expect.poll(() => memory(page, (m) => m.layouts.saves())).toBeGreaterThan(0);
    await page.getByRole("button", { name: /^Workspace\s/ }).click();
    await page.getByRole("menuitemradio", { name: /api-server/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "api-server" })).toBeVisible();
    await page.evaluate(
      ([w, l]) => (window as unknown as { __kalcodeMemory: Memory }).__kalcodeMemory.layouts.seed(w as string, l),
      [id, layout] as const,
    );
    const started = Date.now();
    await page.getByRole("button", { name: /^Workspace\s/ }).click();
    await page.getByRole("menuitemradio", { name: /kalcode-site/ }).click();
    await expect(panes(page)).toHaveCount(24);
    expect(Date.now() - started).toBeLessThan(3000);
    // Only the terminals in front have a view; the one ended shell has none running.
    await expect(page.locator(".xterm")).toHaveCount(terminals.length);
    expect(await memory(page, (m) => m.runningProcessCount())).toBe(running);
    await expect(page.getByText("24 panes")).toBeVisible();
    // Maximizing one suspends the other views; restoring brings them back.
    await pane(page, 0).locator('[role="tab"]').first().click();
    await page.keyboard.press("Control+Alt+Enter");
    await expect(page.locator(".xterm:visible")).toHaveCount(1);
    await page.keyboard.press("Control+Alt+Enter");
    await expect(page.locator(".xterm:visible")).toHaveCount(terminals.length);
    expect(await memory(page, (m) => m.runningProcessCount())).toBe(running);
  });
});

test.describe("shell slot and command palette", () => {
  for (const width of [1366, 1920]) {
    test(`the KalVoice widget never covers the Code header at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 860 });
      await openCode(page);
      const widget = page.getByRole("region", { name: "KalVoice widget" });
      await expect(widget).toBeVisible();
      const w = await box(widget);
      const header = await box(page.getByRole("heading", { level: 1, name: "kalcode-site" }));
      const main = await box(page.locator("main"));
      expect(w.y + w.height).toBeLessThanOrEqual(main.y + 1);
      expect(w.y + w.height).toBeLessThanOrEqual(header.y);
    });
  }

  test("pane commands run from the command palette", async ({ page }) => {
    await openCode(page);
    await page.keyboard.press("Control+k");
    await page.keyboard.type("split pane right");
    await page.keyboard.press("Enter");
    await expect(panes(page)).toHaveCount(2);
    await page.keyboard.press("Control+k");
    await page.keyboard.type("4 panes");
    await page.keyboard.press("Enter");
    await expect(panes(page)).toHaveCount(4);
  });
});

test.describe("accessibility", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`panes pass axe in ${theme} theme: split, provider pane, collapsed, maximized, empty`, async ({ page }) => {
      await page.goto("/?scenario=code");
      // Choose Dashboard explicitly: a returning user is otherwise sent to Code after restore.
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "Dashboard", exact: true })
        .click();
      await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
      if (theme === "light") {
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Light" }).click();
      }
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "Code", exact: true })
        .click();
      await expect(canvas(page)).toBeVisible();
      await page.getByRole("button", { name: "New agent", exact: true }).click();
      await page
        .getByRole("dialog", { name: "New agent" })
        .getByRole("button", { name: "Launch Claude Code agent" })
        .click();
      await expect(page.locator("[data-provider-pane]")).toBeVisible();
      await page.keyboard.press("Control+Alt+Shift+D");
      await expect(panes(page)).toHaveCount(3);
      await expectNoSeriousA11yViolations(page);

      await pane(page, 0).getByRole("button", { name: "Actions for pane 1" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await expectNoSeriousA11yViolations(page);
      await page.getByRole("menuitem", { name: "Collapse" }).click();
      await expectNoSeriousA11yViolations(page);

      await pane(page, 1)
        .getByRole("button", { name: /^Maximize pane/ })
        .click();
      await expectNoSeriousA11yViolations(page);
    });
  }
});
