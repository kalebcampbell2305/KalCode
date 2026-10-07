import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Stack & items as the fast organization surface (owner directive 2026-10-06): inline rename,
 * drag to reorder and between groups, group reorder, a large target for empty groups, auto-scroll
 * on long lists, and persistence. Real pointer drags against the in-memory runtime.
 */

async function openCode(page: Page) {
  await page.goto("/?scenario=code");
  const heading = page.getByRole("heading", { level: 1, name: "kalcode-site" });
  if (!(await heading.isVisible())) {
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  }
  await expect(heading).toBeVisible();
}

const stack = (page: Page) => page.getByRole("complementary", { name: "Terminal stack" });

async function showStack(page: Page) {
  if (await stack(page).isVisible()) return;
  await page.getByRole("button", { name: /^Show the terminal stack/ }).click();
  await expect(stack(page)).toBeVisible();
}

async function newGroup(page: Page, name: string) {
  await stack(page).getByRole("button", { name: "New group" }).click();
  await stack(page).getByRole("textbox", { name: "Name of the New group group" }).fill(name);
  await page.keyboard.press("Enter");
  await expect(stack(page).getByRole("region", { name: `${name} group` })).toBeVisible();
}

const center = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not visible");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, top: box.y, height: box.height };
};

/** A real pointer drag: press, pass the movement threshold, travel, optionally shoot, release. */
async function drag(page: Page, from: Locator, to: Locator, options: { edge?: "top"; shot?: string } = {}) {
  const a = await center(from);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x, a.y + 8, { steps: 3 });
  const b = await center(to);
  await page.mouse.move(b.x, options.edge === "top" ? b.top + 3 : b.y, { steps: 10 });
  if (options.shot) await page.screenshot({ path: test.info().outputPath(options.shot) });
  await page.mouse.up();
}

const itemRow = (scope: Locator, name: RegExp) => scope.getByRole("button", { name });

