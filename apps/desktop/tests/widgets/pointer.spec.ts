import { expect, type Locator, type Page, test } from "@playwright/test";

async function grab(page: Page, handle: Locator) {
  await handle.evaluate((element) => {
    element.addEventListener(
      "gotpointercapture",
      (event) => {
        element.setAttribute("data-captured-pointer", String((event as PointerEvent).pointerId));
      },
      { once: true },
    );
  });
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error("Pointer handle not visible");
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 1, y + 1);
  await expect(handle).toHaveAttribute("data-captured-pointer", /\d+/);
  return { x, y };
}

async function releaseCapture(handle: Locator) {
  await handle.evaluate((element) => {
    const id = Number(element.getAttribute("data-captured-pointer"));
    if (!element.hasPointerCapture(id)) throw new Error("The browser did not capture the pointer");
    element.releasePointerCapture(id);
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("capture loss ends widget movement while the mouse button is still down", async ({ page }) => {
  const handle = page.getByRole("button", { name: "Move Activity fixture" });
  const frame = page.locator('[data-widget-id="pointer-fixture"]');
  const { x, y } = await grab(page, handle);
  await expect(frame).toHaveAttribute("data-dragging", "true");
  const moves = await page.getByTestId("moves").textContent();
  expect(Number(moves)).toBeGreaterThan(0);
  await releaseCapture(handle);
  await page.mouse.move(x + 2, y + 1);
  await expect(frame).not.toHaveAttribute("data-dragging");
  await expect(page.getByTestId("moves")).toHaveText(moves ?? "");
  await page.mouse.up();
});

test("capture loss ends resize and a later pointer drag still works", async ({ page }) => {
  const handle = page.getByRole("separator", { name: "Resize Activity fixture" });
  const frame = page.locator('[data-widget-id="pointer-fixture"]');
  const first = await grab(page, handle);
  await expect(frame).toHaveAttribute("data-resizing", "true");
  const height = await handle.getAttribute("aria-valuenow");
  await releaseCapture(handle);
  await page.mouse.move(first.x + 2, first.y + 2);
  await expect(frame).not.toHaveAttribute("data-resizing");
  await expect(handle).toHaveAttribute("aria-valuenow", height ?? "");
  await page.mouse.up();
  const next = await grab(page, handle);
  await page.mouse.move(next.x, next.y + 25);
  await expect(handle).toHaveAttribute("aria-valuenow", String(Number(height) + 25));
  await page.mouse.up();
  await expect(frame).not.toHaveAttribute("data-resizing");
});
