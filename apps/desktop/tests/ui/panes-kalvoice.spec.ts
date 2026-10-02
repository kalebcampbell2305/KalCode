import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * KalVoice pane intents (Z7-21) against the in-memory runtime: typed requests to KalVoice split,
 * resize and close panes on the Code canvas and arrange provider panes side by side. Layout only:
 * nothing starts or stops (the fake process count never changes).
 */

const panes = (page: Page) => page.locator("[data-pane-id]:not([hidden])");
const pane = (page: Page, n: number) => panes(page).nth(n);

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not visible");
  return b;
}

const running = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __kalcodeMemory: { runningProcessCount: () => number } }
    ).__kalcodeMemory.runningProcessCount(),
  );

async function openCode(page: Page) {
  await page.goto("/?scenario=code");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
  await expect(panes(page)).toHaveCount(1);
}

/** Types a request to KalVoice on its page; the result brings the person back to Code. */
async function ask(page: Page, text: string) {
  await page.getByRole("button", { name: "KalVoice", exact: true }).click();
  const box = page.getByRole("main").getByRole("textbox", { name: "Type a request for KalVoice" });
  await box.fill(text);
  await box.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "kalcode-site" })).toBeVisible();
}

test.describe("KalVoice pane intents", () => {
  test("split, make bigger, split top and bottom; close ends the shells in the closed pane", async ({ page }) => {
    await openCode(page);
    const processes = await running(page);

    await ask(page, "Split the pane side by side");
    await expect(panes(page)).toHaveCount(2);
    const left = await box(pane(page, 0));
    const right = await box(pane(page, 1));
    expect(right.x).toBeGreaterThan(left.x + left.width - 1);
    await expect(page.getByRole("separator").first()).toHaveAttribute("aria-valuenow", "50");

    // Splitting focuses the new pane, and Code keeps that focus while KalVoice's page is shown, so
    // "this pane" is the new (right) one: it grows, moving the divider left.
    await ask(page, "make this pane bigger");
    await expect
      .poll(async () => Number(await page.getByRole("separator").first().getAttribute("aria-valuenow")))
      .toBeLessThan(50);

    await ask(page, "split the pane top and bottom");
    await expect(panes(page)).toHaveCount(3);
    const boxes = await Promise.all([0, 1, 2].map((i) => box(pane(page, i))));
    // The focused (right) pane now holds two panes, one below the other.
    const stacked = boxes.some((a) => boxes.some((b) => Math.abs(a.x - b.x) < 2 && b.y > a.y + 20));
    expect(stacked).toBe(true);

    // Splitting and resizing never stop anything; closing a pane ends the terminals it held.
    expect(await running(page)).toBe(processes);
    // Live terminal tabs per pane (an exited shell's tab reads "Ended").
    const tabsByPane = async () =>
      new Map(
        await page
          .locator("[data-pane-id]")
          .evaluateAll((els) =>
            els.map(
              (el) =>
                [
                  el.getAttribute("data-pane-id") ?? "",
                  [...el.querySelectorAll('[role="tab"]')].filter((t) => !/Ended/.test(t.textContent ?? "")).length,
                ] as const,
            ),
          ),
      );
    const before = await tabsByPane();
    await ask(page, "close this pane");
    await expect(panes(page)).toHaveCount(2);
    const after = await tabsByPane();
    const closed = [...before].filter(([id]) => !after.has(id));
    expect(closed).toHaveLength(1);
    await expect.poll(() => running(page)).toBe(processes - (closed[0]?.[1] ?? 0));
  });

  test("arranging Claude Code and Codex says honestly that Codex has no pane yet", async ({ page }) => {
    await openCode(page);
    await page.getByRole("button", { name: "New Claude Code pane" }).click();
    await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
    const processes = await running(page);

    await ask(page, "put claude code and codex side by side");
    await expect(page.getByText("No pane yet for codex", { exact: false })).toBeVisible();
    await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
    expect(await running(page)).toBe(processes);
  });
});