test("stack items rename inline, reorder, move between groups, groups reorder, and it all persists", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCode(page);
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await showStack(page);
  await newGroup(page, "Website");
  const website = stack(page).getByRole("region", { name: "Website group" });
  await expect(website).toContainText("Empty. Drag items here.");

  // A. Double-click a name: it edits in place, Enter saves through the canonical rename.
  const terminals = stack(page).getByRole("region", { name: "Terminals group" });
  const first = terminals.getByRole("button", { name: /, terminal in Terminals/ }).first();
  await first.dblclick();
  const field = stack(page).getByRole("textbox", { name: /^Name of / });
  await expect(field).toBeFocused();
  await field.fill("Test PC");
  await page.keyboard.press("Enter");
  await expect(itemRow(terminals, /^Test PC, terminal/)).toBeVisible();
  // The same name shows on the real pane tab: the rename went through the terminal itself.
  await expect(page.getByRole("tab", { name: /Test PC/ }).first()).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // B. F2 renames the focused item; Escape cancels.
  const second = terminals.getByRole("button", { name: /, terminal in Terminals/ }).nth(1);
  const secondName = (await second.getAttribute("aria-label"))?.split(",")[0] ?? "";
  await second.focus();
  await page.keyboard.press("F2");
  await page.keyboard.type("Discard me");
  await page.keyboard.press("Escape");
  await expect(itemRow(terminals, new RegExp(`^${secondName.replace(/[()]/g, "\\$&")}, terminal`))).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("stack-rest.png") });

  // F. Drag into the empty Website group: a large labelled target, no tiny line to hit.
  await drag(page, itemRow(terminals, /^Test PC, terminal/), website, { shot: "drag-into-empty-group.png" });
  await expect(itemRow(website, /^Test PC, terminal in Website/)).toBeVisible();

  // D. Reorder inside a group: drop the last row on the top half of the first.
  const rows = terminals.getByRole("button", { name: /, terminal in Terminals/ });
  const before = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")?.split(",")[0]));
  await drag(page, rows.last(), rows.first(), { edge: "top", shot: "drag-reorder.png" });
  const after = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")?.split(",")[0]));
  expect(after).toEqual([before[before.length - 1], ...before.slice(0, -1)]);

  // G. Reorder groups: Website above Terminals.
  const headers = () =>
    stack(page)
      .getByRole("region")
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  await drag(
    page,
    website.getByRole("button", { name: /^Website/ }),
    terminals.getByRole("button", { name: /^Terminals/ }),
    {
      edge: "top",
      shot: "drag-group.png",
    },
  );
  const order = await headers();
  expect(order.indexOf("Website group")).toBeLessThan(order.indexOf("Terminals group"));

  // C. Rename a group by double-clicking its name.
  await website
    .getByRole("button", { name: /^Website/ })
    .locator("[data-group-name]")
    .dblclick();
  await stack(page).getByRole("textbox", { name: "Name of the Website group" }).fill("Site");
  await page.keyboard.press("Enter");
  const site = stack(page).getByRole("region", { name: "Site group" });
  await expect(site).toBeVisible();

  // H. Collapse a group.
  await site.getByRole("button", { name: /^Site/ }).click();
  await expect(site.getByRole("button", { name: /^Site/ })).toHaveAttribute("aria-expanded", "false");

  // Dragging onto a collapsed group still moves the item into it.
  await drag(page, rows.first(), site.getByRole("button", { name: /^Site/ }), { shot: "drag-collapsed.png" });
  await expect(site.getByRole("button", { name: /^Site/ })).toHaveAttribute("aria-expanded", "true");
  await expect(site.getByRole("button", { name: /, terminal in Site/ })).toHaveCount(2);
  await site.getByRole("button", { name: /^Site/ }).click();

  // J. Leaving the workspace and coming back restores everything exactly.
  const settled = await headers();
  await page.getByRole("heading", { level: 1, name: "kalcode-site" }).getByRole("button").click();
  await page.getByRole("menuitemradio", { name: /api-server/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "api-server" })).toBeVisible();
  await page.getByRole("heading", { level: 1, name: "api-server" }).getByRole("button").click();
  await page.getByRole("menuitemradio", { name: /kalcode-site/ }).click();
  await expect(stack(page)).toBeVisible();
  expect(await headers()).toEqual(settled);
  await expect(site.getByRole("button", { name: /^Site/ })).toHaveAttribute("aria-expanded", "false");
  await site.getByRole("button", { name: /^Site/ }).click();
  await expect(itemRow(site, /^Test PC, terminal in Site/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("stack-arranged.png") });
});

test("a long stack auto-scrolls while dragging, and drops land where the line says", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await openCode(page);
  for (let i = 0; i < 24; i++) await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await showStack(page);
  await newGroup(page, "Release");
  const release = stack(page).getByRole("region", { name: "Release group" });
  const body = stack(page).locator("[data-drop-group]").first().locator("xpath=..");
  const scrollTop = () => body.evaluate((el) => el.scrollTop);
  await body.evaluate((el) => {
    el.scrollTop = 0;
  });
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  const source = stack(page)
    .getByRole("button", { name: /, terminal in Terminals/ })
    .first();
  const label = (await source.getAttribute("aria-label"))?.split(",")[0] ?? "";
  const a = await center(source);
  const box = await body.boundingBox();
  if (!box) throw new Error("no stack body");
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x, a.y + 10, { steps: 3 });
  // Hold near the bottom edge: the list scrolls by itself until the Release group is reachable.
  await page.mouse.move(a.x, box.y + box.height - 8, { steps: 8 });
  await expect.poll(scrollTop, { timeout: 5000 }).toBeGreaterThan(200);
  await expect(release.getByText("Move to Release")).toBeInViewport({ timeout: 8000 });
  await page.screenshot({ path: test.info().outputPath("autoscroll.png") });
  const zone = await center(release.getByText("Move to Release"));
  await page.mouse.move(zone.x, zone.y, { steps: 6 });
  await page.mouse.up();
  await expect(
    release.getByRole("button", { name: new RegExp(`^${label.replace(/[()]/g, "\\$&")}, terminal in Release`) }),
  ).toBeVisible();
});
